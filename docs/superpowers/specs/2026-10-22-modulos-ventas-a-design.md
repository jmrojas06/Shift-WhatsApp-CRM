# Módulos combinables + Ventas A (pedidos sin catálogo)

Fecha: 22/10/2026 · Estado: diseño aprobado en conversación, pendiente de revisión escrita.
Depende de: Fase 1 de la Agenda (`2026-10-22-agenda-calendario-design.md`) mergeada.

## 1. Objetivo

Que cualquier negocio que vende por WhatsApp (joyería, ropa, comida, tiendas) pueda **registrar
sus ventas en el CRM** sin cambiar cómo vende hoy: el asesor sigue atendiendo en el chat y, al
cerrar, crea el pedido en dos clics. El negocio ve cuánto vende por WhatsApp, qué falta por pagar
y qué ya salió, y el cliente recibe los avisos de estado solo.

Ventas es un **módulo opcional**: lo activa quien lo quiera y puede convivir con la Agenda.

Caso de referencia: Águila Dorada (joyería; demo activa en la cuenta de prueba). Su flujo actual
saluda, clasifica (detal / mayorista / asesor), etiqueta y pasa a una persona; la venta ocurre a
mano y el CRM no registra producto, monto, pago ni envío.

### Fuera de alcance (Ventas B y C)

- B: catálogo con fotos y precios, variantes, carrito en el chat, link de pago (Wompi, Bold o
  Mercado Pago) con confirmación automática, comprobantes por foto aprobados por el asesor,
  carritos abandonados, paso "crear pedido" dentro de los flujos.
- C: precios por volumen y mínimos de mayorista, cotizaciones, reportes de ventas, conexión con
  la web o el POS del negocio (depende de que el negocio dé acceso a su sistema).

## 2. Módulos combinables

### 2.1 Modelo

- Columna nueva `accounts.modules text[] NOT NULL DEFAULT '{}'`, con CHECK de que cada valor
  cumpla `^[a-z0-9_-]{1,40}$`. Valores hoy: `agenda`, `ventas`.
- Migración: `modules = ARRAY[vertical_key]` donde `vertical_key` no es NULL (con `barberia`
  normalizado a `agenda`).
- `vertical_key` **se mantiene** un tiempo por compatibilidad; el código lee `modules`. Cuando
  todo lea `modules`, una migración posterior lo elimina (no en esta fase).
- La protección de 050 (el cliente no puede cambiar `vertical_key`) se extiende a `modules`: solo
  Shift (operador, rol de servicio) activa o desactiva módulos.

### 2.2 Código

- `src/lib/verticals/registry.ts`: `getAccountModules(account)` devuelve las claves canónicas
  activas (lee `modules`; si está vacío, cae a `vertical_key` con el alias). El menú lateral
  muestra una entrada por módulo con manifest.
- Dispatcher del webhook: recorre los módulos activos que tienen bot. En Ventas A **solo la
  Agenda tiene bot**, así que el comportamiento no cambia. (Cómo repartir un mensaje entre dos
  bots se decide en Ventas B.)
- Cada módulo vive en `src/modules/<clave>/` a partir de Ventas (la Agenda se queda en
  `src/verticals/agenda/` hasta un renombre posterior, para no mezclar cambios).

## 3. Ventas A

### 3.1 Datos (migración nueva, número siguiente a 051)

`orders`

| Columna | Tipo | Nota |
| --- | --- | --- |
| id | uuid PK | |
| account_id | uuid FK accounts | |
| number | integer | Consecutivo por cuenta, desde 1001. `UNIQUE (account_id, number)` |
| contact_id | uuid FK contacts | |
| conversation_id | uuid FK conversations, null | |
| deal_id | uuid FK deals, null | Negocio en el pipeline Ventas |
| subtotal, shipping, total | numeric(12,2) | `total = subtotal + shipping` (CHECK) |
| currency | text | De la cuenta (`default_currency`) |
| payment_status | text | `pending` · `paid` |
| status | text | `new` · `shipped` · `delivered` · `cancelled` |
| city, address | text | Obligatorios si el pedido se envía |
| id_number | text, null | Cédula, opcional (dato personal: ver §6) |
| carrier, tracking_number | text, null | Se piden al marcar "enviado" |
| notes | text, null | |
| created_by | uuid FK auth.users | |
| paid_at, shipped_at, delivered_at, cancelled_at | timestamptz, null | |
| created_at, updated_at | timestamptz | |

`order_items`: `id, order_id, account_id, name (texto libre), quantity (>0), unit_price (>=0),
position`. En Ventas B se agrega `product_id` (null) sin romper nada.

`sales_settings` (una fila por cuenta): `notify_paid`, `notify_shipped`, `notify_delivered`
(boolean, default true).

Número consecutivo: función `next_order_number(account_id)` con `pg_advisory_xact_lock` por cuenta
dentro de la misma transacción del insert (dos pedidos a la vez nunca repiten número).

RLS (patrón 017/050): miembros leen; **agent** o más crean y cambian estado (los asesores son
quienes venden); nadie borra (se cancela). `sales_settings`: solo owner/admin escriben.

### 3.2 Estados y pipeline "Ventas"

Al activar el módulo, un instalador crea el pipeline **Ventas** con etapas:
Nuevo → Pago pendiente → Pagado → Enviado → Entregado, más **Cancelado**.

| Pedido | Etapa del negocio |
| --- | --- |
| creado, `payment_status = pending` | Pago pendiente |
| `payment_status = paid`, `status = new` | Pagado |
| `status = shipped` | Enviado |
| `status = delivered` | Entregado |
| `status = cancelled` | Cancelado |

