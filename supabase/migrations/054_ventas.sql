-- ============================================================
-- 054_ventas.sql — módulo Ventas A: pedidos hechos por WhatsApp
-- ============================================================
--
-- Diseño: docs/superpowers/specs/2026-10-22-modulos-ventas-a-design.md
--
--   1. orders: el pedido (consecutivo por cuenta desde 1001, totales,
--      pago, estado, datos de envío, nombre y teléfono del cliente tal
--      como estaban al vender, y registro del último aviso).
--   2. order_items: líneas de texto libre (sin catálogo todavía).
--   3. sales_settings: interruptores de los avisos al cliente.
--   4. RLS (patrón 017/050): los miembros leen; un agent o más cambia
--      el estado de sus pedidos; NADIE borra (se cancela) y los pedidos
--      NUEVOS solo nacen en create_order(). Los ajustes los escribe
--      solo owner/admin.
--   5. create_order(): crea pedido + líneas en UNA transacción con el
--      consecutivo bajo un lock por cuenta. SECURITY DEFINER con su
--      propia guarda de acceso.
--   6. Triggers que protegen el libro de ventas del navegador: importes
--      y dueño congelados, el estado solo avanza, el pago no se
--      devuelve y las marcas de tiempo se fijan una vez.
--
-- Depende de 053 (accounts.modules): create_order exige que la cuenta
-- tenga el módulo 'ventas'. Aplicar ANTES de desplegar el código de
-- Ventas. Es ADITIVA y NO destructiva: solo crea tablas, funciones,
-- triggers y políticas. Idempotente: se puede correr de nuevo.
-- ============================================================

-- Solo tiene efecto si el script corre dentro de una transacción (así
-- lo aplicamos). Si vence el tiempo, hay una consulta larga sosteniendo
-- el candado de una tabla: reintentar más tarde.
SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1) orders
-- ------------------------------------------------------------
-- NaN: en Postgres NaN >= 0 es verdadero, así que cada importe lleva
-- además `<> 'NaN'`.
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 1001),
  -- SET NULL: borrar un contacto no borra ni bloquea el historial de
  -- ventas; el pedido conserva el nombre y el teléfono de abajo.
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text NOT NULL CHECK (char_length(customer_phone) BETWEEN 1 AND 30),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id uuid REFERENCES deals(id) ON DELETE SET NULL,
  subtotal numeric(12,2) NOT NULL CHECK (subtotal >= 0 AND subtotal <> 'NaN'),
  shipping numeric(12,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0 AND shipping <> 'NaN'),
  total numeric(12,2) NOT NULL CHECK (total <> 'NaN') CHECK (total = subtotal + shipping),
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
-- Pedidos de un contacto (panel lateral del inbox) y vuelta desde las FK.
CREATE INDEX IF NOT EXISTS idx_orders_contact_created ON orders (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_conversation ON orders (conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_deal ON orders (deal_id)
  WHERE deal_id IS NOT NULL;
-- "Vendido este mes": pedidos pagados por fecha de pago.
CREATE INDEX IF NOT EXISTS idx_orders_account_paid_at ON orders (account_id, paid_at)
  WHERE payment_status = 'paid';

-- ------------------------------------------------------------
-- 2) order_items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0 AND unit_price <> 'NaN'),
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

-- Sin política INSERT a propósito: un pedido nuevo (con su número, sus
-- líneas y sus totales) solo nace en create_order(). Se borran por si
-- una versión anterior de este archivo ya se aplicó en algún entorno.
DROP POLICY IF EXISTS orders_insert ON orders;

-- El negocio enlazado (deal_id) debe ser de la misma cuenta: la FK sola
-- no lo comprueba.
DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (
      deal_id IS NULL
      OR EXISTS (
        SELECT 1 FROM deals d
        WHERE d.id = orders.deal_id AND d.account_id = orders.account_id
      )
    )
  );

-- Sin política DELETE a propósito: un pedido se cancela, no se borra.

DROP POLICY IF EXISTS order_items_select ON order_items;
CREATE POLICY order_items_select ON order_items
  FOR SELECT USING (is_account_member(account_id));

-- Las líneas son el comprobante del pedido: ni INSERT ni UPDATE ni
-- DELETE desde el navegador (nacen en create_order()).
DROP POLICY IF EXISTS order_items_insert ON order_items;
DROP POLICY IF EXISTS order_items_update ON order_items;

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
-- 6) Protección del libro de ventas frente al navegador
-- ------------------------------------------------------------
-- La política de UPDATE deja a un agente tocar cualquier columna de su
-- pedido por PostgREST. Estos triggers acotan qué puede cambiar.
-- Los escritores del servidor (service_role / postgres, y las acciones
-- de las FK como el SET NULL del contacto) no se afectan: current_user
-- nunca es authenticated / anon ahí.

