-- ============================================================
-- 047_verticals_booking.sql — vertical modules + generic booking schema
-- ============================================================
--
-- Introduces the vertical-module seam (SHIFT Digital fork):
--
--   1. `accounts.vertical_key` — which vertical template the account
--      installed ('barberia', …). NULL for classic wacrm accounts; the
--      webhook dispatcher (src/lib/verticals/dispatch.ts) and the
--      sidebar branch on it.
--   2. A generic `booking_*` schema shared by every vertical that
--      manages appointments — barbería first, salón will reuse it:
--      services, staff, staff↔service mapping, working hours, time off,
--      appointments, chat booking sessions, and an append-only log.
--
-- Design notes:
--   - Double-booking is prevented at the database level: the EXCLUDE
--     constraint below refuses two overlapping pending/confirmed
--     appointments for the same staff member, no matter who writes —
--     bot controller, dashboard, or API. Needs `btree_gist` for gist
--     opclasses over uuid equality + tstzrange overlap.
--   - One active booking session per (account, contact): the partial
--     unique index makes "find the live session" a single-row lookup.
--     The dialog state lives in `booking_sessions.state` (jsonb), owned
--     by the vertical controller.
--   - `booking_events` is written by a SECURITY DEFINER trigger, so
--     every insert / status change / reschedule is audited even though
--     writers (bot = service role, dashboard = authenticated) never
--     need INSERT rights on the log itself.
--   - Timestamps are `timestamptz`; the app renders them in
--     America/Bogota (UTC-5, no DST).
--   - RLS follows 017_account_sharing.sql: viewers read, agents write.
--     Appointments have no DELETE policy — they are business records;
--     a mistake is cancelled, not deleted (the service role can still
--     clean up).
--
-- Idempotent: IF NOT EXISTS / DROP IF EXISTS on every statement.
-- ============================================================

-- gist opclasses for uuid equality live in btree_gist. On hosted
-- Supabase the extension may already be installed in the `extensions`
-- schema; IF NOT EXISTS keeps this a no-op there (same note as 030
-- carries for pgvector).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
-- accounts.vertical_key
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS vertical_key text;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_vertical_key_check;

-- Free-form but machine-safe: matches the VerticalKey union on the TS
-- side without a rigid enum that would need a migration per vertical.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_vertical_key_check
  CHECK (vertical_key IS NULL OR vertical_key ~ '^[a-z0-9_-]{1,40}$');

