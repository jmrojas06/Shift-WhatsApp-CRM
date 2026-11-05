-- ============================================================
-- 056_clinica_recepcion_seguimientos.sql — Fases 2 y 3 de la clínica
-- ============================================================
--
-- Diseño: docs/superpowers/specs/2026-11-05-clinica-fases-2-3-design.md
--
--   1. booking_appointments: confirmación del paciente (attendance_confirmed_at),
--      copia a Google Calendar (google_*) y el trigger mark_booking_google_dirty.
--      También un set_updated_at propio de las citas (la sincronización con
--      Google no mueve updated_at), UNIQUE (account_id, id) para las FK
--      compuestas de abajo y created_via / actor con el valor 'dashboard'
--      (citas hechas desde el panel).
--   2. booking_staff.google_calendar_id: calendario de Google del profesional.
--   3. agenda_calendar_connections: la conexión con Google (token cifrado).
--   4. booking_call_settings: configuración de las llamadas por pasos (§6.4).
--   5. booking_calls: registro de llamadas, del robot y a mano (§6.4).
--   6. clinic_followups, clinic_ratings, clinic_day_closes: después de la cita (§7).
--   7. clinic_settings.followups_enabled: el interruptor por cuenta de los
--      seguimientos (§7). Nace apagado: se prende a mano, cuenta por cuenta, cuando
--      Meta aprobó las tres plantillas.
--
-- RLS (patrón 017/050/055): los miembros leen; owner/admin escriben la
-- configuración de llamadas; un agent o más anota llamadas a mano (solo
-- manual y saliente). Todo lo demás lo escribe el servidor con service role:
--   - agenda_calendar_connections tiene la RLS prendida SIN ninguna política y
--     se le quitan los permisos a anon y authenticated: el token cifrado solo
--     lo lee el servidor, y el panel ve el estado por una ruta API que nunca lo
--     devuelve. Al desconectar se borra la fila (el token no puede ser NULL).
--   - clinic_followups, clinic_ratings, clinic_day_closes y las llamadas del
--     robot no tienen política de escritura para el navegador.
--   - booking_call_settings: el admin escribe la configuración, pero NO las
--     cuatro columnas que controla Shift (provider, monthly_limit,
--     inbound_number y caller_id): un trigger (patrón de 050 sobre accounts)
--     lo rechaza con 42501 si escribe authenticated o anon. Esas las fija Shift
--     con service role.
--   - A las seis tablas nuevas se les quita TRUNCATE para anon y authenticated
--     (TRUNCATE salta la RLS y los triggers de fila).
--
-- Reglas de datos:
--   - Nada cruza cuentas: las llamadas, los seguimientos y las calificaciones
--     enlazan la cita (y la sede o el seguimiento) con FK compuestas
--     (account_id, id). Como booking_appointments no tenía UNIQUE
--     (account_id, id), se crea aquí. El contacto se enlaza con FK simple, como
--     en 055: el navegador solo puede escribir llamadas manuales y su política
--     comprueba que el contacto sea de la misma cuenta.
--   - Borrar una cita borra sus llamadas y sus seguimientos, pero las
--     calificaciones sobreviven: appointment_id, followup_id, contact_id y
--     location_id pasan a NULL.
--   - Las plantillas y las reglas de negocio (festivos, ventanas, topes) viven
--     en el código; aquí solo van los límites de valores y de largo.
--
-- REQUIERE Postgres 15 o más: las FK compuestas usan ON DELETE SET NULL
-- (columna), igual que 055. Aplicar DESPUÉS de 055 y ANTES de desplegar el
-- código. Es ADITIVA y NO destructiva: solo crea tablas, columnas,
-- restricciones, índices, políticas y triggers; lo único que cambia de lo ya
-- existente es que dos CHECK de 047 (created_via y actor) aceptan además
-- 'dashboard' y que el set_updated_at de booking_appointments (047) pasa a ser
-- uno propio de las citas y que clinic_settings gana la columna
-- followups_enabled (false para todas las cuentas que ya existen). Idempotente: se
-- puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de una tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) booking_appointments
-- ------------------------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS attendance_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS google_calendar_id text,
  ADD COLUMN IF NOT EXISTS google_dirty boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS google_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS google_sync_error text;

ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_google_calendar_id_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_google_calendar_id_check
  CHECK (google_calendar_id IS NULL OR char_length(google_calendar_id) <= 300);

ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_google_sync_error_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_google_sync_error_check
  CHECK (google_sync_error IS NULL OR char_length(google_sync_error) <= 300);

