# Despliegue de Ventas A — runbook

Pasos, en orden, para sacar a producción los **módulos combinables**
(migración **053**) y el módulo **Ventas** (migración **054**), activarlo
en la cuenta smoke, probarlo con datos marcados y limpiar. Cómo se usa
Ventas y las plantillas de Meta: `docs/ventas.md`.

> **Importante:** `.env.local` apunta a la base de **producción**.
> Cualquier prueba local que escriba datos escribe en producción. No hay
> staging. Nunca uses `supabase db push`: las migraciones se aplican a
> mano, una por una, en el SQL Editor.

## Resumen del orden

| # | Qué | Dónde | Quién |
| --- | --- | --- | --- |
| 0 | Comprobar que la **050** está aplicada | Supabase → SQL Editor | Usuario |
| 1 | Guardar la lista de cuentas con su `vertical_key` | SQL Editor | Usuario |
| 2 | Aplicar **053** y verificarla | SQL Editor | Usuario |
| 3 | Aplicar **054** y verificarla | SQL Editor | Usuario |
| 4 | Correr `supabase/ci/verify-schema.sql` | SQL Editor | Usuario |
| 5 | Desplegar el código | Merge del PR a `main` → Vercel | Usuario |
| 6 | Activar Ventas en la cuenta smoke | SQL Editor | Usuario |
| 7 | Prueba manual con datos marcados | App + WhatsApp | Usuario |
| 8 | Limpieza de los datos de prueba | SQL Editor | Usuario |
| 9 | Si algo falla: cómo volver atrás | — | Usuario |

Las plantillas de Meta (`pedido_pagado`, `pedido_enviado`,
`pedido_entregado`) son un paso manual aparte, en WhatsApp Manager
(`docs/ventas.md` → «Las 3 plantillas de Meta»). No bloquean el
despliegue: sin ellas, los avisos solo salen dentro de la ventana de
24 h.

Antes de empezar:

- [ ] El PR está revisado y el CI está **verde** (typecheck, lint,
      tests, build y el workflow «Migrations», que replica todas las
      migraciones desde cero en un Postgres limpio y corre
      `verify-schema.sql`).
- [ ] La Fase 1 de la agenda (051 y 052) ya está en producción
      (`docs/agenda-despliegue-fase1.md`). `verify-schema.sql` también
      revisa esas migraciones.
- [ ] Hay un backup reciente de la base (`docs/operacion-datos-y-secretos.md`).
- [ ] Tienes a mano el SQL Editor del proyecto de **producción**.

## 0) Requisito: la 050 debe estar aplicada

La 053 **amplía** la protección de la 050: reescribe la función
`enforce_account_protected_columns()` para que también proteja
`modules`, pero **no crea el trigger** que la llama. Ese trigger
(`enforce_account_protected_columns` sobre `accounts`) lo crea la 050
(«El trigger de 050 ya apunta a esta función», dice la 053). Si la 050
no está, la 053 corre sin error pero **la protección no existe**:
cualquier admin podría cambiar sus propios módulos desde el navegador.

Comprueba:

```sql
select
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.accounts'::regclass
      and tgname = 'enforce_account_protected_columns'
      and not tgisinternal
  ) as trigger_050,
  to_regprocedure('public.enforce_account_protected_columns()') is not null as funcion_050;
```

Debe salir `true` en las dos columnas. Si sale `false`, aplica primero
`supabase/migrations/050_barberia_config_rls_and_account_guards.sql`
(es idempotente y no destructiva) y vuelve a comprobar.

## 1) Guardar la lista de cuentas

Antes de tocar nada, guarda cómo están las cuentas (sirve para revisar
el relleno de la 053 y para volver atrás):

```sql
select id, name, vertical_key
from accounts
order by name;
```

Copia el resultado (por ejemplo, en una nota) antes de seguir.

## 2) Aplicar 053 y verificarla

`supabase/migrations/053_account_modules.sql` es **aditiva** e
idempotente: agrega la función `valid_module_keys`, la columna
`accounts.modules` (lista de texto, vacía por defecto) con su
restricción, rellena `modules` con `agenda` en las cuentas cuyo
`vertical_key` es `agenda` o `barberia`, amplía la protección de la 050
a `modules` y crea el trigger `accounts_sync_modules` (abajo). No borra
ni reescribe columnas. El código viejo no la lee, así que es segura con
el código actual en producción.

