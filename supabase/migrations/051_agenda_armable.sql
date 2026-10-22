-- ============================================================
-- 051_agenda_armable.sql — la agenda sirve a cualquier negocio
-- ============================================================
--
--   1. accounts.vertical_key 'barberia' → 'agenda' (el código acepta
--      ambas mientras convive; ver AGENDA_VERTICAL_KEYS).
--   2. booking_settings: punto de partida, palabras y las 5 piezas.
--      Las cuentas que ya eran barbería conservan su vocabulario.
--   3. booking_questions: preguntas extra del bot (RLS 050: miembros
--      leen, owner/admin escriben).
--   4. booking_appointments.answers: respuestas a esas preguntas.
--
-- NO destructiva: no borra tablas, columnas ni filas. Solo reescribe
-- la clave del vertical y agrega columnas/tabla. Idempotente: se puede
-- correr de nuevo.
--
-- Orden de despliegue: PRIMERO el código (acepta las dos claves),
-- DESPUÉS esta migración.
--
-- El UPDATE de accounts.vertical_key (paso 1) corre como postgres (SQL
-- Editor / CLI), así que no lo frena el trigger de 050
-- (enforce_account_protected_columns), que solo bloquea cuando
-- current_user es `authenticated` o `anon`.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Clave del vertical
-- ------------------------------------------------------------
UPDATE accounts SET vertical_key = 'agenda' WHERE vertical_key = 'barberia';

-- ------------------------------------------------------------
-- 2) Configuración: punto de partida, palabras y piezas
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

-- Cuentas de barbería existentes: mismo vocabulario de siempre. Se
-- asegura la fila de settings y solo se tocan las que aún no tienen
-- punto de partida (re-correr la migración no pisa lo que el negocio
-- cambió después).
INSERT INTO booking_settings (account_id)
SELECT id FROM accounts WHERE vertical_key = 'agenda'
ON CONFLICT (account_id) DO NOTHING;

UPDATE booking_settings bs
SET preset_key = 'barberia',
    labels = '{"profesional":"barbero","profesionales":"barberos"}'::jsonb
FROM accounts a
WHERE a.id = bs.account_id
  AND a.vertical_key = 'agenda'
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