-- Lo necesitan las FK compuestas (account_id, appointment_id) de abajo. Un
-- índice único primero y luego la restricción sobre ese índice: así se puede
-- repetir sin intentar borrar una restricción de la que ya dependen las FK.
CREATE UNIQUE INDEX IF NOT EXISTS booking_appointments_account_id_id_key
  ON booking_appointments (account_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.booking_appointments'::regclass
      AND conname = 'booking_appointments_account_id_id_key'
  ) THEN
    ALTER TABLE booking_appointments
      ADD CONSTRAINT booking_appointments_account_id_id_key
      UNIQUE USING INDEX booking_appointments_account_id_id_key;
  END IF;
END $$;

-- Las citas hechas desde el panel llevan created_via = 'dashboard' y 047
-- solo aceptaba bot, agent y api. El trigger de auditoría copia created_via
-- a booking_events.actor, así que ese CHECK también lo acepta.
ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_created_via_check;
ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_created_via_check
  CHECK (created_via IN ('bot', 'agent', 'api', 'dashboard'));

ALTER TABLE booking_events
  DROP CONSTRAINT IF EXISTS booking_events_actor_check;
ALTER TABLE booking_events
  ADD CONSTRAINT booking_events_actor_check
  CHECK (actor IN ('bot', 'agent', 'api', 'dashboard', 'system'));

-- Lo que Google tiene que reflejar: el runner toma las citas sucias de una
-- cuenta (hasta 50 por corrida).
CREATE INDEX IF NOT EXISTS idx_booking_appointments_google_dirty
  ON booking_appointments (account_id)
  WHERE google_dirty;

-- ------------------------------------------------------------
-- google_dirty: se prende solo cuando cambia algo que Google muestra
-- ------------------------------------------------------------
-- En INSERT, o si cambian starts_at, ends_at, status, staff_id, service_id,
-- contact_id, patient_id, location_id o notes. Un UPDATE que solo toca las
-- columnas google_* (o recordatorios, updated_at, etc.) NO lo prende: así la
-- sincronización no se dispara a sí misma. Si cambia algo de lo que se vigila,
-- queda en true aunque el mismo UPDATE intente ponerlo en false: la cita
-- cambió y Google tiene que enterarse otra vez.
--
-- Corre como quien escribe (sin SECURITY DEFINER): solo toca NEW. Se
-- endurece como 047/055 (dueña postgres, sin EXECUTE para la API); Postgres
-- no mira ese permiso al disparar el trigger.
CREATE OR REPLACE FUNCTION mark_booking_google_dirty()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.google_dirty := true;
  ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.notes IS DISTINCT FROM OLD.notes
  THEN
    NEW.google_dirty := true;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

ALTER FUNCTION public.mark_booking_google_dirty() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_booking_google_dirty() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_booking_google_dirty() TO service_role;

DROP TRIGGER IF EXISTS mark_booking_google_dirty ON booking_appointments;
CREATE TRIGGER mark_booking_google_dirty
  BEFORE INSERT OR UPDATE ON booking_appointments
  FOR EACH ROW EXECUTE FUNCTION mark_booking_google_dirty();

-- ------------------------------------------------------------
-- updated_at de las citas: la sincronización con Google no lo mueve
-- ------------------------------------------------------------
-- El panel usa updated_at como candado optimista (mover o cancelar compara la
-- hora que leyó) y la sincronización compara el mismo valor antes de marcar
-- una cita como copiada. El set_updated_at de 047 (update_updated_at_column)
-- lo sube en TODO UPDATE, también en los que solo tocan google_dirty,
-- google_synced_at, google_calendar_id y google_sync_error: la sincronización
-- le haría perder la cita a quien la está editando. Por eso las citas tienen
-- su propia función: si lo único que cambió son esas cuatro columnas,
-- updated_at queda igual; en cualquier otro UPDATE (incluso uno que no cambia
-- nada, como antes) vale now(). La función compartida update_updated_at_column()
-- no se toca: sigue sirviendo a las demás tablas.
--
-- El trigger conserva el nombre set_updated_at, así que sigue corriendo
-- DESPUÉS de mark_booking_google_dirty (orden alfabético) y ve su resultado.
-- Volver a correr 047 después de esta migración lo reemplazaría otra vez por el
-- compartido: verify-schema.sql lo comprueba.
--
-- Se endurece igual que mark_booking_google_dirty.
CREATE OR REPLACE FUNCTION booking_appointments_set_updated_at()
RETURNS trigger AS $$
DECLARE
  -- updated_at no cuenta como "algo que cambió" (se decide aquí).
  ignored constant text[] := ARRAY[
    'updated_at', 'google_dirty', 'google_synced_at', 'google_calendar_id', 'google_sync_error'
  ];
