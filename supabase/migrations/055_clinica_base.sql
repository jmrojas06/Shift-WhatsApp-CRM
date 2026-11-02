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
-- Reglas de datos:
--   - Nada cruza cuentas: pacientes y sedes llevan UNIQUE (account_id, id)
--     y las citas las enlazan con FK compuestas. Las demás referencias
--     entre cuentas (contacto del paciente, servicio de urgencias) las
--     cierra la política de escritura, como 054 con orders.deal_id.
--   - Un contacto con paciente NO se puede borrar (clinic_patients.contact_id
--     no tiene cascada: error 23503). Borrar una cuenta sí funciona: sus
--     contactos y sus pacientes se borran en la misma sentencia, y la
--     comprobación NO ACTION corre al final, cuando ya no queda ninguno.
--   - Las autorizaciones sobreviven al contacto: contact_id pasa a NULL y
--     la fila conserva contact_ref (quién autorizó) y text_snapshot (qué
--     texto aceptó). contacts.phone es NOT NULL pero vale '' si el contacto
--     solo tiene identificador de WhatsApp (040): contact_ref guarda el
--     teléfono, o wa_user_id si no hay teléfono.
--   - clinic_consents es de solo agregar: un trigger rechaza UPDATE y
--     DELETE directos (las acciones de FK pasan) y se revoca TRUNCATE.
--
-- REQUIERE Postgres 15 o más: las FK compuestas usan
-- ON DELETE SET NULL (columna). Con una versión menor, ese ALTER falla y,
-- como el script corre en una sola transacción, no queda nada a medias.
--
-- Aplicar ANTES de desplegar el código. Es ADITIVA y NO destructiva: solo
-- crea tablas, columnas, restricciones y políticas. Idempotente: se puede
-- correr de nuevo.
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
  -- La política de escritura exige además que sea de la misma cuenta.
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
  external_source text,
  external_id text,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND btrim(name) <> ''),
  address text CHECK (address IS NULL OR char_length(address) <= 200),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  notice_phone text CHECK (notice_phone IS NULL OR char_length(notice_phone) <= 30),
  on_call_phone text CHECK (on_call_phone IS NULL OR char_length(on_call_phone) <= 30),
  google_review_url text CHECK (google_review_url IS NULL OR char_length(google_review_url) <= 500),
  chair_count integer CHECK (chair_count IS NULL OR chair_count > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- La fuente y el id externos van juntos o ninguno.
  CHECK ((external_source IS NULL) = (external_id IS NULL)),
  -- Lo necesita la FK compuesta de booking_appointments.
  UNIQUE (account_id, id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_locations_account
  ON clinic_locations (account_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_locations_external
  ON clinic_locations (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3) clinic_patients
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Sin ON DELETE a propósito (NO ACTION, el valor por defecto): un contacto
  -- con paciente no se borra (error 23503).
  contact_id uuid NOT NULL REFERENCES contacts(id),
  external_source text,
  external_id text,
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 120 AND btrim(full_name) <> ''),
  intake_completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- La fuente y el id externos van juntos o ninguno.
  CHECK ((external_source IS NULL) = (external_id IS NULL)),
  -- Lo necesita la FK compuesta de booking_appointments.
  UNIQUE (account_id, id)
);

-- La FK busca por contact_id al borrar un contacto (no por account_id).
CREATE INDEX IF NOT EXISTS idx_clinic_patients_contact
  ON clinic_patients (contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_patients_external
  ON clinic_patients (account_id, external_source, external_id)
  WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4) clinic_consents — solo para agregar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- La autorización sobrevive al contacto: al borrarlo queda en NULL y
  -- contact_ref sigue diciendo quién autorizó.
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Teléfono (o wa_user_id si no hay teléfono) del titular al autorizar.
  contact_ref text NOT NULL CHECK (char_length(contact_ref) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN ('datos_sensibles', 'mercadeo')),
  granted boolean NOT NULL,
  text_version integer NOT NULL CHECK (text_version >= 1),
  -- El texto exacto que vio la persona: cambiar clinic_settings.consent_text
  -- no puede borrar qué aceptó cada una.
  text_snapshot text NOT NULL CHECK (char_length(text_snapshot) BETWEEN 1 AND 1000),
  source text NOT NULL CHECK (source IN ('whatsapp', 'recepcion')),
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_consents_lookup
  ON clinic_consents (account_id, contact_id, kind, created_at DESC);

-- La FK busca por contact_id al borrar un contacto. Parcial: contact_id es
-- anulable y las filas huérfanas no se buscan por contacto.
CREATE INDEX IF NOT EXISTS idx_clinic_consents_contact
  ON clinic_consents (contact_id)
  WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5) y 6) Columnas de citas y servicios
