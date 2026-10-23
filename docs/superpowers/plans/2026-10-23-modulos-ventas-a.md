# Módulos combinables + Ventas A — plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: superpowers:subagent-driven-development (recomendado) o
> superpowers:executing-plans. Pasos con casillas (`- [ ]`).

**Objetivo:** que una cuenta pueda tener varios módulos activos (Agenda, Ventas…) y que el módulo
**Ventas** registre pedidos hechos por WhatsApp: crear pedido desde el inbox, pestaña `/ventas`,
avisos de estado al cliente y pipeline "Ventas" automático.

**Diseño:** `docs/superpowers/specs/2026-10-22-modulos-ventas-a-design.md` (aprobado).

**Arquitectura:** `accounts.modules text[]` (migración 053) reemplaza a `vertical_key` como fuente
de verdad (se mantiene `vertical_key` por compatibilidad). El registro de verticales pasa a
"módulos": cada módulo tiene manifest (menú) y, opcionalmente, un handler de bot. Ventas vive en
`src/modules/ventas/` con su migración (054), dominio puro, repositorio, rutas
`/api/modules/ventas/*`, avisos por WhatsApp (mismo patrón que los recordatorios de la agenda) y
UI (`/ventas` + botón en el inbox).

**Tecnología:** Next.js 16 (leer `node_modules/next/dist/docs/` ante dudas; ver AGENTS.md),
TypeScript, Supabase/Postgres con RLS, Vitest, WhatsApp Cloud API.

**Reglas para todo el plan**
- Rama `feat/ventas-a` en el worktree `Shift-WhatsApp-CRM-fase1`. Commits pequeños que terminan
  con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca push sin OK del usuario.
- Archivos CRLF: editar con Edit/Write, nunca `sed -i`.
- `.env.local` apunta a **producción**: no correr bot/cron contra datos reales; migraciones nunca
  se aplican desde aquí (las aplica el usuario o con su OK).
- Copy en español colombiano, tuteo, neutro; nunca "de Cali"; nada de inventar datos.
- TDD: test primero, verlo fallar, implementar, verlo pasar.

---

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `supabase/migrations/053_account_modules.sql` | `accounts.modules`, backfill, protección en el trigger de 050 |
| `supabase/migrations/054_ventas.sql` | `orders`, `order_items`, `sales_settings`, `create_order()`, RLS |
| `supabase/ci/verify-schema.sql` | Chequeos de 053/054 |
| `src/lib/verticals/{types,registry,dispatch}.ts` | Claves de módulo, `getAccountModules`, nav por módulo |
| `src/hooks/use-auth.tsx`, `src/components/layout/sidebar.tsx` | Leer `modules`, una entrada de menú por módulo |
| `src/lib/modules/require-module.ts` | Guarda server-side: la cuenta tiene el módulo |
| `src/modules/ventas/manifest.ts` | Menú "Ventas" (`/ventas`, icono ShoppingBag) |
| `src/modules/ventas/orders.ts` | Dominio puro: validación, totales, transiciones, etapa del pipeline |
| `src/modules/ventas/texts.ts` | Todo el copy de Ventas (panel + avisos) |
| `src/modules/ventas/repo.ts` | Crear pedido (RPC), cambiar estado, ajustes, pipeline y negocio |
| `src/modules/ventas/notify.ts` | Avisos al cliente (texto en ventana de 24 h, plantilla fuera) |
| `src/app/api/modules/ventas/**` | Rutas `orders`, `orders/[id]`, `settings` |
| `src/app/(dashboard)/ventas/**` | Pestaña de pedidos |
| `src/components/inbox/contact-sidebar.tsx` + `src/components/inbox/create-order-dialog.tsx` | Crear pedido y pedidos del contacto |
| `messages/*.json` | Clave de menú `ventas` |
| `docs/ventas.md`, `docs/agenda-despliegue-fase1.md` (o nuevo runbook) | Uso, plantillas de Meta, despliegue |

