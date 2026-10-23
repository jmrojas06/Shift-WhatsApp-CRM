-- ============================================================
-- 054_ventas.sql — módulo Ventas A: pedidos hechos por WhatsApp
-- ============================================================
--
-- Diseño: docs/superpowers/specs/2026-10-22-modulos-ventas-a-design.md
--
--   1. orders: el pedido (consecutivo por cuenta desde 1001, totales,
--      pago, estado, datos de envío y registro del último aviso).
--   2. order_items: líneas de texto libre (sin catálogo todavía).
--   3. sales_settings: interruptores de los avisos al cliente.
--   4. RLS (patrón 017/050): los miembros leen; agent o más crean y
--      cambian estado; NADIE borra (se cancela). Los ajustes los
--      escribe solo owner/admin.
--   5. create_order(): crea pedido + líneas en UNA transacción con el
--      consecutivo bajo un lock por cuenta.
--
-- Depende de 053 solo en espíritu (el módulo se activa con
-- accounts.modules); no toca esa columna. Aplicar ANTES de desplegar
-- el código de Ventas. Es ADITIVA y NO destructiva: solo crea tablas,
-- funciones, triggers y políticas. Idempotente: se puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de una tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) orders
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 1001),
  -- RESTRICT: un contacto con pedidos no se puede borrar (el historial
  -- de ventas manda); primero hay que resolver sus pedidos.
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id uuid REFERENCES deals(id) ON DELETE SET NULL,
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0),
  shipping numeric(12,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  total numeric(12,2) NOT NULL CHECK (total = subtotal + shipping),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','shipped','delivered','cancelled')),
  city text CHECK (city IS NULL OR char_length(city) <= 80),
  address text CHECK (address IS NULL OR char_length(address) <= 200),
  id_number text CHECK (id_number IS NULL OR char_length(id_number) <= 20),
  carrier text CHECK (carrier IS NULL OR char_length(carrier) <= 60),
  tracking_number text CHECK (tracking_number IS NULL OR char_length(tracking_number) <= 60),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  last_notice text,            -- 'paid' | 'shipped' | 'delivered' del último aviso intentado
  last_notice_error text,      -- null si se envió bien
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at timestamptz, shipped_at timestamptz, delivered_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, number)
);
CREATE INDEX IF NOT EXISTS idx_orders_account_created ON orders (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_account_contact ON orders (account_id, contact_id);

-- ------------------------------------------------------------
-- 2) order_items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id, position);

-- ------------------------------------------------------------
-- 3) sales_settings (una fila por cuenta)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  notify_paid boolean NOT NULL DEFAULT true,
  notify_shipped boolean NOT NULL DEFAULT true,
  notify_delivered boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 4) updated_at
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON sales_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sales_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 5) Row-level security (017 pattern: viewers read, agents write)
-- ------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders
  FOR SELECT USING (is_account_member(account_id));

-- El contacto y la conversación deben ser de la MISMA cuenta: la FK sola
-- no lo comprueba y un agente podría insertar directo por PostgREST.
DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = orders.contact_id AND c.account_id = orders.account_id
    )
    AND (
      orders.conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM conversations v
        WHERE v.id = orders.conversation_id AND v.account_id = orders.account_id
      )
    )
  );

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Sin política DELETE a propósito: un pedido se cancela, no se borra.

DROP POLICY IF EXISTS order_items_select ON order_items;
CREATE POLICY order_items_select ON order_items
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS order_items_insert ON order_items;
CREATE POLICY order_items_insert ON order_items
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS order_items_update ON order_items;
CREATE POLICY order_items_update ON order_items
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Sin política DELETE a propósito (las líneas caen con el pedido solo si
-- Shift, con rol de servicio, lo borra).

DROP POLICY IF EXISTS sales_settings_select ON sales_settings;
CREATE POLICY sales_settings_select ON sales_settings
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS sales_settings_insert ON sales_settings;
CREATE POLICY sales_settings_insert ON sales_settings
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sales_settings_update ON sales_settings;
CREATE POLICY sales_settings_update ON sales_settings
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sales_settings_delete ON sales_settings;
CREATE POLICY sales_settings_delete ON sales_settings
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 6) Columnas congeladas para el navegador
-- ------------------------------------------------------------
-- La política de UPDATE deja a un agente tocar cualquier columna de su
-- pedido por PostgREST. Los importes, el número, el dueño, el contacto y
-- la conversación NO se cambian desde el cliente (un pedido mal armado se cancela y se
-- crea otro); el estado, el pago, el envío, los avisos y el negocio sí.
-- Los escritores del servidor (service_role / postgres) no se afectan:
-- current_user nunca es authenticated / anon ahí.
CREATE OR REPLACE FUNCTION public.orders_freeze_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.number IS DISTINCT FROM OLD.number
      OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
      OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
      OR NEW.shipping IS DISTINCT FROM OLD.shipping
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at)
     AND current_user IN ('authenticated', 'anon')
  THEN
    RAISE EXCEPTION
      'orders amounts, number, owner and contact cannot be changed directly; cancel the order and create a new one'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_freeze_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS orders_freeze_columns ON orders;
CREATE TRIGGER orders_freeze_columns
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_freeze_columns();

-- Las líneas son el comprobante del pedido: el navegador no las edita.
CREATE OR REPLACE FUNCTION public.order_items_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'order items cannot be changed directly; cancel the order and create a new one'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.order_items_freeze() OWNER TO postgres;

DROP TRIGGER IF EXISTS order_items_freeze ON order_items;
CREATE TRIGGER order_items_freeze
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_freeze();