**El trigger `accounts_sync_modules`.** Corre antes de guardar una fila
de `accounts`, al **crearla** o al **escribir su `vertical_key` o
`modules`**, y llama a la función `sync_account_modules_from_vertical()`:
si la cuenta tiene `vertical_key` y `modules` está **vacío**, llena
`modules` a partir de `vertical_key` (`barberia` se convierte en
`agenda`). Si `modules` ya trae algo, no lo toca. Así una cuenta dada de
alta solo con `vertical_key` recibe también `modules`, y agregarle
`ventas` después nunca le quita la agenda.

- Corre con los permisos de quien escribe (`SECURITY INVOKER`) y su
  nombre va **antes** que el guardia de la 050 (los triggers `BEFORE`
  corren en orden alfabético): si un usuario de la app manda
  `vertical_key`, el guardia ve el `modules` ya llenado y bloquea el
  cambio igual.
- **El SQL de onboarding sigue funcionando** tal cual
  (`docs/onboarding-cliente.md`): ese SQL ya pone `agenda` en `modules`,
  así que el trigger no tiene nada que llenar.
- Si se le quita a una cuenta su único módulo y la cuenta tiene
  `vertical_key`, el trigger vuelve a llenar `modules` desde
  `vertical_key`.

1. Supabase → **SQL Editor** → nueva consulta.
2. Pega esto, con el contenido de la 053 en medio:

   ```sql
   BEGIN;

   -- (aquí va todo el contenido de 053_account_modules.sql)

   COMMIT;
   ```

   La transacción es necesaria: la migración trae un
   `SET LOCAL lock_timeout = '5s'` que solo funciona dentro de una.
3. Ejecuta. Si sale `lock timeout`, una consulta larga tiene el candado
   de `accounts`: no pasó nada (la transacción se deshizo). Espera uno o
   dos minutos y reintenta.

**Verificar el relleno de `modules`:**

```sql
select id, name, vertical_key, modules
from accounts
order by name;
```

Toda cuenta con `vertical_key` `agenda` o `barberia` debe tener
`{agenda}`; el resto, `{}`. Y esta consulta debe dar **0**:

```sql
select count(*)
from accounts
where vertical_key in ('agenda', 'barberia')
  and not ('agenda' = any(modules));
```

**Verificar el trigger `accounts_sync_modules`:**

```sql
select
  to_regprocedure('public.sync_account_modules_from_vertical()') is not null as funcion_existe,
  (select prosecdef from pg_proc
   where oid = to_regprocedure('public.sync_account_modules_from_vertical()')) as security_definer,
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.accounts'::regclass
      and tgname = 'accounts_sync_modules'
      and not tgisinternal
  ) as trigger_existe;
```

Lo esperado: `funcion_existe = true`, `security_definer = false` y
`trigger_existe = true`.

Prueba en vivo (opcional; se deshace al final): vacía `modules` de la
cuenta smoke dentro de una transacción y mira cómo el trigger lo vuelve a
llenar desde `vertical_key`.

```sql
BEGIN;
update accounts set modules = '{}'
where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b';
select vertical_key, modules from accounts
where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b';   -- modules = {agenda}
ROLLBACK;
```

**Verificar la protección (estructura):**

```sql
select pg_get_functiondef('public.enforce_account_protected_columns()'::regprocedure)
       like '%NEW.modules IS DISTINCT FROM OLD.modules%' as protege_modules;
```

Debe dar `true`.

**Verificar la protección (en vivo, opcional).** Simula a un usuario de
la app (rol `authenticated`) que es dueño de la cuenta smoke e intenta
cambiar `modules`. Todo va dentro de una transacción que se deshace al
final, así que no cambia nada:

```sql
BEGIN;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select owner_user_id from accounts
            where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'),
    'role', 'authenticated'
  )::text,
  true
);
SET LOCAL ROLE authenticated;
update accounts set modules = array_append(modules, 'ventas')
where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b';
ROLLBACK;
```