---

### Task 1: Módulos combinables (053 + código)

**Migración `053_account_modules.sql`** (idempotente, aditiva):

```sql
SET LOCAL lock_timeout = '5s';

-- Clave de módulo válida (misma forma que vertical_key).
CREATE OR REPLACE FUNCTION public.valid_module_keys(keys text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(k ~ '^[a-z0-9_-]{1,40}$'), true) FROM unnest(keys) AS k
$$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS modules text[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_modules_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_modules_check CHECK (public.valid_module_keys(modules));

-- Backfill: la agenda (o su clave vieja) pasa a la lista.
UPDATE accounts SET modules = array_append(modules, 'agenda')
WHERE vertical_key IN ('agenda', 'barberia') AND NOT ('agenda' = ANY(modules));
```

Extender `public.enforce_account_protected_columns()` (CREATE OR REPLACE, mismo cuerpo de 050) para
que también bloquee cambios de `modules` cuando `current_user IN ('authenticated','anon')`.

**Código:**
- `types.ts`: `ModuleKey = 'agenda' | 'ventas'` (mantener `VerticalKey` como alias de tipo si se
  usa en otros lados), `AGENDA_VERTICAL_KEYS` sigue.
- `registry.ts`: `getAccountModules(account: { modules?: string[] | null; vertical_key?: string | null }): ModuleKey[]`
  — usa `modules` si trae algo; si está vacío o ausente, cae a `normalizeVerticalKey(vertical_key)`;
  dedup, solo claves conocidas, orden estable (agenda, ventas). `getModulesNav(account)` devuelve
  las entradas de menú. `hasModule(account, key)`. Mantener `getVerticalManifest`/`isAgendaVerticalKey`
  para no romper lo existente.
- `use-auth.tsx`: seleccionar también `modules` (tolerar que la columna no exista: hoy ya hay un
  fallback cuando `vertical_key` no existe — seguir ese patrón).
- `sidebar.tsx`: usa `getModulesNav(account)`.
- `dispatch.ts`: lee `modules, vertical_key`; recorre los módulos con handler (hoy solo agenda);
  comportamiento idéntico al actual para cuentas de agenda.
- `src/lib/modules/require-module.ts`: `requireModule(ctx, key)` server-side que lee la cuenta con
  el cliente del usuario y lanza un error que las rutas traducen a 409 "El módulo X no está activo
  para esta cuenta."
- Todos los lugares que hoy comprueban la agenda con `isAgendaVerticalKey(account.vertical_key)`
  pasan a `hasModule(account, 'agenda')` (que contempla ambas columnas). El cron de recordatorios
  filtra cuentas con `modules @> '{agenda}'` **o** `vertical_key IN (...)`.
- `messages/*.json`: `Sidebar.ventas` (es "Ventas", en "Sales", pt "Vendas", ko "판매").
- Manifest de ventas (`src/modules/ventas/manifest.ts`) registrado en el registro (sin handler).

**Tests:** registry (modules vs vertical_key, vacíos, desconocidos, dedup, orden), dispatch (cuenta
con modules ['agenda','ventas'] sigue usando el bot de agenda; cuenta solo ventas → no consumido),
sidebar helpers, `requireModule`, reminders con `modules`. `verify-schema.sql`: columna, CHECK,
función, trigger protege `modules` (pg_get_functiondef LIKE '%modules%').

Commit: `feat(modules): combinable account modules`.

---

### Task 2: Base de datos de Ventas (054)