BEGIN
  IF (
       NEW.google_dirty IS DISTINCT FROM OLD.google_dirty
       OR NEW.google_synced_at IS DISTINCT FROM OLD.google_synced_at
       OR NEW.google_calendar_id IS DISTINCT FROM OLD.google_calendar_id
       OR NEW.google_sync_error IS DISTINCT FROM OLD.google_sync_error
     )
     AND to_jsonb(NEW) - ignored = to_jsonb(OLD) - ignored
  THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

ALTER FUNCTION public.booking_appointments_set_updated_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.booking_appointments_set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_appointments_set_updated_at() TO service_role;

DROP TRIGGER IF EXISTS set_updated_at ON booking_appointments;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON booking_appointments
  FOR EACH ROW EXECUTE FUNCTION booking_appointments_set_updated_at();

-- ------------------------------------------------------------
-- 2) booking_staff.google_calendar_id
-- ------------------------------------------------------------
-- Calendario de Google de ese profesional. NULL = el de la conexión.
ALTER TABLE booking_staff
  ADD COLUMN IF NOT EXISTS google_calendar_id text;

ALTER TABLE booking_staff
  DROP CONSTRAINT IF EXISTS booking_staff_google_calendar_id_check;
ALTER TABLE booking_staff
  ADD CONSTRAINT booking_staff_google_calendar_id_check
  CHECK (google_calendar_id IS NULL OR char_length(google_calendar_id) <= 300);