-- ------------------------------------------------------------
-- 7) create_order(): pedido + líneas, atómico y con consecutivo seguro
-- ------------------------------------------------------------
-- SECURITY INVOKER: corre con el usuario que llama, así que RLS aplica
-- (un agente solo crea en su cuenta). Aun así NO se confía en lo que
-- manda el llamador: el contacto y la conversación se comprueban contra
-- la cuenta aquí dentro (con service_role RLS no aplica y este es el
-- único guardia).
--
-- p_items: [{ "name": text, "quantity": int, "unit_price": numeric }, …]
--   (1 a 50). Los rangos finos los vigilan los CHECK de las tablas.
-- p_fields: { "city", "address", "id_number", "notes" } (todo opcional).
-- El total NUNCA llega de fuera: se calcula aquí.
--
-- El max()+1 va dentro de un lock advisory por cuenta tomado en la
-- misma transacción del INSERT: dos pedidos a la vez nunca repiten
-- número (y UNIQUE (account_id, number) es la última red).
CREATE OR REPLACE FUNCTION public.create_order(
  p_account_id uuid, p_contact_id uuid, p_conversation_id uuid,
  p_items jsonb, p_shipping numeric, p_currency text,
  p_paid boolean, p_fields jsonb
) RETURNS orders
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_number integer;
  v_subtotal numeric(12,2);
  v_shipping numeric := coalesce(p_shipping, 0);
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_paid boolean := coalesce(p_paid, false);
  v_item jsonb;
  v_count integer;
  v_order orders;
BEGIN
  IF p_account_id IS NULL OR p_contact_id IS NULL THEN
    RAISE EXCEPTION 'account and contact are required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'fields must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  -- Líneas: arreglo de 1 a 50 objetos completos.
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'items must be a JSON array'
      USING ERRCODE = '22023';
  END IF;
  v_count := jsonb_array_length(p_items);
  IF v_count < 1 OR v_count > 50 THEN
    RAISE EXCEPTION 'an order needs between 1 and 50 items, got %', v_count
      USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_item->'unit_price') IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'every item needs a name (text), quantity (number) and unit_price (number)'
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric) THEN
      RAISE EXCEPTION 'item quantity must be a whole number'
        USING ERRCODE = '22023';
    END IF;
    -- Sin más de 2 decimales: así el subtotal coincide con la suma de las
    -- líneas tal como quedan guardadas (numeric(12,2)).
    IF (v_item->>'unit_price')::numeric <> round((v_item->>'unit_price')::numeric, 2) THEN
      RAISE EXCEPTION 'item unit_price allows at most 2 decimals'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_shipping <> round(v_shipping, 2) THEN
    RAISE EXCEPTION 'shipping allows at most 2 decimals'
      USING ERRCODE = '22023';
  END IF;

  -- Pertenencia a la cuenta: jamás confiar en los ids del llamador.
  IF NOT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = p_contact_id AND account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'contact % does not belong to account %', p_contact_id, p_account_id
      USING ERRCODE = '23503';
  END IF;
  IF p_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM conversations
    WHERE id = p_conversation_id AND account_id = p_account_id AND contact_id = p_contact_id
  ) THEN
    RAISE EXCEPTION 'conversation % does not belong to account % and contact %',
      p_conversation_id, p_account_id, p_contact_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('orders:' || p_account_id::text, 0));
  SELECT coalesce(max(number), 1000) + 1 INTO v_number FROM orders WHERE account_id = p_account_id;

  -- ::numeric primero: un 2.0 de JSON llega como '2.0' y ::int directo fallaría.
  SELECT coalesce(sum(((i->>'quantity')::numeric)::int * (i->>'unit_price')::numeric), 0)
    INTO v_subtotal FROM jsonb_array_elements(p_items) AS i;

  INSERT INTO orders (account_id, number, contact_id, conversation_id, subtotal, shipping, total,
    currency, payment_status, paid_at, city, address, id_number, notes, created_by)
  VALUES (p_account_id, v_number, p_contact_id, p_conversation_id, v_subtotal, v_shipping,
    v_subtotal + v_shipping, p_currency,
    CASE WHEN v_paid THEN 'paid' ELSE 'pending' END, CASE WHEN v_paid THEN now() END,
    nullif(btrim(v_fields->>'city'), ''), nullif(btrim(v_fields->>'address'), ''),
    nullif(btrim(v_fields->>'id_number'), ''), nullif(btrim(v_fields->>'notes'), ''),
    auth.uid())
  RETURNING * INTO v_order;

  INSERT INTO order_items (order_id, account_id, name, quantity, unit_price, position)
  SELECT v_order.id, p_account_id, i->>'name', ((i->>'quantity')::numeric)::int, (i->>'unit_price')::numeric,
         (ord - 1)::int
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ord);

  RETURN v_order;
END
$$;

REVOKE ALL ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb) TO authenticated, service_role;

-- ============================================================
-- Validación manual (además de supabase/ci/verify-schema.sql):
--
--   Como AGENT (JWT vía PostgREST):
--     POST /rest/v1/rpc/create_order { p_account_id, p_contact_id, … }
--       → 201 con el pedido #1001 (y #1002 en la siguiente llamada)
--     PATCH /rest/v1/orders?id=eq.<id> { "status": "shipped", … }   → 200
--     PATCH /rest/v1/orders?id=eq.<id> { "total": 1 }               → 42501
--     DELETE /rest/v1/orders?id=eq.<id>                             → 0 filas
--   Como AGENT con un contacto de OTRA cuenta:
--     create_order(...)                                             → 23503
--   Como VIEWER: create_order(...) → 42501 (RLS), SELECT sí funciona.
--   Activar Ventas en una cuenta (operador, SQL Editor):
--     UPDATE accounts SET modules = array_append(modules, 'ventas')
--     WHERE id = '<cuenta>' AND NOT ('ventas' = ANY(modules));
-- ============================================================