```sql
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 1001),
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

CREATE TABLE IF NOT EXISTS sales_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  notify_paid boolean NOT NULL DEFAULT true,
  notify_shipped boolean NOT NULL DEFAULT true,
  notify_delivered boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

RLS (patrón 017/050/051):
- `orders`, `order_items`: SELECT miembro; INSERT/UPDATE `agent` (con WITH CHECK); **sin DELETE**.
- `sales_settings`: SELECT miembro; INSERT/UPDATE/DELETE `admin`.
- Triggers `set_updated_at` en `orders` y `sales_settings`.

Función de creación atómica (SECURITY INVOKER: respeta RLS del usuario):

```sql
CREATE OR REPLACE FUNCTION public.create_order(
  p_account_id uuid, p_contact_id uuid, p_conversation_id uuid,
  p_items jsonb, p_shipping numeric, p_currency text,
  p_paid boolean, p_fields jsonb
) RETURNS orders
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_number integer;
  v_subtotal numeric(12,2);
  v_order orders;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('orders:' || p_account_id::text, 0));
  SELECT coalesce(max(number), 1000) + 1 INTO v_number FROM orders WHERE account_id = p_account_id;
  SELECT coalesce(sum((i->>'quantity')::int * (i->>'unit_price')::numeric), 0)
    INTO v_subtotal FROM jsonb_array_elements(p_items) AS i;
  INSERT INTO orders (account_id, number, contact_id, conversation_id, subtotal, shipping, total,
    currency, payment_status, paid_at, city, address, id_number, notes, created_by)
  VALUES (p_account_id, v_number, p_contact_id, p_conversation_id, v_subtotal, p_shipping,
    v_subtotal + p_shipping, p_currency,
    CASE WHEN p_paid THEN 'paid' ELSE 'pending' END, CASE WHEN p_paid THEN now() END,
    p_fields->>'city', p_fields->>'address', p_fields->>'id_number', p_fields->>'notes', auth.uid())
  RETURNING * INTO v_order;
  INSERT INTO order_items (order_id, account_id, name, quantity, unit_price, position)
  SELECT v_order.id, p_account_id, i->>'name', (i->>'quantity')::int, (i->>'unit_price')::numeric,
         (ord - 1)::int
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ord);
  RETURN v_order;
END $$;
REVOKE ALL ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_order(uuid,uuid,uuid,jsonb,numeric,text,boolean,jsonb) TO authenticated, service_role;
```

(El `max()+1` va dentro del lock por cuenta: dos pedidos simultáneos nunca repiten número. El
servidor valida todo antes de llamar; los CHECK de la base son la última red.)

`verify-schema.sql`: tablas, RLS activa, sin política DELETE en orders/order_items, UNIQUE
(account_id, number), CHECK del total, función con grants correctos (anon sin EXECUTE).
Test de migración (estilo `rls-policies.test.ts`): políticas y ausencia de DELETE.

Commit: `feat(db): sales orders, items and settings (054)`.

---

### Task 3: Dominio puro de Ventas (`src/modules/ventas/orders.ts`, `texts.ts`)

- `validateOrderCreate(input)` → `{ contactId, conversationId|null, items[1..50]{name 1–120 (sin
  caracteres de control), quantity entero 1–9999, unitPrice ≥0 ≤ 99.999.999,99}, shipping ≥0,
  paid boolean, city ≤80, address ≤200, idNumber ≤20 (solo dígitos, puntos, guiones, letras),
  notes ≤500 }` con mensajes en español. **El total nunca viene del cliente.**
- `orderTotals(items, shipping)` (aritmética en centavos enteros para no perder precisión).
- `applyOrderAction(order, action, extra)` puro: `mark_paid` (pending→paid; no si cancelled),
  `mark_shipped` (new→shipped; exige carrier y tracking), `mark_delivered` (shipped→delivered),
  `cancel` (new|shipped→cancelled). Devuelve el patch (con `*_at`) o error en español.
- `pipelineStageFor(order)`: Pago pendiente / Pagado / Enviado / Entregado / Cancelado.
- `noticeFor(action)` → `'paid'|'shipped'|'delivered'|null`.
- `texts.ts`: copy del panel y de los avisos (texto libre y variables de plantilla): ver diseño
  §3.5. Funciones puras con número, transportadora, guía y nombre del negocio.

Tests exhaustivos (límites, decimales, transiciones válidas/ inválidas, idempotencia de acciones
repetidas: marcar pagado dos veces → error claro o no-op documentado — elegir no-op sin aviso).

Commit: `feat(ventas): order domain rules`.

---

### Task 4: Repositorio, pipeline "Ventas" y negocio (`src/modules/ventas/repo.ts`)

- `ensureSalesPipeline(db, accountId)`: crea (si no existe por nombre "Ventas", sin importar
  mayúsculas) el pipeline con etapas Nuevo, Pago pendiente, Pagado, Enviado, Entregado, Cancelado;
  rellena etapas faltantes. Idempotente. Usa el mismo patrón que el instalador de la agenda.

  > **Nota posterior (5364167):** la etapa «Nuevo» ya no se crea (ningún pedido la usaba). Etapas
  > actuales: Pago pendiente, Pagado, Enviado, Entregado, Cancelado; un pipeline que ya tenga
  > «Nuevo» la conserva sin usarla. El pipeline se crea con el primer pedido. Ver §8 del diseño.
- `createOrder(db, ctx, input)`: llama RPC `create_order`; luego (best-effort, nunca deshace el
  pedido) crea el negocio en el pipeline Ventas (título `Pedido #N`, valor = total, moneda,
  contacto, conversación, etapa según `pipelineStageFor`) y guarda `deal_id`. Si falla el negocio,
  log y sigue.
