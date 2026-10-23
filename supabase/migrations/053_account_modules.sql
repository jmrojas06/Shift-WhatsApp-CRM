-- ============================================================
-- 053_account_modules.sql — módulos combinables por cuenta
-- ============================================================
--
-- Hasta hoy una cuenta tenía UN vertical (`accounts.vertical_key`,
-- migración 047). Con los módulos combinables una cuenta puede tener
-- varios a la vez (agenda + ventas…): `accounts.modules text[]`.
--
--   - `modules` es la fuente de verdad que lee el código nuevo
--     (`getAccountModules` en src/lib/verticals/registry.ts).
--   - `vertical_key` se MANTIENE por compatibilidad: mientras `modules`
--     esté vacío el código cae a él. Una migración posterior lo
--     eliminará cuando todo lea `modules` (no en esta fase).
--   - Solo Shift (operador, rol de servicio / postgres) activa o
--     desactiva módulos: la protección de 050 se extiende a `modules`.
--
-- Orden de despliegue: el código nuevo tolera que la columna no exista
-- todavía (cae a `vertical_key`), así que esta migración puede ir antes
-- o después del despliegue. Es ADITIVA y NO destructiva: agrega una
-- función, una columna y una restricción, y rellena `modules`. No borra
-- ni reescribe columnas existentes. Idempotente: se puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de la tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- Clave de módulo válida (misma forma que vertical_key). Un elemento NULL
-- no es válido (bool_and ignora los NULL, por eso se pregunta aparte), y
-- el search_path fijo evita que la función dependa de la sesión.
CREATE OR REPLACE FUNCTION public.valid_module_keys(keys text[])
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(bool_and(k IS NOT NULL AND k ~ '^[a-z0-9_-]{1,40}$'), true) FROM unnest(keys) AS k
$$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS modules text[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_modules_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_modules_check CHECK (public.valid_module_keys(modules));

-- Backfill: la agenda (o su clave vieja) pasa a la lista.
UPDATE accounts SET modules = array_append(modules, 'agenda')
WHERE vertical_key IN ('agenda', 'barberia') AND NOT ('agenda' = ANY(modules));

-- ------------------------------------------------------------
-- Columnas protegidas de accounts: el cliente tampoco cambia `modules`
-- ------------------------------------------------------------
-- Mismo cuerpo que 050 más `modules`. Los escritores legítimos no se
-- afectan: current_user es postgres / service_role (backend, SQL
-- Editor, transfer_account_ownership SECURITY DEFINER), nunca
-- `authenticated` / `anon`. El trigger de 050 ya apunta a esta función.
CREATE OR REPLACE FUNCTION public.enforce_account_protected_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.vertical_key IS DISTINCT FROM OLD.vertical_key
      OR NEW.modules IS DISTINCT FROM OLD.modules)
     AND current_user IN ('authenticated', 'anon')
  THEN
    RAISE EXCEPTION
      'owner_user_id, vertical_key and modules cannot be changed directly; ownership moves through transfer_account_ownership and the modules are set by the operator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_protected_columns() OWNER TO postgres;

-- ============================================================
-- Validación manual (además de supabase/ci/verify-schema.sql):
--
--   Como ADMIN (JWT vía PostgREST) debe fallar con 42501:
--     PATCH /rest/v1/accounts?id=eq.<propia> { "modules": ["ventas"] }
--   Como ADMIN debe seguir funcionando:
--     PATCH /rest/v1/accounts?id=eq.<propia> { "default_currency": "COP" }
--   Como operador (SQL Editor), activar Ventas en una cuenta:
--     UPDATE accounts SET modules = array_append(modules, 'ventas')
--     WHERE id = '<cuenta>' AND NOT ('ventas' = ANY(modules));
-- ============================================================