Lo esperado: el `update` falla con **`owner_user_id, vertical_key and
modules cannot be changed directly…`** (código 42501). Después del error
corre `ROLLBACK;` si el editor no lo hizo. Si en vez del error sale
`UPDATE 1`, la protección **no** está activa: no sigas, revisa el paso 0
(el `ROLLBACK` deshace ese cambio de todas formas). Si sale `UPDATE 0`,
la simulación no encontró la cuenta (el dueño no figura como miembro):
la prueba no dice nada; quédate con la verificación de estructura.

## 3) Aplicar 054 y verificarla

`supabase/migrations/054_ventas.sql` es **aditiva** e idempotente: crea
las tablas `orders`, `order_items` y `sales_settings`, sus políticas de
seguridad (RLS), los triggers que protegen el libro de ventas y la
función `create_order()`. No toca tablas existentes. Depende de la 053
(`create_order` exige que la cuenta tenga `ventas` en `modules`), por eso
va después. Debe aplicarse **antes** de desplegar el código de Ventas.

1. Igual que la 053:

   ```sql
   BEGIN;

   -- (aquí va todo el contenido de 054_ventas.sql)

   COMMIT;
   ```

2. Si sale `lock timeout`, reintenta más tarde.

**Verificar las tablas:**

```sql
select to_regclass('public.orders')         as orders,
       to_regclass('public.order_items')    as order_items,
       to_regclass('public.sales_settings') as sales_settings;
```

Ninguna columna debe salir vacía (`NULL`).

**Verificar `create_order`:**

```sql
select p.oid::regprocedure            as funcion,
       p.prosecdef                    as security_definer,
       pg_get_userbyid(p.proowner)    as dueno,
       p.proconfig                    as config,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_puede,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_puede,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role_puede
from pg_proc p
where p.proname = 'create_order'
  and p.pronamespace = 'public'::regnamespace;
```

Lo esperado: **una sola fila**,
`create_order(uuid,uuid,uuid,jsonb,numeric,boolean,jsonb)`,
`security_definer = true`, dueño `postgres`, config con
`search_path=public, pg_temp`, `anon_puede = false` y las otras dos
`true`. Si sale una segunda fila con un parámetro `text` extra, quedó la
versión vieja: vuelve a correr la 054 (la borra).

> No pruebes `create_order` desde el SQL Editor: sin sesión de usuario
> (JWT) la función rechaza la llamada **a propósito** con 42501. Solo la
> llaman el backend y los agentes de la cuenta con su sesión.

**Verificar las políticas:**

```sql
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('orders', 'order_items', 'sales_settings')
order by tablename, cmd, policyname;
```

Deben salir exactamente estas siete:

| Tabla | Política | Comando |
| --- | --- | --- |
| order_items | order_items_select | SELECT |
| orders | orders_select | SELECT |
| orders | orders_update | UPDATE |
| sales_settings | sales_settings_delete | DELETE |
| sales_settings | sales_settings_insert | INSERT |
| sales_settings | sales_settings_select | SELECT |
| sales_settings | sales_settings_update | UPDATE |

`orders` y `order_items` **no** tienen INSERT ni DELETE a propósito: los
pedidos solo nacen en `create_order()` y nadie los borra desde la app
(se cancelan).

**Verificar los triggers:**

```sql
select tgrelid::regclass as tabla, tgname
from pg_trigger
where tgrelid in ('public.orders'::regclass,
                  'public.order_items'::regclass,
                  'public.sales_settings'::regclass)
  and not tgisinternal
order by 1, 2;
```

Deben salir: `order_items` → `order_items_freeze`; `orders` →
`orders_freeze_columns`, `orders_ledger_guard`, `set_updated_at`;
`sales_settings` → `set_updated_at`.

## 4) Verificar el esquema completo

Corre `supabase/ci/verify-schema.sql` completo contra producción
(SQL Editor). Debe terminar **sin errores**.

Además de 053 y 054, revisa las migraciones anteriores (050, 051, 052…).
Ojo con una verificación que solo tiene sentido en producción: **«an
agenda account has no agenda in modules»**. Falla si hay una cuenta con
`vertical_key` de agenda sin `agenda` en `modules`. Justo después de la
053 no debería pasar; si pasa, alguien activó una agenda entre el paso 2
y este. Vuelve a correr la 053 (es idempotente) y repite.