- `updateOrderStatus(db, ctx, orderId, action, extra)`: carga el pedido de la cuenta (404 si no),
  aplica `applyOrderAction`, update con filtro de cuenta, mueve el negocio de etapa (best-effort).
- `getSalesSettings` / `saveSalesSettings` (upsert parcial).
- Todos los errores de PostgREST se lanzan (500); `ConfigError`-like para 404/409.

Tests con el fake de Supabase del repo (ampliarlo con `rpc` si hace falta, documentado).

Commit: `feat(ventas): orders repository, sales pipeline and deals`.

---

### Task 5: Rutas API (`src/app/api/modules/ventas/**`)

- `POST /orders` — `requireRole('agent')` + `requireModule('ventas')` + `validateOrderCreate`;
  verifica que el contacto (y la conversación, si viene) sean de la cuenta; crea; si `paid` y la
  pieza `notify_paid` está prendida → aviso (Task 6). Respuesta `{ order }`.
- `PATCH /orders/[id]` — `{ action, carrier?, tracking_number? }`, agent+; aplica; aviso según
  ajustes; respuesta `{ order, notice: 'sent'|'skipped'|'failed' }`.
- `PATCH /settings` — admin+; tres booleanos.
- Mismo arnés de tests que las rutas de la agenda (`route-testing`): roles, módulo apagado → 409,
  cuenta ajena → 404, total recalculado (un `total` en el body se ignora), validaciones 400.

Commit: `feat(ventas): orders API`.

---

### Task 6: Avisos al cliente (`src/modules/ventas/notify.ts`)

- `sendOrderNotice(db, order, kind)` — mismo mecanismo que `sendAgendaReminder`: si el cliente
  escribió en las últimas 24 h → texto libre por el sender de flujos; si no → plantilla de Meta
  (`pedido_pagado` 1: negocio 2: número; `pedido_enviado` 1: número 2: transportadora 3: guía;
  `pedido_entregado` 1: número; idioma `es`) con `sendTemplateMessage` + persistencia del saliente
  como hace reminders-send. Guarda `last_notice` y `last_notice_error` en el pedido. Nunca lanza
  hacia la ruta (devuelve el resultado).
- Respeta `WHATSAPP_TEMPLATES_DRY_RUN` si el resto del código lo respeta.
- Tests con senders falsos: ventana abierta → texto; cerrada → plantilla con variables correctas;
  error de Meta → `failed` y `last_notice_error`; ajuste apagado → `skipped`.