-- ------------------------------------------------------------
-- 3) agenda_calendar_connections — la conexión con Google (§5)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agenda_calendar_connections (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  google_email text CHECK (google_email IS NULL OR char_length(google_email) <= 320),
  -- Cifrado con encrypt() de lib/whatsapp/encryption. Nunca sale al navegador.
  refresh_token_encrypted text NOT NULL CHECK (char_length(refresh_token_encrypted) BETWEEN 1 AND 4000),
  default_calendar_id text NOT NULL DEFAULT 'primary' CHECK (char_length(default_calendar_id) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  last_sync_at timestamptz,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 4) booking_call_settings — llamadas por pasos, por cuenta (§6.4)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_call_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'telnyx' CHECK (provider IN ('telnyx')),
  -- Apagadas por defecto: una cuenta no llama ni contesta hasta prenderlas.
  outbound_enabled boolean NOT NULL DEFAULT false,
  inbound_enabled boolean NOT NULL DEFAULT false,
  -- E.164. El número entrante es único en toda la plataforma (índice de abajo).
  inbound_number text CHECK (inbound_number IS NULL OR inbound_number ~ '^\+[1-9][0-9]{7,14}$'),
  -- Número que marca en las salientes; si es NULL se usa inbound_number.
  caller_id text CHECK (caller_id IS NULL OR caller_id ~ '^\+[1-9][0-9]{7,14}$'),
  -- De 0 a 3 números E.164, sin elementos nulos.
  advisor_phones text[] NOT NULL DEFAULT '{}' CHECK (
    array_position(advisor_phones, NULL::text) IS NULL
    AND array_to_string(advisor_phones, ',') ~ '^(\+[1-9][0-9]{7,14}(,\+[1-9][0-9]{7,14}){0,2})?$'
  ),
  -- {"1":[["08:00","18:00"]], …, "6":[["08:00","13:00"]]} (0 = domingo). La
  -- forma exacta la valida el código; aquí solo que sea un objeto pequeño.
  office_hours jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(office_hours) = 'object' AND char_length(office_hours::text) <= 2000
  ),
  info_text text CHECK (info_text IS NULL OR char_length(info_text) <= 500),
  call_after_minutes integer NOT NULL DEFAULT 180 CHECK (call_after_minutes BETWEEN 0 AND 2880),
  min_lead_minutes integer NOT NULL DEFAULT 120 CHECK (min_lead_minutes BETWEEN 0 AND 4320),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts BETWEEN 1 AND 3),
  retry_minutes integer NOT NULL DEFAULT 90 CHECK (retry_minutes BETWEEN 1 AND 2880),
  -- 'HH:MM', hora de Bogotá. Con ceros a la izquierda, así que comparar
  -- como texto equivale a comparar horas.
  window_start text NOT NULL DEFAULT '08:00' CHECK (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_end text NOT NULL DEFAULT '19:00' CHECK (window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  call_saturday boolean NOT NULL DEFAULT true,
  monthly_limit integer NOT NULL DEFAULT 300 CHECK (monthly_limit BETWEEN 0 AND 100000),
  -- NULL = la voz por defecto de la plataforma (VOICE_DEFAULT_VOICE).
  voice text CHECK (voice IS NULL OR char_length(voice) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);

-- Un número entrante, una sola cuenta: el webhook busca la cuenta por el To.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_call_settings_inbound_number
  ON booking_call_settings (inbound_number)
  WHERE inbound_number IS NOT NULL;

-- ------------------------------------------------------------
-- 5) booking_calls — llamadas del robot y anotadas a mano (§6.4)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  channel text NOT NULL CHECK (channel IN ('robot', 'manual')),
  -- NULL en las entrantes. La FK es compuesta: la cita es de la misma cuenta.
  appointment_id uuid,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- NULL en las entrantes.
  attempt integer CHECK (attempt IS NULL OR attempt BETWEEN 1 AND 3),
  -- De quien llama no siempre llega un número válido (llamada privada).
  from_number text CHECK (from_number IS NULL OR char_length(from_number) <= 40),
  to_number text CHECK (to_number IS NULL OR char_length(to_number) <= 40),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'calling', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'canceled'
  )),
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'confirmed', 'cancelled', 'human', 'no_response', 'wrong_number', 'booking_link_sent',
    'advisor_connected', 'advisor_missed', 'out_of_hours', 'info', 'urgency'
  )),
  menu_path text CHECK (menu_path IS NULL OR char_length(menu_path) <= 60),
  digits text CHECK (digits IS NULL OR char_length(digits) <= 10),
  provider_call_sid text CHECK (provider_call_sid IS NULL OR char_length(provider_call_sid) <= 100),
  error text CHECK (error IS NULL OR char_length(error) <= 300),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- MATCH SIMPLE (por defecto): con appointment_id NULL no se comprueba nada.
  CONSTRAINT booking_calls_appointment_fk
    FOREIGN KEY (account_id, appointment_id)
    REFERENCES booking_appointments (account_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booking_calls_account_created
  ON booking_calls (account_id, created_at);

-- Las llamadas de una cita (Para llamar, intentos) y la FK al borrar la cita.
CREATE INDEX IF NOT EXISTS idx_booking_calls_appointment
  ON booking_calls (appointment_id);

-- La FK busca por contact_id al borrar un contacto. Parcial: es anulable.
CREATE INDEX IF NOT EXISTS idx_booking_calls_contact
  ON booking_calls (contact_id)
  WHERE contact_id IS NOT NULL;

-- Reclamar un intento del robot = insertar la fila: dos corridas del cron no
-- llaman dos veces a la misma cita en el mismo intento. Las llamadas de
-- prueba (sin cita) no chocan: los NULL no se comparan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_calls_robot_attempt
  ON booking_calls (appointment_id, attempt)
  WHERE direction = 'outbound' AND channel = 'robot' AND attempt IS NOT NULL;

-- ------------------------------------------------------------
-- 6) Después de la cita (§7)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('cuidados', 'como_sigues', 'calificacion')),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  skip_reason text CHECK (skip_reason IS NULL OR char_length(skip_reason) <= 60),
  response text CHECK (response IS NULL OR response IN ('bien', 'molestias', 'ayuda')),
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinic_followups_appointment_fk
    FOREIGN KEY (account_id, appointment_id)
    REFERENCES booking_appointments (account_id, id)
    ON DELETE CASCADE,
  -- Correr el creador dos veces no duplica (upsert con ignoreDuplicates).
  UNIQUE (appointment_id, kind),
  -- Lo necesita la FK compuesta de clinic_ratings.
  UNIQUE (account_id, id)
);