-- 6a) Importes, número, dueño, contacto y cliente: congelados. Un pedido
-- mal armado se cancela y se crea otro.
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
      OR NEW.customer_name IS DISTINCT FROM OLD.customer_name
      OR NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
      OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
      OR NEW.shipping IS DISTINCT FROM OLD.shipping
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at)
     AND current_user IN ('authenticated', 'anon')
  THEN
    RAISE EXCEPTION
      'orders amounts, number, owner, contact and customer cannot be changed directly; cancel the order and create a new one'
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

-- 6b) El estado solo avanza (new→shipped→delivered; new|shipped→
-- cancelled; entregado y cancelado son finales), el pago nunca vuelve
-- de paid a pending, un pago exige su paid_at (de ahí sale "vendido este
-- mes") y las marcas de tiempo se fijan una sola vez. Avisos, negocio,
-- transportadora, guía, ciudad y dirección siguen editables.
CREATE OR REPLACE FUNCTION public.orders_ledger_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
         (OLD.status = 'new' AND NEW.status IN ('shipped', 'cancelled'))
         OR (OLD.status = 'shipped' AND NEW.status IN ('delivered', 'cancelled'))
       )
    THEN
      RAISE EXCEPTION 'order status cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.payment_status = 'paid' AND NEW.payment_status <> 'paid' THEN
      RAISE EXCEPTION 'a paid order cannot go back to pending'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.payment_status = 'paid' AND NEW.paid_at IS NULL THEN
      RAISE EXCEPTION 'a paid order needs its paid_at'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at)
       OR (OLD.shipped_at IS NOT NULL AND NEW.shipped_at IS DISTINCT FROM OLD.shipped_at)
       OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
       OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    THEN
      RAISE EXCEPTION 'order timestamps cannot be changed once set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.orders_ledger_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS orders_ledger_guard ON orders;
CREATE TRIGGER orders_ledger_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_ledger_guard();