## 5) Desplegar el código

Merge del PR a `main` (nunca push directo a `main`): Vercel construye y
despliega solo. Espera a que el deploy quede en **Ready** y revisa
`https://<dominio>/api/health` → `ok: true`.

Qué cambia en la práctica:

- El código lee los módulos de `accounts.modules` y, si está vacío, cae
  a `vertical_key`. Las cuentas con agenda siguen igual.
- **Ninguna cuenta ve Ventas todavía**: el menú, el botón del inbox y
  la API solo aparecen con `ventas` en `modules`.

## 6) Activar Ventas en la cuenta smoke

Cuenta de pruebas: **Barbería Élite**,
`206d8a50-1fb4-44ab-9633-a02a2e07185b` (tiene agenda).

0. **Chequeo previo: ninguna cuenta con `vertical_key` y `modules`
   vacío.** El código lee `modules` primero y solo mira `vertical_key`
   si `modules` está vacío; una cuenta así es la que podría perder la
   agenda al recibir otro módulo. Esta consulta debe devolver **0
   filas** antes de activar Ventas en cualquier cuenta:

   ```sql
   select id, name, vertical_key, modules
   from accounts
   where vertical_key is not null
     and modules = '{}';
   ```

   Si devuelve filas de agenda (`agenda` o `barberia`), corrige con la
   misma regla del relleno de la 053 (idempotente) y repite la consulta:

   ```sql
   update accounts set modules = array_append(modules, 'agenda')
   where vertical_key in ('agenda', 'barberia')
     and not ('agenda' = any(modules));
   ```

   Si devuelve una fila con otro `vertical_key`, no sigas: revisa esa
   cuenta a mano.

1. Mira cómo está la cuenta smoke:

   ```sql
   select id, name, vertical_key, modules, default_currency
   from accounts
   where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b';
   ```

   `modules` debe traer `agenda` (del relleno de la 053).

2. Activa Ventas con la sentencia que conserva la agenda (explicada en
   `docs/ventas.md` → «Activar»; es idempotente):

   ```sql
   update accounts
   set modules = (
     select array_agg(distinct m order by m)
     from unnest(
       modules
       || case when modules = '{}' and vertical_key in ('agenda', 'barberia')
               then array['agenda'] else '{}'::text[] end
       || array['ventas']
     ) as m
   )
   where id = '206d8a50-1fb4-44ab-9633-a02a2e07185b';
   ```

3. Repite la consulta del punto 1: `modules` = `{agenda,ventas}`.
4. Entra a la app con la cuenta smoke y **recarga**: el menú muestra
   **Agenda** y **Ventas**. Revisa que la agenda siga funcionando
   (`/agenda` abre normal).

## 7) Prueba manual con datos marcados

> **Los avisos son mensajes reales de WhatsApp** si la cuenta tiene
> WhatsApp conectado (y `WHATSAPP_TEMPLATES_DRY_RUN` **no** los frena).
> Usa un **contacto cuyo teléfono sea del equipo**, nunca el de un
> cliente. Todo lo que crees lleva la marca **«PRUEBA — borrar»** para
> poder limpiarlo en el paso 8.

Preparación:

- Desde el teléfono del equipo, **escríbele al número de la cuenta**
  (por ejemplo «hola»). Así existe la conversación y la ventana de 24 h
  queda abierta: los avisos salen como **texto libre** y no necesitan
  plantilla.
- Revisa en `/ventas` que la tarjeta **«Avisos al cliente»** tenga los
  tres interruptores **prendidos** (anota si alguno estaba apagado para
  dejarlo igual al final).

Pedido principal (inbox en el **computador**):

1. Abre la conversación con el teléfono del equipo. En el panel lateral,
   **«Pedidos de este contacto»** → **Crear pedido**.
2. Llena: producto **`PRUEBA — borrar`**, cantidad `1`, precio `1000`
   (al salir del campo debe quedar `1.000`), envío `0`, ciudad
   `PRUEBA`, dirección `PRUEBA — borrar`, sin cédula, notas
   `PRUEBA — borrar`, «El cliente ya pagó» **apagado**. Guarda.