-- ------------------------------------------------------------
-- Sin FK simple: la FK compuesta de abajo obliga a que el paciente y la
-- sede sean de la misma cuenta que la cita.
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS patient_id uuid,
  ADD COLUMN IF NOT EXISTS location_id uuid;

-- MATCH SIMPLE (por defecto): con patient_id NULL no se comprueba nada.
-- ON DELETE SET NULL (columna) solo pone en NULL esa columna y deja intacto
-- account_id, que es NOT NULL. Pide Postgres 15 o más.
ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_patient_fk;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_patient_fk
  FOREIGN KEY (account_id, patient_id)
  REFERENCES clinic_patients (account_id, id)
  ON DELETE SET NULL (patient_id);

ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_location_fk;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_location_fk
  FOREIGN KEY (account_id, location_id)
  REFERENCES clinic_locations (account_id, id)
  ON DELETE SET NULL (location_id);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_patient
  ON booking_appointments (patient_id)
  WHERE patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booking_appointments_location
  ON booking_appointments (location_id)
  WHERE location_id IS NOT NULL;

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
-- clinic_consents: solo para agregar de verdad
-- ------------------------------------------------------------
-- Sin política UPDATE/DELETE el navegador ya no puede tocarla, pero el
-- bot (service role, que se salta la RLS) sí podría. Este trigger rechaza
-- cualquier UPDATE o DELETE directo, venga de quien venga.
--
-- Las acciones de FK pasan: borrar un contacto pone contact_id en NULL y
-- borrar una cuenta borra sus filas. Postgres las ejecuta dentro de un
-- trigger propio, así que aquí corren a profundidad 2 o más; una edición
-- directa corre a profundidad 1.
--
-- SECURITY DEFINER + EXECUTE solo para service_role: mismo endurecimiento
-- que log_booking_appointment_event (047, patrón de 044). Al disparar el
-- trigger, Postgres no mira el permiso EXECUTE de quien escribe.
CREATE OR REPLACE FUNCTION clinic_consents_append_only()
RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'clinic_consents es de solo agregar: % no permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER FUNCTION public.clinic_consents_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clinic_consents_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clinic_consents_append_only() TO service_role;

DROP TRIGGER IF EXISTS clinic_consents_append_only ON clinic_consents;
CREATE TRIGGER clinic_consents_append_only
  BEFORE UPDATE OR DELETE ON clinic_consents
  FOR EACH ROW EXECUTE FUNCTION clinic_consents_append_only();

-- TRUNCATE no dispara triggers de fila: se le quita a los roles de la API.
REVOKE TRUNCATE ON clinic_consents FROM anon, authenticated, service_role;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_consents ENABLE ROW LEVEL SECURITY;

-- El servicio de urgencias debe ser de la misma cuenta: la FK sola no lo
-- comprueba (mismo criterio que 054 con orders.deal_id).
DROP POLICY IF EXISTS clinic_settings_select ON clinic_settings;
CREATE POLICY clinic_settings_select ON clinic_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_settings_insert ON clinic_settings;
CREATE POLICY clinic_settings_insert ON clinic_settings
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'admin')
    AND (
      urgency_service_id IS NULL
      OR EXISTS (
        SELECT 1 FROM booking_services s
        WHERE s.id = clinic_settings.urgency_service_id
          AND s.account_id = clinic_settings.account_id
      )
    )
  );
DROP POLICY IF EXISTS clinic_settings_update ON clinic_settings;
CREATE POLICY clinic_settings_update ON clinic_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND (
      urgency_service_id IS NULL
      OR EXISTS (
        SELECT 1 FROM booking_services s
        WHERE s.id = clinic_settings.urgency_service_id
          AND s.account_id = clinic_settings.account_id
      )
    )
  );
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

-- El contacto del paciente debe ser de la misma cuenta: la FK sola no lo
-- comprueba.
DROP POLICY IF EXISTS clinic_patients_select ON clinic_patients;
CREATE POLICY clinic_patients_select ON clinic_patients
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS clinic_patients_insert ON clinic_patients;
CREATE POLICY clinic_patients_insert ON clinic_patients
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = clinic_patients.contact_id
        AND c.account_id = clinic_patients.account_id
    )
  );
DROP POLICY IF EXISTS clinic_patients_update ON clinic_patients;
CREATE POLICY clinic_patients_update ON clinic_patients
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = clinic_patients.contact_id
        AND c.account_id = clinic_patients.account_id
    )
  );
-- Sin política DELETE: un paciente con citas es un registro del negocio.

DROP POLICY IF EXISTS clinic_consents_select ON clinic_consents;
CREATE POLICY clinic_consents_select ON clinic_consents
  FOR SELECT USING (is_account_member(account_id));
-- Sin INSERT/UPDATE/DELETE: el registro solo lo escribe el bot (service
-- role) y nadie lo edita desde el navegador.