-- Lo que toca enviar: el runner mira solo los pendientes.
CREATE INDEX IF NOT EXISTS idx_clinic_followups_due
  ON clinic_followups (due_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_clinic_followups_account_status_due
  ON clinic_followups (account_id, status, due_at);

-- La FK busca por contact_id al borrar un contacto. Parcial: es anulable.
CREATE INDEX IF NOT EXISTS idx_clinic_followups_contact
  ON clinic_followups (contact_id)
  WHERE contact_id IS NOT NULL;

-- Las calificaciones sobreviven a la cita, al seguimiento, al contacto y a la
-- sede: esas columnas pasan a NULL (ON DELETE SET NULL (columna), Postgres 15+).
CREATE TABLE IF NOT EXISTS clinic_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  appointment_id uuid,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  location_id uuid,
  value text NOT NULL CHECK (value IN ('bien', 'regular', 'mal')),
  followup_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clinic_ratings_appointment_fk
    FOREIGN KEY (account_id, appointment_id)
    REFERENCES booking_appointments (account_id, id)
    ON DELETE SET NULL (appointment_id),
  CONSTRAINT clinic_ratings_location_fk
    FOREIGN KEY (account_id, location_id)
    REFERENCES clinic_locations (account_id, id)
    ON DELETE SET NULL (location_id),
  CONSTRAINT clinic_ratings_followup_fk
    FOREIGN KEY (account_id, followup_id)
    REFERENCES clinic_followups (account_id, id)
    ON DELETE SET NULL (followup_id),
  -- Una calificación por seguimiento: tocar el botón dos veces no la repite.
  CONSTRAINT clinic_ratings_followup_unique UNIQUE (followup_id)
);

CREATE INDEX IF NOT EXISTS idx_clinic_ratings_account_created
  ON clinic_ratings (account_id, created_at);

