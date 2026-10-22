-- ============================================================
-- 051_agenda_armable.sql — la agenda sirve a cualquier negocio
-- ============================================================
--
-- Aplicar ANTES de desplegar el código de la agenda.
--
-- Parte ADITIVA del cambio (la reescritura de la clave del vertical va
-- aparte, en 052, y se aplica DESPUÉS del despliegue):
--
--   1. booking_settings: punto de partida, palabras y las 5 piezas.
--   2. Backfill: las cuentas que TODAVÍA tienen vertical_key =
--      'barberia' reciben el punto de partida 'barberia' y su
--      vocabulario de siempre (barbero / barberos).
--   3. booking_questions: preguntas extra del bot (RLS 050: miembros
--      leen, owner/admin escriben).
--   4. booking_appointments.answers: respuestas a esas preguntas.
--
-- Es segura con el código viejo en producción: el código viejo no lee
-- estas columnas ni la tabla nueva, y no cambia ninguna clave de
-- vertical (accounts no se toca). El código nuevo SÍ las lee, por eso
-- esta migración va primero.
--
-- El backfill se filtra por `vertical_key = 'barberia'` (cuentas que
-- aún tienen la clave vieja). Como 052 reescribe esa clave después,
-- volver a correr 051 más tarde no le pega vocabulario de barbería a
-- cuentas 'agenda' de otros negocios (salón, taller…).
--
-- NO destructiva: no borra tablas, columnas ni filas. Solo agrega
-- columnas/tabla. Idempotente: se puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de la tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) booking_settings: punto de partida, palabras y piezas
-- ------------------------------------------------------------
ALTER TABLE booking_settings
  ADD COLUMN IF NOT EXISTS preset_key text,
  ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS choose_staff boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_price boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_duration boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_reschedule boolean NOT NULL DEFAULT true;

ALTER TABLE booking_settings
  DROP CONSTRAINT IF EXISTS booking_settings_labels_object_check;
ALTER TABLE booking_settings
  ADD CONSTRAINT booking_settings_labels_object_check
  CHECK (jsonb_typeof(labels) = 'object');

ALTER TABLE booking_settings
  DROP CONSTRAINT IF EXISTS booking_settings_preset_key_check;
ALTER TABLE booking_settings
  ADD CONSTRAINT booking_settings_preset_key_check
  CHECK (preset_key IS NULL OR preset_key ~ '^[a-z0-9_-]{1,40}$');

-- ------------------------------------------------------------
-- 2) Backfill de las cuentas de barbería (aún con la clave vieja)
-- ------------------------------------------------------------
-- Se asegura la fila de settings y se les da su vocabulario de siempre.
-- Filtra por 'barberia', NO por 'agenda': ver el encabezado.
INSERT INTO booking_settings (account_id)
SELECT id FROM accounts WHERE vertical_key = 'barberia'
ON CONFLICT (account_id) DO NOTHING;

UPDATE booking_settings bs
SET preset_key = 'barberia',
    labels = '{"profesional":"barbero","profesionales":"barberos"}'::jsonb
FROM accounts a
WHERE a.id = bs.account_id
  AND a.vertical_key = 'barberia'
  AND bs.preset_key IS NULL;

-- ------------------------------------------------------------
-- 3) Preguntas extra del bot
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('texto', 'direccion', 'numero', 'opcion')),
  required boolean NOT NULL DEFAULT true,
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Límites que la app también exige (2–10 opciones, posición >= 0).
-- Con nombre y DROP + ADD para que sean idempotentes.
ALTER TABLE booking_questions
  DROP CONSTRAINT IF EXISTS booking_questions_position_check;
ALTER TABLE booking_questions
  ADD CONSTRAINT booking_questions_position_check
  CHECK (position >= 0);

ALTER TABLE booking_questions
  DROP CONSTRAINT IF EXISTS booking_questions_options_max_check;
ALTER TABLE booking_questions
  ADD CONSTRAINT booking_questions_options_max_check
  CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 10);

ALTER TABLE booking_questions
  DROP CONSTRAINT IF EXISTS booking_questions_opcion_options_check;
ALTER TABLE booking_questions
  ADD CONSTRAINT booking_questions_opcion_options_check
  CHECK (kind <> 'opcion' OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 10));

CREATE INDEX IF NOT EXISTS idx_booking_questions_account_position
  ON booking_questions (account_id, position);

-- RLS (patrón de 050): cualquier miembro lee; owner/admin escriben.
ALTER TABLE booking_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_questions_select ON booking_questions;
CREATE POLICY booking_questions_select ON booking_questions
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS booking_questions_insert ON booking_questions;
CREATE POLICY booking_questions_insert ON booking_questions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS booking_questions_update ON booking_questions;
CREATE POLICY booking_questions_update ON booking_questions
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS booking_questions_delete ON booking_questions;
CREATE POLICY booking_questions_delete ON booking_questions
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON booking_questions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_questions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 4) Respuestas en la cita
-- ------------------------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS answers jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_answers_object_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_answers_object_check
  CHECK (jsonb_typeof(answers) = 'object');

-- Tope de tamaño: las respuestas las escribe el bot con texto libre del
-- cliente; sin tope, una fila podría crecer sin límite.
ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_answers_size_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_answers_size_check
  CHECK (pg_column_size(answers) <= 8192);