3. Debe aparecer «Pedido #NNNN creado.». Anota el número.
4. `/ventas`: el pedido sale con los estados **Pago pendiente** (pago)
   y **Nuevo** (pedido), y suma en **Pendiente por cobrar** y en
   **Pedidos este mes**.
5. Pipelines: existe el pipeline **«Ventas»** (se crea con el primer
   pedido) con sus cinco etapas (Pago pendiente, Pagado, Enviado,
   Entregado, Cancelado), y el negocio **«Pedido #NNNN»** está en
   **Pago pendiente**.
6. **Marcar pagado.** Debe decir «Pedido #NNNN actualizado. Le avisamos
   al cliente por WhatsApp.», llegar al teléfono del equipo «¡Hola!
   Barbería Élite recibió tu pago. Tu pedido #NNNN está confirmado.
   ¡Gracias por tu compra! 🙌» (con el nombre que tenga la cuenta), y el
   negocio pasar a **Pagado**. **Vendido este mes** sube en $1.000.
7. **Marcar enviado** con transportadora `PRUEBA` y guía `PRUEBA-123`.
   Llega «¡Hola! Tu pedido #NNNN ya va en camino 📦. Lo lleva PRUEBA con
   el número de guía PRUEBA-123. Puedes rastrearlo en la página de la
   transportadora.» y el negocio pasa a **Enviado**.
8. **Marcar entregado.** Llega «¡Hola! Tu pedido #NNNN fue entregado.
   ¡Gracias por comprarnos! 🙌», el negocio pasa a **Entregado** y queda
   **ganado**.

   Estos textos son los mismos de las plantillas de Meta: dentro y fuera
   de la ventana de 24 h el cliente lee lo mismo.
9. En la conversación del inbox se ven los tres avisos como mensajes
   salientes. En el detalle del pedido, la sección **«Aviso al
   cliente»** dice «Aviso de entrega mandado» y el historial tiene las
   cuatro fechas.

Pruebas cortas adicionales (recomendadas):

- **Celular:** en el teléfono (o con la ventana angosta), el botón
  **«Pedido»** del encabezado de la conversación abre la hoja con los
  pedidos del contacto.
- **Retiro en tienda y cancelación:** crea otro pedido marcado
  (`PRUEBA — borrar`), márcalo **entregado** directo desde el estado
  Nuevo del pedido (no pide guía). Crea un tercero y **cancélalo**: el negocio queda en
  **Cancelado** y **perdido**, y no sale aviso.
- **Plantillas** (solo si ya están aprobadas en Meta): espera a que
  pasen más de 24 h sin que el teléfono del equipo le escriba a la
  cuenta, crea un pedido marcado y márcalo pagado. El aviso debe llegar
  por la plantilla `pedido_pagado`, con el mismo texto del paso 6. Si
  falla, el pedido
  muestra «Aviso sin mandar» con el motivo (`docs/ventas.md` → «Aviso
  sin mandar»).
- **Roles** (si hay usuarios de prueba): un **viewer** ve `/ventas` sin
  botones de acción ni ajustes; un **agent** ve las acciones pero no la
  tarjeta de avisos.

## 8) Limpieza

Desde la app **no se puede borrar** un pedido: `orders` y `order_items`
no tienen política de borrado (RLS), así que un `DELETE` con la sesión de
un usuario no borra nada. La limpieza se hace en el **SQL Editor**, que
corre como `postgres`.

**Por qué no la frenan los triggers de 054:** los tres
(`orders_freeze_columns`, `orders_ledger_guard` y `order_items_freeze`)
son `BEFORE UPDATE`, ninguno es de `DELETE`, y además solo rechazan
cuando quien escribe es `authenticated` o `anon`. Como `postgres`, la RLS
tampoco aplica. Las líneas (`order_items`) se borran solas con el pedido
(`ON DELETE CASCADE`). Se borran primero los pedidos y después sus
negocios, así el `ON DELETE SET NULL` de `orders.deal_id` no tiene filas
que actualizar.

**Qué cuenta como pedido de prueba:** un pedido de la cuenta smoke en el
que **todas** sus líneas se llaman `PRUEBA … borrar` (con raya o guion,
sin importar mayúsculas). Un pedido real con una línea de prueba
mezclada **no** se toca.