-- Las FK buscan por estas columnas al borrar la cita, el contacto o la sede
-- (y la de contacto sirve para "calificó en los últimos 90 días"). Parciales:
-- son anulables.
CREATE INDEX IF NOT EXISTS idx_clinic_ratings_contact
  ON clinic_ratings (contact_id, created_at)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinic_ratings_appointment
  ON clinic_ratings (appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clinic_ratings_location
  ON clinic_ratings (location_id)
  WHERE location_id IS NOT NULL;

-- Cierre del día: un aviso por cuenta y día, aunque el cron corra muchas veces.
CREATE TABLE IF NOT EXISTS clinic_day_closes (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'YYYY-MM-DD', día local de Bogotá.
  date_key text NOT NULL CHECK (date_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, date_key)
);

-- Interruptor por cuenta de los seguimientos (cuidados, "¿cómo sigues?" y
-- calificación). El código no envía nada mientras sea false (o no haya fila en
-- clinic_settings): así desplegar el código no empieza a escribirle a los
-- pacientes antes de que Meta apruebe las tres plantillas. Se prende a mano,
-- con service role, cuenta por cuenta (docs/clinica-montaje.md). El cierre del
-- día NO depende de esto: solo avisa al dueño dentro de la app.
ALTER TABLE clinic_settings
  ADD COLUMN IF NOT EXISTS followups_enabled boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- updated_at (helper de 001)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON agenda_calendar_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON agenda_calendar_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON booking_call_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_call_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- booking_call_settings: cuatro columnas que controla Shift
-- ------------------------------------------------------------
-- La política deja al admin de la clínica escribir la fila entera por
-- PostgREST, pero estas cuatro no son suyas:
--   - provider:       quién pasa la llamada.
--   - monthly_limit:  el tope de llamadas, que paga Shift.
--   - inbound_number: único en toda la plataforma; el webhook encuentra la
--                     cuenta por él, así que uno ajeno desviaría las llamadas
--                     de otra clínica.
--   - caller_id:      el número que verá el paciente al recibir la llamada.
-- Mismo patrón que enforce_account_protected_columns (050): corre como quien
-- escribe (SIN SECURITY DEFINER, para que current_user sea el rol de la API) y
-- rechaza con 42501 si escribe authenticated o anon. Shift los fija con
-- service role (o el operador por SQL), que pasan.
--   - INSERT: deben venir con el valor por defecto (provider 'telnyx',
--     monthly_limit 300, inbound_number y caller_id en NULL); así el admin
--     puede crear su fila y la de Shift se completa después.
--   - UPDATE: no pueden cambiar. Mandar el mismo valor no es un cambio.
-- Si cambia el DEFAULT de monthly_limit hay que cambiarlo también aquí.
CREATE OR REPLACE FUNCTION enforce_call_settings_protected_columns()
RETURNS trigger AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.provider IS DISTINCT FROM 'telnyx'
         OR NEW.monthly_limit IS DISTINCT FROM 300
         OR NEW.inbound_number IS NOT NULL
         OR NEW.caller_id IS NOT NULL
      THEN
        RAISE EXCEPTION
          'booking_call_settings.provider, monthly_limit, inbound_number and caller_id are set by Shift with the service role, not from the panel'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.monthly_limit IS DISTINCT FROM OLD.monthly_limit
       OR NEW.inbound_number IS DISTINCT FROM OLD.inbound_number
       OR NEW.caller_id IS DISTINCT FROM OLD.caller_id
    THEN
      RAISE EXCEPTION
        'booking_call_settings.provider, monthly_limit, inbound_number and caller_id are set by Shift with the service role, not from the panel'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

ALTER FUNCTION public.enforce_call_settings_protected_columns() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_call_settings_protected_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_call_settings_protected_columns() TO service_role;

DROP TRIGGER IF EXISTS enforce_call_settings_protected_columns ON booking_call_settings;
CREATE TRIGGER enforce_call_settings_protected_columns
  BEFORE INSERT OR UPDATE ON booking_call_settings
  FOR EACH ROW EXECUTE FUNCTION enforce_call_settings_protected_columns();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE agenda_calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_call_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_day_closes ENABLE ROW LEVEL SECURITY;

-- agenda_calendar_connections: SIN políticas a propósito. Con la RLS prendida
-- y ninguna política, anon y authenticated no leen ni escriben nada; el
-- REVOKE quita además el permiso a nivel de tabla (doble cerradura). El
-- servidor (service role) se salta la RLS.
REVOKE ALL ON agenda_calendar_connections FROM anon, authenticated;

-- TRUNCATE no pasa por la RLS ni dispara triggers de fila, y Supabase se lo da
-- por defecto a anon y authenticated: se quita en las seis tablas nuevas
-- (como 055 con clinic_consents).
REVOKE TRUNCATE ON
  agenda_calendar_connections,
  booking_call_settings,
  booking_calls,
  clinic_followups,
  clinic_ratings,
  clinic_day_closes
FROM anon, authenticated;

-- Configuración de llamadas: los miembros leen, owner/admin escriben (050).
-- Sin política DELETE: la configuración se apaga, no se borra.
DROP POLICY IF EXISTS booking_call_settings_select ON booking_call_settings;
CREATE POLICY booking_call_settings_select ON booking_call_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_call_settings_insert ON booking_call_settings;
CREATE POLICY booking_call_settings_insert ON booking_call_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_call_settings_update ON booking_call_settings;
CREATE POLICY booking_call_settings_update ON booking_call_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Llamadas: los miembros leen. Un agent o más anota llamadas A MANO: solo
-- manual y saliente, a su nombre y con un contacto de su misma cuenta (la FK
-- sola no lo comprueba). La cita ya queda atada a la cuenta por la FK
-- compuesta. Las del robot y las entrantes las escribe el servidor. Sin
-- UPDATE ni DELETE para el navegador.
DROP POLICY IF EXISTS booking_calls_select ON booking_calls;
CREATE POLICY booking_calls_select ON booking_calls
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_calls_insert ON booking_calls;
CREATE POLICY booking_calls_insert ON booking_calls
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND channel = 'manual'
    AND direction = 'outbound'
    AND created_by = auth.uid()
    AND (
      contact_id IS NULL
      OR EXISTS (
        SELECT 1 FROM contacts c
        WHERE c.id = booking_calls.contact_id
          AND c.account_id = booking_calls.account_id
      )
    )
  );

-- Después de la cita: el navegador solo lee. Los escribe el servidor.
DROP POLICY IF EXISTS clinic_followups_select ON clinic_followups;
CREATE POLICY clinic_followups_select ON clinic_followups
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS clinic_ratings_select ON clinic_ratings;
CREATE POLICY clinic_ratings_select ON clinic_ratings
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS clinic_day_closes_select ON clinic_day_closes;
CREATE POLICY clinic_day_closes_select ON clinic_day_closes
  FOR SELECT USING (is_account_member(account_id));