-- ------------------------------------------------------------
-- booking_services — the shop's catalog
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  duration_minutes integer NOT NULL DEFAULT 30,
  price numeric(12,2) NOT NULL DEFAULT 0,
  -- Soft-delete switch: appointment history keeps pointing here.
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_services_duration_check
    CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  CONSTRAINT booking_services_price_check CHECK (price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_booking_services_account_position
  ON booking_services (account_id, position);

-- ------------------------------------------------------------
-- booking_staff — barbers / specialists
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text,
  -- Pitch shown to customers when the bot offers a choice.
  bio text,
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_staff_account_position
  ON booking_staff (account_id, position);

-- ------------------------------------------------------------
-- booking_staff_services — which specialist performs which service
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_staff_services (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_staff_services_service
  ON booking_staff_services (service_id);

-- ------------------------------------------------------------
-- booking_working_hours — weekly availability per staff member
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
  -- 0 = Sunday … 6 = Saturday, matching JS Date#getDay() and
  -- Postgres extract(dow) so slot generation needs no remapping.
  weekday smallint NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_working_hours_weekday_check
    CHECK (weekday BETWEEN 0 AND 6),
  -- Multiple rows per (staff, weekday) are allowed: split shifts.
  CONSTRAINT booking_working_hours_time_check CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_booking_working_hours_account_staff_weekday
  ON booking_working_hours (account_id, staff_id, weekday);

-- ------------------------------------------------------------
-- booking_time_off — vacations, breaks, one-off blocks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES booking_staff(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_time_off_time_check CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_booking_time_off_account_staff_start
  ON booking_time_off (account_id, staff_id, starts_at);

-- ------------------------------------------------------------
-- booking_appointments — the bookings themselves
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- Keep history when the catalog changes: deleting a service/staff
  -- member nulls the reference instead of the appointment.
  service_id uuid REFERENCES booking_services(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES booking_staff(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  notes text,
  cancel_reason text,
  -- Who created the row: the WhatsApp bot controller, a dashboard user,
  -- or the API (seeds included). Mirrored into booking_events.actor.
  created_via text NOT NULL DEFAULT 'agent',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Set on the replacement row when a booking is rescheduled.
  rescheduled_from uuid REFERENCES booking_appointments(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  -- Reminder runner stamp (Phase 3) so a reminder never goes out twice.
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_appointments_status_check
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  CONSTRAINT booking_appointments_created_via_check
    CHECK (created_via IN ('bot', 'agent', 'api')),
  CONSTRAINT booking_appointments_time_check CHECK (ends_at > starts_at)
);

-- The double-booking guard. `staff_id WITH =` refuses overlap for the
-- same specialist; only pending/confirmed rows participate (cancelled /
-- completed history is exempt); NULL staff (deleted member) never
-- blocks. tstzrange is half-open [start, end): a slot ending at 10:00
-- does not collide with one starting at 10:00.
ALTER TABLE booking_appointments
  DROP CONSTRAINT IF EXISTS booking_appointments_no_overlap;

ALTER TABLE booking_appointments
  ADD CONSTRAINT booking_appointments_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  )
  WHERE (status IN ('pending', 'confirmed') AND staff_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_account_start
  ON booking_appointments (account_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_contact_start
  ON booking_appointments (contact_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_staff_start
  ON booking_appointments (staff_id, starts_at);

-- Cross-account scan for the reminder runner (Phase 3): everything due
-- that has not been reminded yet.
CREATE INDEX IF NOT EXISTS idx_booking_appointments_due_reminder
  ON booking_appointments (starts_at)
  WHERE status IN ('pending', 'confirmed') AND reminder_sent_at IS NULL;

-- ------------------------------------------------------------
-- booking_sessions — the multi-turn chat dialog state
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Dialog state (service/staff/date picked so far). Free-form jsonb —
  -- the vertical controller owns its shape.
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  -- Refreshed on every message; the webhook dispatcher treats a session
  -- as active only while this is in the future.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_sessions_status_check
    CHECK (status IN ('active', 'completed', 'cancelled', 'expired'))
);

-- At most one live session per (account, contact) — the partial unique
-- index makes the dispatcher's lookup single-row by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_sessions_one_active
  ON booking_sessions (account_id, contact_id)
  WHERE status = 'active';

-- ------------------------------------------------------------
-- booking_events — append-only audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit rows outlive their appointment (delete → SET NULL).
  appointment_id uuid REFERENCES booking_appointments(id) ON DELETE SET NULL,
  -- 'created' | 'confirmed' | 'cancelled' | 'completed' | 'no_show' |
  -- 'rescheduled' — free-form on purpose: verticals add their own verbs
  -- without a migration.
  event text NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_events_actor_check
    CHECK (actor IN ('bot', 'agent', 'api', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_booking_events_account_created
  ON booking_events (account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_booking_events_appointment_created
  ON booking_events (appointment_id, created_at);

-- ------------------------------------------------------------
-- updated_at maintenance (001 helper)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON booking_services;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON booking_staff;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_staff
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON booking_appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON booking_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- booking_events audit trigger
-- ------------------------------------------------------------
-- One event per appointment insert, plus one per status change or
-- reschedule — regardless of the writer. SECURITY DEFINER so writers
-- never need INSERT rights on the log (same hardening pattern as
-- 044_internal_definer_grants.sql: execute only for the service role;
-- trigger invocation does not check the firing user's EXECUTE grant).
CREATE OR REPLACE FUNCTION log_booking_appointment_event()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO booking_events (account_id, appointment_id, event, actor, payload)
    VALUES (
      NEW.account_id,
      NEW.id,
      'created',
      NEW.created_via,
      jsonb_build_object(
        'status', NEW.status,
        'starts_at', NEW.starts_at,
        'service_id', NEW.service_id,
        'staff_id', NEW.staff_id
      )
    );
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO booking_events (account_id, appointment_id, event, actor, payload)
    VALUES (
      NEW.account_id,
      NEW.id,
      NEW.status,
      'system',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    INSERT INTO booking_events (account_id, appointment_id, event, actor, payload)
    VALUES (
      NEW.account_id,
      NEW.id,
      'rescheduled',
      'system',
      jsonb_build_object('from', OLD.starts_at, 'to', NEW.starts_at)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

ALTER FUNCTION public.log_booking_appointment_event() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_booking_appointment_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_booking_appointment_event() TO service_role;

DROP TRIGGER IF EXISTS log_booking_appointment_event ON booking_appointments;
CREATE TRIGGER log_booking_appointment_event
  AFTER INSERT OR UPDATE ON booking_appointments
  FOR EACH ROW EXECUTE FUNCTION log_booking_appointment_event();

-- ------------------------------------------------------------
-- Row-level security (017 pattern: viewers read, agents write)
-- ------------------------------------------------------------
ALTER TABLE booking_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_staff_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_services_select ON booking_services;
CREATE POLICY booking_services_select ON booking_services
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_services_insert ON booking_services;
CREATE POLICY booking_services_insert ON booking_services
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_services_update ON booking_services;
CREATE POLICY booking_services_update ON booking_services
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_services_delete ON booking_services;
CREATE POLICY booking_services_delete ON booking_services
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_staff_select ON booking_staff;
CREATE POLICY booking_staff_select ON booking_staff
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_staff_insert ON booking_staff;
CREATE POLICY booking_staff_insert ON booking_staff
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_staff_update ON booking_staff;
CREATE POLICY booking_staff_update ON booking_staff
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_staff_delete ON booking_staff;
CREATE POLICY booking_staff_delete ON booking_staff
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_staff_services_select ON booking_staff_services;
CREATE POLICY booking_staff_services_select ON booking_staff_services
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_staff_services_insert ON booking_staff_services;
CREATE POLICY booking_staff_services_insert ON booking_staff_services
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_staff_services_update ON booking_staff_services;
CREATE POLICY booking_staff_services_update ON booking_staff_services
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_staff_services_delete ON booking_staff_services;
CREATE POLICY booking_staff_services_delete ON booking_staff_services
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_working_hours_select ON booking_working_hours;
CREATE POLICY booking_working_hours_select ON booking_working_hours
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_working_hours_insert ON booking_working_hours;
CREATE POLICY booking_working_hours_insert ON booking_working_hours
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_working_hours_update ON booking_working_hours;
CREATE POLICY booking_working_hours_update ON booking_working_hours
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_working_hours_delete ON booking_working_hours;
CREATE POLICY booking_working_hours_delete ON booking_working_hours
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_time_off_select ON booking_time_off;
CREATE POLICY booking_time_off_select ON booking_time_off
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_time_off_insert ON booking_time_off;
CREATE POLICY booking_time_off_insert ON booking_time_off
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_time_off_update ON booking_time_off;
CREATE POLICY booking_time_off_update ON booking_time_off
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_time_off_delete ON booking_time_off;
CREATE POLICY booking_time_off_delete ON booking_time_off
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_appointments_select ON booking_appointments;
CREATE POLICY booking_appointments_select ON booking_appointments
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_appointments_insert ON booking_appointments;
CREATE POLICY booking_appointments_insert ON booking_appointments
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_appointments_update ON booking_appointments;
CREATE POLICY booking_appointments_update ON booking_appointments
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy: appointments are business records — mistakes are
-- cancelled (status), not removed. The service role can still clean up.

DROP POLICY IF EXISTS booking_sessions_select ON booking_sessions;
CREATE POLICY booking_sessions_select ON booking_sessions
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_sessions_insert ON booking_sessions;
CREATE POLICY booking_sessions_insert ON booking_sessions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_sessions_update ON booking_sessions;
CREATE POLICY booking_sessions_update ON booking_sessions
  FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_sessions_delete ON booking_sessions;
CREATE POLICY booking_sessions_delete ON booking_sessions
  FOR DELETE USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS booking_events_select ON booking_events;
CREATE POLICY booking_events_select ON booking_events
  FOR SELECT USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policies: rows come from the SECURITY
-- DEFINER trigger above (and the service role, which bypasses RLS) —
-- the log is append-only from any client's perspective.
