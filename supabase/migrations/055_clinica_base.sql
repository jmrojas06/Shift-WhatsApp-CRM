-- ============================================================
-- 055_clinica_base.sql — módulo clínica: pacientes y autorizaciones
-- ============================================================
--
-- Diseño: docs/superpowers/specs/2026-11-02-odontologia-design.md
--
--   1. clinic_settings: autorización, urgencias y días que ofrece el bot.
--   2. clinic_locations: sedes. Con la Agenda de Shift hay una sola fila.
--   3. clinic_patients: un contacto (número) tiene uno o varios pacientes.
--   4. clinic_consents: registro de autorizaciones, solo para agregar.
--   5. booking_appointments: paciente y sede de la cita.
--   6. booking_services: instrucciones previas y cuidados.
--   7. conversations.bot_lock_until: candado por conversación.
--
-- RLS (patrón 017/050): los miembros leen, owner/admin escriben la
-- configuración, un agent o más escribe pacientes y nadie escribe
-- autorizaciones desde el navegador (las escribe el bot con service role).
--
-- Aplicar ANTES de desplegar el código. Es ADITIVA y NO destructiva: solo
-- crea tablas, columnas y políticas. Idempotente: se puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de una tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) clinic_settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- El cuerpo de un mensaje interactivo admite 1024 unidades UTF-16.
  consent_text text NOT NULL CHECK (char_length(consent_text) BETWEEN 1 AND 900),
  consent_version integer NOT NULL DEFAULT 1 CHECK (consent_version >= 1),
  -- La clínica declara que obtiene el permiso en recepción (ver spec §6.6).
  reception_consent_declared_at timestamptz,
  urgency_words text[] NOT NULL DEFAULT '{}',
  urgency_alarm_text text NOT NULL CHECK (char_length(urgency_alarm_text) BETWEEN 1 AND 900),
  urgency_service_id uuid REFERENCES booking_services(id) ON DELETE SET NULL,
  offer_days integer NOT NULL DEFAULT 30 CHECK (offer_days BETWEEN 1 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2) clinic_locations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  address text CHECK (address IS NULL OR char_length(address) <= 200),
  latitude numeric(9,6),
  longitude numeric(9,6),
  notice_phone text CHECK (notice_phone IS NULL OR char_length(notice_phone) <= 30),
  on_call_phone text CHECK (on_call_phone IS NULL OR char_length(on_call_phone) <= 30),
  google_review_url text CHECK (google_review_url IS NULL OR char_length(google_review_url) <= 500),
  chair_count integer CHECK (chair_count IS NULL OR chair_count > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_locations_account
  ON clinic_locations (account_id);

-- ------------------------------------------------------------
-- 3) clinic_patients
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_source text,
  external_id text,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120),
  intake_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_patients_contact
  ON clinic_patients (account_id, contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_external
  ON clinic_patients (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4) clinic_consents — solo para agregar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('datos_sensibles', 'mercadeo')),
  granted boolean NOT NULL,
  text_version integer NOT NULL CHECK (text_version >= 1),
  source text NOT NULL CHECK (source IN ('whatsapp', 'recepcion')),
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_consents_lookup
  ON clinic_consents (account_id, contact_id, kind, created_at DESC);

-- ------------------------------------------------------------
-- 5) y 6) Columnas de citas y servicios
-- ------------------------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS patient_id uuid REFERENCES clinic_patients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES clinic_locations(id) ON DELETE SET NULL;

ALTER TABLE booking_services
  ADD COLUMN IF NOT EXISTS prep_instructions text,
  ADD COLUMN IF NOT EXISTS aftercare_instructions text;

ALTER TABLE booking_services
  DROP CONSTRAINT IF EXISTS booking_services_prep_length_check;
ALTER TABLE booking_services
  ADD CONSTRAINT booking_services_prep_length_check
  CHECK (prep_instructions IS NULL OR char_length(prep_instructions) <= 900);

ALTER TABLE booking_services
  DROP CONSTRAINT IF EXISTS booking_services_aftercare_length_check;
ALTER TABLE booking_services
  ADD CONSTRAINT booking_services_aftercare_length_check
  CHECK (aftercare_instructions IS NULL OR char_length(aftercare_instructions) <= 900);

-- ------------------------------------------------------------
-- 7) Candado por conversación
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS bot_lock_until timestamptz;

-- ------------------------------------------------------------
-- updated_at (helper de 001)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON clinic_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON clinic_locations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON clinic_patients;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clinic_patients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_settings_select ON clinic_settings;
CREATE POLICY clinic_settings_select ON clinic_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_settings_insert ON clinic_settings;
CREATE POLICY clinic_settings_insert ON clinic_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_settings_update ON clinic_settings;
CREATE POLICY clinic_settings_update ON clinic_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_settings_delete ON clinic_settings;
CREATE POLICY clinic_settings_delete ON clinic_settings
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS clinic_locations_select ON clinic_locations;
CREATE POLICY clinic_locations_select ON clinic_locations
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_locations_insert ON clinic_locations;
CREATE POLICY clinic_locations_insert ON clinic_locations
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_locations_update ON clinic_locations;
CREATE POLICY clinic_locations_update ON clinic_locations
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS clinic_locations_delete ON clinic_locations;
CREATE POLICY clinic_locations_delete ON clinic_locations
  FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS clinic_patients_select ON clinic_patients;
CREATE POLICY clinic_patients_select ON clinic_patients
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_patients_insert ON clinic_patients;
CREATE POLICY clinic_patients_insert ON clinic_patients
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS clinic_patients_update ON clinic_patients;
CREATE POLICY clinic_patients_update ON clinic_patients
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
-- Sin política DELETE: un paciente con citas es un registro del negocio.

DROP POLICY IF EXISTS clinic_consents_select ON clinic_consents;
CREATE POLICY clinic_consents_select ON clinic_consents
  FOR SELECT USING (is_account_member(account_id));
-- Sin INSERT/UPDATE/DELETE: el registro solo lo escribe el bot (service
-- role) y nadie lo edita desde el navegador.
