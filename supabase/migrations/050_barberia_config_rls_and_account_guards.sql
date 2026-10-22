-- ============================================================
-- 050_barberia_config_rls_and_account_guards.sql
--   D2 — RLS de configuración del vertical solo para owner/admin
--   D3 — accounts.owner_user_id / vertical_key protegidas
-- ============================================================
--
-- NO destructiva: no borra tablas, columnas ni datos. Solo reemplaza
-- políticas (DROP POLICY IF EXISTS + CREATE POLICY con el mismo nombre)
-- y agrega una función + trigger. Idempotente: se puede correr de nuevo.
--
-- D2 — El problema
--
--   047/048 dieron escritura a 'agent' en TODA la configuración del
--   vertical ("viewers read, agents write"). La API de Configuración
--   (src/app/api/verticals/barberia/*) exige admin, pero con la llave
--   pública + su sesión un agente podía editar directo por PostgREST
--   servicios, barberos, horarios, bloqueos y los textos del bot.
--
-- D2 — La regla nueva
--
--   Configuración (booking_services, booking_staff,
--   booking_staff_services, booking_working_hours, booking_time_off,
--   booking_settings):
--     SELECT                  → cualquier miembro (owner/admin/agent/viewer)
--     INSERT / UPDATE / DELETE → owner y admin
--   Los agentes NO crean bloqueos (time off).
--
--   Operación (booking_appointments, booking_sessions): SIN cambios —
--   agent sigue escribiendo (la agenda del día mueve citas). booking_events
--   sigue siendo de solo lectura para clientes (lo escribe el trigger).
--
--   El bot y el instalador usan service role (no pasan por RLS): no
--   cambian.
--
--   booking_settings no tenía política DELETE (nadie podía borrar la
--   fila desde el cliente); se agrega para owner/admin según la regla
--   pedida. Borrarla solo devuelve la cuenta a los defaults.
--
-- D3 — El problema
--
--   accounts_update (017) permite a un admin actualizar CUALQUIER
--   columna de su cuenta, incluidas owner_user_id y vertical_key. No le
--   da permisos (salen de profiles, protegido en 034), pero cambia a
--   quién le llegan los avisos de handoff, la regla de redeem_invitation
--   y qué vertical tiene la cuenta.
--
-- D3 — La regla nueva (mismo patrón que 034)
--
--   Un trigger BEFORE UPDATE rechaza cualquier cambio a owner_user_id o
--   vertical_key cuando quien escribe es el navegador (`authenticated` /
--   `anon`). Los escritores legítimos no se afectan:
--     - transfer_account_ownership (018) es SECURITY DEFINER de
--       postgres → current_user = 'postgres';
--     - el backend y el onboarding de Shift (SQL editor) corren como
--       service_role / postgres.
--   Editar el nombre o la moneda (owner/admin) sigue funcionando.
-- ============================================================

-- ------------------------------------------------------------
-- D2: booking_services
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_services_insert ON booking_services;
CREATE POLICY booking_services_insert ON booking_services
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_services_update ON booking_services;
CREATE POLICY booking_services_update ON booking_services
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_services_delete ON booking_services;
CREATE POLICY booking_services_delete ON booking_services
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- D2: booking_staff
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_staff_insert ON booking_staff;
CREATE POLICY booking_staff_insert ON booking_staff
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_staff_update ON booking_staff;
CREATE POLICY booking_staff_update ON booking_staff
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_staff_delete ON booking_staff;
CREATE POLICY booking_staff_delete ON booking_staff
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- D2: booking_staff_services
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_staff_services_insert ON booking_staff_services;
CREATE POLICY booking_staff_services_insert ON booking_staff_services
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_staff_services_update ON booking_staff_services;
CREATE POLICY booking_staff_services_update ON booking_staff_services
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_staff_services_delete ON booking_staff_services;
CREATE POLICY booking_staff_services_delete ON booking_staff_services
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- D2: booking_working_hours
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_working_hours_insert ON booking_working_hours;
CREATE POLICY booking_working_hours_insert ON booking_working_hours
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_working_hours_update ON booking_working_hours;
CREATE POLICY booking_working_hours_update ON booking_working_hours
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_working_hours_delete ON booking_working_hours;
CREATE POLICY booking_working_hours_delete ON booking_working_hours
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- D2: booking_time_off (los agentes NO crean bloqueos)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_time_off_insert ON booking_time_off;
CREATE POLICY booking_time_off_insert ON booking_time_off
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_time_off_update ON booking_time_off;
CREATE POLICY booking_time_off_update ON booking_time_off
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_time_off_delete ON booking_time_off;
CREATE POLICY booking_time_off_delete ON booking_time_off
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- D2: booking_settings (configuración general + textos del bot)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS booking_settings_insert ON booking_settings;
CREATE POLICY booking_settings_insert ON booking_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_settings_update ON booking_settings;
CREATE POLICY booking_settings_update ON booking_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_settings_delete ON booking_settings;
CREATE POLICY booking_settings_delete ON booking_settings
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Las políticas SELECT de 047/048 (`is_account_member(account_id)`,
-- cualquier rol) y las de booking_appointments / booking_sessions
-- (escritura 'agent') se dejan tal cual.

-- ------------------------------------------------------------
-- D3: columnas protegidas de accounts
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_account_protected_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.vertical_key IS DISTINCT FROM OLD.vertical_key)
     AND current_user IN ('authenticated', 'anon')
  THEN
    RAISE EXCEPTION
      'owner_user_id and vertical_key cannot be changed directly; ownership moves through transfer_account_ownership and the vertical is set by the operator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_protected_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_protected_columns ON public.accounts;
CREATE TRIGGER enforce_account_protected_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_protected_columns();

-- ============================================================
-- Validación manual (además de supabase/ci/verify-schema.sql):
--
--   Como AGENTE (JWT vía PostgREST), deben fallar (0 filas / 42501):
--     POST  /rest/v1/booking_services   { "account_id": "<propia>", "name": "x" }
--     POST  /rest/v1/booking_time_off   { "account_id": "<propia>", ... }
--     PATCH /rest/v1/booking_settings?account_id=eq.<propia> { "bot_texts": {} }
--   Como AGENTE debe seguir funcionando:
--     PATCH /rest/v1/booking_appointments?id=eq.<cita> { "status": "completed" }
--   Como ADMIN debe fallar con 42501:
--     PATCH /rest/v1/accounts?id=eq.<propia> { "owner_user_id": "<self>" }
--     PATCH /rest/v1/accounts?id=eq.<propia> { "vertical_key": "barberia" }
--   Como ADMIN debe seguir funcionando:
--     PATCH /rest/v1/accounts?id=eq.<propia> { "default_currency": "COP" }
--   Como OWNER: transferir la propiedad desde Ajustes sigue funcionando.
-- ============================================================