1. **Revisa** qué se va a borrar (solo lee):

   ```sql
   select o.id, o.number, o.customer_name, o.status, o.payment_status,
          o.total, o.deal_id, o.created_at
   from orders o
   where o.account_id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'
     and exists (select 1 from order_items i where i.order_id = o.id)
     and not exists (
       select 1 from order_items i
       where i.order_id = o.id
         and i.name not ilike 'prueba%borrar'
     )
   order by o.number;
   ```

   Deben salir **solo** los pedidos que creaste en el paso 7.

2. **Borra** pedidos, líneas y negocios, en una transacción:

   ```sql
   BEGIN;

   CREATE TEMP TABLE prueba_ventas ON COMMIT DROP AS
   select o.id, o.number, o.deal_id
   from orders o
   where o.account_id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'
     and exists (select 1 from order_items i where i.order_id = o.id)
     and not exists (
       select 1 from order_items i
       where i.order_id = o.id
         and i.name not ilike 'prueba%borrar'
     );

   -- Pedidos (sus líneas se borran en cascada).
   delete from orders
   where account_id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'
     and id in (select id from prueba_ventas);

   -- Sus negocios del pipeline Ventas.
   delete from deals
   where account_id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'
     and id in (select deal_id from prueba_ventas where deal_id is not null)
     and title like 'Pedido #%';

   COMMIT;
   ```

   Si el número de filas borradas no coincide con lo que viste en el
   punto 1, cambia `COMMIT;` por `ROLLBACK;` y revisa antes de repetir.

3. **Verifica** que no quedó nada (debe dar 0):

   ```sql
   select count(*)
   from order_items i
   join orders o on o.id = i.order_id
   where o.account_id = '206d8a50-1fb4-44ab-9633-a02a2e07185b'
     and i.name ilike 'prueba%borrar';
   ```

Qué **no** se borra, a propósito:

- **El contacto y la conversación** del teléfono del equipo: son datos
  reales del equipo.
- **Los mensajes de aviso** en esa conversación: se mandaron de verdad y
  son el historial del chat.
- **El pipeline «Ventas»:** queda vacío y se reutiliza con el próximo
  pedido. Si la cuenta smoke no lo tenía antes y no lo quieres, bórralo
  desde la pantalla de pipelines del CRM (solo si ya no tiene negocios).

Además:

- Si cambiaste algún interruptor de avisos, déjalo como estaba.
- Si borraste los pedidos con el número más alto, el siguiente pedido
  reutiliza esos números (la base toma el mayor que exista + 1).
- Decide si la cuenta smoke se queda con Ventas activo. Para apagarlo,
  ver el paso 9.

## 9) Cómo volver atrás si algo falla

Todo se vuelve atrás **sin borrar datos**. **No borres** las tablas
`orders`, `order_items` ni `sales_settings`, ni la columna
`accounts.modules`, sobre todo si ya tienen datos: un pedido es el
registro de una venta real.

- **Apagar Ventas en una cuenta** (lo más común): se quita el módulo y
  todo lo demás queda guardado.

  ```sql
  update accounts set modules = array_remove(modules, 'ventas')
  where id = '<uuid-de-la-cuenta>';
  ```

  El menú, el botón del inbox y la API dejan de estar disponibles para
  esa cuenta; los pedidos se conservan y reaparecen si se vuelve a
  activar.
- **Falla el código nuevo:** Vercel → Deployments → **Instant Rollback**
  al deploy anterior. Es seguro: la 053 y la 054 son aditivas y el código
  viejo no lee `modules` ni las tablas de ventas. Las cuentas con agenda
  siguen funcionando porque `vertical_key` no se tocó. Los pedidos
  quedan en la base, sin pantalla, hasta volver a desplegar.
- **La 053 no se revierte.** La columna `modules`, su restricción y la
  función ampliada no le hacen daño al código viejo. Dejarlas puestas es
  lo seguro.
- **La 054 no se revierte.** Las tablas nuevas no las ve nadie si ninguna
  cuenta tiene `ventas`. Si hiciera falta corregir algo de la 054, se
  hace con una migración nueva hacia adelante, no borrando.
- **Plantillas de Meta:** un rollback no las afecta. Si se apaga Ventas,
  simplemente dejan de usarse.