> **Nota posterior (5364167):** el texto libre ya no tiene redacción propia: es el cuerpo de la
> plantilla (`NOTICE_TEMPLATE_BODIES`) con sus variables puestas, así que dentro y fuera de la
> ventana el cliente lee lo mismo. El aviso de pago ya no dice «te avisamos cuando salga»
> (contraentrega) y `pedido_enviado` lleva más texto fijo. `WHATSAPP_TEMPLATES_DRY_RUN` no aplica a
> los avisos (ningún envío de mensajes lo mira). Ver §8 del diseño y `docs/ventas.md`.

Commit: `feat(ventas): order status notices`.

---

### Task 7: UI — inbox y `/ventas`

- **Inbox** (`contact-sidebar.tsx`): si la cuenta tiene el módulo ventas y el rol es agent+,
  botón "Crear pedido" que abre `create-order-dialog.tsx`: líneas (producto, cantidad, precio;
  agregar/quitar), envío, total calculado en vivo (solo de muestra; el servidor recalcula), ciudad,
  dirección, cédula (opcional, con nota de dato personal), notas, "¿Ya pagó?". Debajo, lista de
  pedidos del contacto (número, total, estados) con enlace a `/ventas`.
- **`/ventas`**: resumen arriba (vendido este mes — pagados, zona America/Bogota; número de pedidos;
  pendiente por cobrar), filtros (pendientes de pago, pagados por enviar, enviados, entregados,
  cancelados), búsqueda por número o cliente, lista con acciones de un clic (marcar pagado, marcar
  enviado → diálogo transportadora + guía, marcar entregado, cancelar con confirmación), detalle
  con líneas, indicador si el último aviso falló. Configuración (admin): tres interruptores de avisos.
  Mensaje claro si falta la migración (mismo helper `isMissingMigrationError`).
- Diseño: mismos componentes del panel (Card, Badge, Dialog, Switch, Alert), responsive, accesible
  (labels, aria, roles de alertas), montos con el formateador de moneda de la cuenta.
- Helpers puros extraídos y probados (resumen del mes, filtros, formato de línea).

Commit(s): `feat(ventas): create order from the inbox`, `feat(ventas): sales page`.

---

### Task 8: Documentación y cierre

- `docs/ventas.md`: qué hace Ventas A, cómo activarlo (operador:
  `update accounts set modules = array_append(modules, 'ventas') where id = '…' and not ('ventas' = any(modules));`),
  uso del inbox y de `/ventas`, avisos y **las 3 plantillas de Meta** (texto, variables, categoría
  utilidad, idioma `es`) como paso manual, datos personales (cédula/dirección → Ley 1581, revisar
  con abogado).
- Runbook de despliegue: aplicar 053 → 054 → desplegar → verify-schema → activar Ventas en la cuenta
  smoke → prueba con datos marcados → limpieza.
- Verificación completa: typecheck, lint, tests, build (env de mentira).

Commit: `docs(ventas): usage, templates and deployment`.

---

## Autorrevisión contra el diseño

| Diseño | Tarea |
| --- | --- |
| §2 Módulos combinables, activa Shift, menú por módulo | 1 |
| §3.1 Datos, número consecutivo sin repetidos, RLS, sin borrar | 2 |
| §3.2 Estados, transiciones, pipeline Ventas, el pedido manda | 3, 4 |
| §3.3 Crear pedido en el inbox, pedidos del contacto | 5, 7 |
| §3.4 Pestaña /ventas, resumen, filtros, acciones, ajustes | 7 |
| §3.5 Avisos texto/plantilla, fallos visibles | 6, 7 |
| §4 API y validación con total del servidor | 3, 5 |
| §5 Pruebas | todas |
| §6 Riesgos (datos personales, plantillas) | 8 |
