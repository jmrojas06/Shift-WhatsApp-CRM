-- ============================================================
-- 048_booking_reminders.sql — recordatorios de citas (Fase 3)
-- ============================================================
--
-- Completa lo que 047 dejó preparado para la Fase 3 del vertical
-- de barbería:
--
--   1. `booking_appointments.reminder_2h_sent_at` — segunda señal
--      (2 h antes), opcional por cuenta. `reminder_sent_at` (047)
--      sigue siendo la primera señal (24 h antes por defecto).
--   2. `booking_settings` — configuración de reservas por cuenta.
--      Por ahora solo `reminders_2h_enabled` (default false: la
--      señal de 2 h se activa a propósito).
--
-- El runner (src/verticals/barberia/agent/reminders.ts) reclama cada
-- señal con un UPDATE condicional sobre estas columnas: dos corridas
-- simultáneas del cron nunca mandan dos veces el mismo recordatorio.
--
-- Idempotente: IF NOT EXISTS / DROP IF EXISTS en todo.
-- ============================================================

-- ------------------------------------------------------------
-- Segunda marca de recordatorio (2 h antes, opt-in)
-- ------------------------------------------------------------
ALTER TABLE booking_appointments
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at timestamptz;

-- El índice parcial de 047 cubre la primera señal; este cubre la
-- segunda con el mismo criterio: el runner solo mira filas sin marcar.
CREATE INDEX IF NOT EXISTS idx_booking_appointments_due_reminder_2h
  ON booking_appointments (starts_at)
  WHERE status IN ('pending', 'confirmed')
    AND reminder_2h_sent_at IS NULL;

-- ------------------------------------------------------------
-- booking_settings — configuración de reservas por cuenta
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Segunda señal del recordatorio, 2 h antes. Decisión de producto:
  -- 24 h por defecto, 2 h opcional (se enciende a propósito).
  reminders_2h_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Row-level security (017 pattern: viewers read, agents write)
-- ------------------------------------------------------------
ALTER TABLE booking_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_settings_select ON booking_settings;
CREATE POLICY booking_settings_select ON booking_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS booking_settings_insert ON booking_settings;
CREATE POLICY booking_settings_insert ON booking_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS booking_settings_update ON booking_settings;
CREATE POLICY booking_settings_update ON booking_settings
  FOR UPDATE USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON booking_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