-- 6c) Las líneas son el comprobante del pedido: el navegador no las edita.
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
-- SECURITY DEFINER (dueño postgres): es la ÚNICA vía para crear pedidos,
-- porque orders / order_items no tienen política INSERT. Como corre sin
-- RLS, la función se protege sola y NO confía en nada del llamador:
--
--   1. Guarda de acceso: service_role (backend) o un miembro con rol
--      agent o más de ESA cuenta; si no, 42501.
--   2. La cuenta debe tener el módulo 'ventas' (P0001 con mensaje
--      listo para la pantalla).
--   3. El contacto y la conversación se comprueban contra la cuenta
--      (23503). El nombre y el teléfono del cliente se copian del
--      contacto: el pedido los conserva aunque el contacto se borre.
--   4. La moneda sale de accounts.default_currency, nunca del llamador.
--   5. El total se calcula aquí; los CHECK de las tablas son la red.
--
-- p_items: [{ "name": text, "quantity": int, "unit_price": numeric }, …]
--   (1 a 50). Los rangos finos los vigilan los CHECK de las tablas.
-- p_fields: { "city", "address", "id_number", "notes" } (todo opcional).
--
-- El max()+1 va dentro de un lock advisory por cuenta tomado en la
-- misma transacción del INSERT: dos pedidos a la vez nunca repiten
-- número (y UNIQUE (account_id, number) es la última red).
CREATE OR REPLACE FUNCTION public.create_order(
  p_account_id uuid, p_contact_id uuid, p_conversation_id uuid,
  p_items jsonb, p_shipping numeric,
  p_paid boolean, p_fields jsonb
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_number integer;
  v_subtotal numeric(12,2);
  v_shipping numeric := coalesce(p_shipping, 0);
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_paid boolean := coalesce(p_paid, false);
  v_currency text;
  v_modules text[];
  v_contact_name text;
  v_contact_phone text;
  v_customer_name text;
  v_customer_phone text;
  v_item jsonb;
  v_count integer;
  v_order orders;
BEGIN
  IF p_account_id IS NULL OR p_contact_id IS NULL THEN
    RAISE EXCEPTION 'account and contact are required'
      USING ERRCODE = '22023';
  END IF;

  -- 1) Acceso. Sin esto cualquier usuario con sesión podría crear
  -- pedidos en la cuenta de otro (esta función salta RLS).
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT is_account_member(p_account_id, 'agent')
  THEN
    RAISE EXCEPTION 'not allowed to create orders in this account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2) Módulo activo + 4) moneda de la cuenta.
  SELECT default_currency, modules
    INTO v_currency, v_modules
    FROM accounts WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', p_account_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT ('ventas' = ANY(v_modules)) THEN
    RAISE EXCEPTION 'El módulo Ventas no está activo para esta cuenta.'
      USING ERRCODE = 'P0001';
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
    IF btrim(v_item->>'name') = '' THEN
      RAISE EXCEPTION 'item name cannot be empty'
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'quantity')::numeric <> trunc((v_item->>'quantity')::numeric) THEN
      RAISE EXCEPTION 'item quantity must be a whole number'
        USING ERRCODE = '22023';
    END IF;
    IF (v_item->>'unit_price')::numeric = 'NaN'::numeric THEN
      RAISE EXCEPTION 'item unit_price cannot be NaN'
        USING ERRCODE = '22023';
    END IF;
    -- Sin más de 2 decimales: así el subtotal coincide con la suma de las
    -- líneas tal como quedan guardadas (numeric(12,2)).
    IF (v_item->>'unit_price')::numeric <> round((v_item->>'unit_price')::numeric, 2) THEN
      RAISE EXCEPTION 'item unit_price allows at most 2 decimals'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_shipping = 'NaN'::numeric THEN
    RAISE EXCEPTION 'shipping cannot be NaN'
      USING ERRCODE = '22023';
  END IF;
  IF v_shipping <> round(v_shipping, 2) THEN
    RAISE EXCEPTION 'shipping allows at most 2 decimals'
      USING ERRCODE = '22023';
  END IF;

  -- 3) Pertenencia a la cuenta: jamás confiar en los ids del llamador.
  SELECT name, phone
    INTO v_contact_name, v_contact_phone
    FROM contacts
    WHERE id = p_contact_id AND account_id = p_account_id;
  IF NOT FOUND THEN
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

  -- Copia del cliente al momento de vender: nombre (o, si no tiene, el
  -- teléfono) y teléfono, con los topes de las columnas.
  v_customer_phone := left(coalesce(nullif(btrim(v_contact_phone), ''), '-'), 30);
  v_customer_name := left(coalesce(nullif(btrim(v_contact_name), ''), v_customer_phone), 120);

  PERFORM pg_advisory_xact_lock(hashtextextended('orders:' || p_account_id::text, 0));
  SELECT coalesce(max(number), 1000) + 1 INTO v_number FROM orders WHERE account_id = p_account_id;

  -- ::numeric primero: un 2.0 de JSON llega como '2.0' y ::int directo fallaría.
  SELECT coalesce(sum(((i->>'quantity')::numeric)::int * (i->>'unit_price')::numeric), 0)
    INTO v_subtotal FROM jsonb_array_elements(p_items) AS i;

  INSERT INTO orders (account_id, number, contact_id, customer_name, customer_phone,
    conversation_id, subtotal, shipping, total,
    currency, payment_status, paid_at, city, address, id_number, notes, created_by)
  VALUES (p_account_id, v_number, p_contact_id, v_customer_name, v_customer_phone,
    p_conversation_id, v_subtotal, v_shipping,
    v_subtotal + v_shipping, v_currency,
    CASE WHEN v_paid THEN 'paid' ELSE 'pending' END, CASE WHEN v_paid THEN now() END,
    nullif(btrim(v_fields->>'city'), ''), nullif(btrim(v_fields->>'address'), ''),
    nullif(btrim(v_fields->>'id_number'), ''), nullif(btrim(v_fields->>'notes'), ''),
    auth.uid())
  RETURNING * INTO v_order;

  INSERT INTO order_items (order_id, account_id, name, quantity, unit_price, position)
  SELECT v_order.id, p_account_id, btrim(i->>'name'), ((i->>'quantity')::numeric)::int,
         (i->>'unit_price')::numeric, (ord - 1)::int
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ord);

  RETURN v_order;
END
$$;

ALTER FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb) TO authenticated, service_role;

-- ============================================================
-- Validación manual (además de supabase/ci/verify-schema.sql):
--
--   Activar Ventas en una cuenta (operador, SQL Editor):
--     UPDATE accounts SET modules = array_append(modules, 'ventas')
--     WHERE id = '<cuenta>' AND NOT ('ventas' = ANY(modules));
--
--   Como AGENT (JWT vía PostgREST):
--     POST /rest/v1/rpc/create_order { p_account_id, p_contact_id, … }
--       → 201 con el pedido #1001 (y #1002 en la siguiente llamada)
--     PATCH /rest/v1/orders?id=eq.<id> { "status": "shipped", … }   → 200
--     PATCH /rest/v1/orders?id=eq.<id> { "total": 1 }               → 42501
--     PATCH /rest/v1/orders?id=eq.<id> { "status": "new" } (enviado) → 42501
--     POST  /rest/v1/orders { … }  (insert directo)                 → 42501
--     DELETE /rest/v1/orders?id=eq.<id>                             → 0 filas
--   Como AGENT con un contacto de OTRA cuenta:
--     create_order(...)                                             → 23503
--   Como AGENT de OTRA cuenta o VIEWER: create_order(...)           → 42501
--   Cuenta sin el módulo: create_order(...)                         → P0001
-- ============================================================