Crear el pedido crea el negocio (título "Pedido #1001", valor = total, moneda de la cuenta) y
guarda `deal_id`. Cada cambio de estado mueve el negocio. Si el pipeline o la etapa no existen
(el dueño los borró), el pedido se guarda igual y se registra un aviso; el pedido manda.

Transiciones válidas: `new → shipped → delivered`; `cancelled` desde `new` o `shipped`;
`payment_status pending → paid` en cualquier estado no cancelado. Un pedido entregado o cancelado
no se reabre (se crea otro).

### 3.3 "Crear pedido" en el inbox

- Botón en el panel lateral del contacto (`src/components/inbox/contact-sidebar.tsx`), visible
  si la cuenta tiene el módulo Ventas y el usuario es agent o más.
- Formulario: líneas (producto en texto libre, cantidad, precio unitario; agregar/quitar),
  envío, total calculado, ciudad, dirección, cédula (opcional), notas, "¿ya pagó?".
- El nombre y el teléfono salen del contacto; no se vuelven a pedir.
- Al guardar: pedido + negocio + (si se marcó pagado y la pieza está prendida) aviso de pago.
- El panel lateral muestra los pedidos del contacto (número, total, estados) con enlace a
  `/ventas`.

### 3.4 Pestaña `/ventas`

- Lista de pedidos, más reciente primero; filtros: pendientes de pago · pagados por enviar ·
  enviados · entregados · cancelados; búsqueda por número o cliente.
- Arriba: **vendido este mes** (suma de pedidos pagados del mes, zona America/Bogota), número de
  pedidos y pendiente por cobrar.
- Acciones por pedido con un clic: marcar pagado, marcar enviado (pide transportadora y guía),
  marcar entregado, cancelar (pide confirmación). Ver detalle con sus líneas.
- Configuración (owner/admin): los 3 interruptores de avisos.

### 3.5 Mensajes de estado al cliente

| Evento | Texto (ventana de 24 h abierta) | Plantilla de Meta (ventana cerrada) |
| --- | --- | --- |
| Pagado | "¡Recibimos tu pago! Tu pedido #{n} está confirmado. Te avisamos cuando salga. 🙌" | `pedido_pagado` (1: negocio, 2: número) |
| Enviado | "Tu pedido #{n} salió 📦. Transportadora: {carrier}. Guía: {guía}." | `pedido_enviado` (1: número, 2: transportadora, 3: guía) |
| Entregado | "Tu pedido #{n} fue entregado. ¡Gracias por comprarnos! 🙌" | `pedido_entregado` (1: número) |

- Mismo mecanismo que los recordatorios de la Agenda: si el cliente escribió en las últimas 24 h
  se envía texto; si no, la plantilla. Las 3 plantillas las crea el usuario en WhatsApp Manager
  (categoría utilidad); mientras no estén aprobadas, fuera de la ventana el aviso se omite y el
  pedido muestra "aviso no enviado".
- Cada envío queda registrado en la conversación como mensaje saliente del sistema.
- Un fallo de envío nunca deshace el cambio de estado; se muestra en el pedido.

## 4. API

Bajo `src/app/api/modules/ventas/`:

- `POST /orders` — crea pedido (agent+). Validación pura en `src/modules/ventas/orders.ts`
  (líneas 1–50, cantidades enteras > 0, precios ≥ 0, textos con tope, total recalculado en el
  servidor: nunca se confía en el total del navegador).
- `PATCH /orders/[id]` — `{ action: 'mark_paid' | 'mark_shipped' | 'mark_delivered' | 'cancel', carrier?, tracking_number? }` (agent+), aplica la tabla de transiciones.
- `PATCH /settings` — avisos (admin+).
- Todas comprueban que la cuenta tenga el módulo `ventas` (409 si no).

## 5. Pruebas

- Unitarias: validación de pedido y total, transiciones, mapeo estado → etapa, textos de avisos,
  elección texto/plantilla.
- Rutas: permisos por rol, módulo apagado → 409, aislamiento por cuenta, total recalculado.
- Base: consecutivo sin repetidos con dos inserts simultáneos (prueba SQL en
  `supabase/ci/verify-schema.sql` o test de integración), RLS de las tablas nuevas.
- Manual con la cuenta smoke / Águila Dorada demo: crear pedido desde el inbox, marcar pagado,
  enviado con guía y entregado; verificar avisos y pipeline. Recordar que `.env.local` es
  producción: datos marcados y limpieza al final.

## 6. Riesgos y temas a revisar

- **Cédula y dirección son datos personales** (Ley 1581): la cédula es opcional, no se muestra en
  listas y se marca para revisar con abogado; aviso de privacidad del negocio.
- Plantillas de Meta: aprobación y costo de cada aviso fuera de la ventana.
- El dueño puede borrar o renombrar el pipeline Ventas: el pedido no depende de él (§3.2).
- `modules` + `vertical_key` conviviendo: un solo lugar decide los módulos (`getAccountModules`).

## 7. Decisiones tomadas

- Módulos combinables por cuenta; los activa Shift.
- Ventas A = pedido desde el inbox + pestaña `/ventas` + avisos de estado + pipeline Ventas
  automático. Sin catálogo ni pagos en línea.
- Pagos en Ventas A: el asesor marca "pagado" (transferencia, Nequi, efectivo, etc.).
- Se construye después de la Fase 1 de la Agenda, en su propia rama, empezando por la migración a
  módulos.
