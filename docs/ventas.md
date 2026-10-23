# Ventas (Ventas A) — pedidos hechos por WhatsApp

Ventas es un **módulo opcional** del CRM para negocios que venden por
WhatsApp (joyería, ropa, comida, tiendas). El asesor sigue atendiendo en
el chat como siempre y, cuando cierra la venta, **crea el pedido desde la
conversación**. El negocio ve en `/ventas` cuánto vendió, qué falta por
cobrar y qué ya salió, y el cliente recibe **avisos de estado** por
WhatsApp.

Puede convivir con la Agenda en la misma cuenta. Esta guía cubre qué
hace, cómo se activa, cómo se usa y el paso manual de las plantillas de
Meta. El despliegue está en `docs/ventas-despliegue.md`.

> Diseño: `docs/superpowers/specs/2026-10-22-modulos-ventas-a-design.md`.
> Código: `src/modules/ventas/`, `src/app/api/modules/ventas/`,
> `src/app/(dashboard)/ventas/` y `src/components/inbox/`
> (`contact-orders`, `create-order-dialog`, `mobile-orders-button`).
> Base de datos: migraciones `053_account_modules.sql` y `054_ventas.sql`.

## 1. Qué hace y qué no hace todavía

**Ventas A (esta versión):**

- Crear un pedido desde el inbox: productos en texto libre, cantidad,
  precio, envío, ciudad, dirección, cédula (opcional), notas y si ya
  pagó.
- Pestaña `/ventas`: resumen del mes, lista de pedidos con filtros y
  búsqueda, acciones de un clic (pagado, enviado, entregado, cancelar),
  detalle del pedido y los interruptores de avisos.
- Avisos al cliente por WhatsApp cuando el pedido se paga, se envía o se
  entrega.
- Pipeline **«Ventas»** automático: cada pedido es un negocio que se
  mueve solo de etapa.
- El pago lo marca el asesor a mano (transferencia, Nequi, efectivo,
  contraentrega…). El CRM no cobra ni verifica pagos.

**No hace todavía (Ventas B y C, sin fecha):**

- B: catálogo con fotos y precios, variantes, carrito en el chat, link de
  pago (Wompi, Bold o Mercado Pago) con confirmación automática,
  comprobantes de pago por foto aprobados por el asesor, carritos
  abandonados, y un paso «crear pedido» dentro de los flujos del bot.
- C: precios por volumen y mínimos de mayorista, cotizaciones, reportes
  de ventas, y conexión con la web o el POS (punto de venta) del negocio.
- Ventas **no tiene bot propio**: no responde mensajes. Solo la Agenda
  tiene bot.

## 2. Cómo se activa (lo hace Shift)

Los módulos de una cuenta viven en la columna `accounts.modules` (una
lista de texto, por ejemplo `{agenda,ventas}`), creada por la migración
053. **Solo Shift puede cambiarla.** Un trigger de la base (la regla
automática `enforce_account_protected_columns`, de la migración 050 y
ampliada en la 053) rechaza cualquier cambio a `modules` que venga del
navegador, aunque lo intente el dueño o un admin con su sesión. El SQL
Editor de Supabase corre como `postgres` y el backend con la llave de
servicio (*service role*): esos sí pueden.

### Activar

Supabase → **SQL Editor** de producción.

1. Mira cómo está la cuenta:

   ```sql
   select id, name, vertical_key, modules
   from accounts
   where id = '<uuid-de-la-cuenta>';
   ```

2. **Ojo con la Agenda.** El código decide los módulos así
   (`getAccountModules` en `src/lib/verticals/registry.ts`): si
   `modules` trae algo, **manda `modules`**; solo si está vacío mira
   `vertical_key`. Una cuenta con agenda que tenga `vertical_key =
   'agenda'` (o `'barberia'`) pero `modules` vacío (`{}`) perdería la
   Agenda (menú y bot) al quedar `modules = {ventas}`. La 053 cierra
   casi todo ese hueco: rellena `modules` en las cuentas de agenda que
   ya existían y trae el trigger `accounts_sync_modules`, que llena un
   `modules` vacío a partir de `vertical_key` cada vez que se crea una
   cuenta o se escribe su `vertical_key` o `modules` (ver
   `docs/ventas-despliegue.md`, paso 2). Aun así, la sentencia del paso
   3 no depende de eso.

3. Activa Ventas con **una sola sentencia que conserva la agenda**:

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
   where id = '<uuid-de-la-cuenta>';
   ```

   Qué hace: toma los módulos que ya tiene; si la lista está vacía y la
   cuenta usa la agenda por `vertical_key` (`agenda` o su clave vieja
   `barberia`), agrega `agenda` (la misma regla del relleno de la 053);
   suma `ventas` y quita repetidos. Es **idempotente**: si la repites,
   queda igual. Las claves resultantes (`agenda`, `ventas`) cumplen la
   restricción `valid_module_keys` de la 053.

4. Vuelve a correr la consulta del paso 1: `modules` debe traer
   `ventas` (y `agenda` si la cuenta tiene agenda).
5. Los usuarios de la cuenta ven el menú **Ventas** al recargar la
   página.

Antes de activar Ventas para un cliente: revisa la **moneda** de la
cuenta (`accounts.default_currency`, se cambia en la pestaña **Negocio**
de la agenda o en la base), porque cada pedido toma esa moneda al
crearse; y crea las **3 plantillas de Meta** en su WABA (sección 6).

### Desactivar

```sql
update accounts set modules = array_remove(modules, 'ventas')
where id = '<uuid-de-la-cuenta>';
```

Si `ventas` era el único módulo y la cuenta tiene `vertical_key`, el
trigger `accounts_sync_modules` vuelve a llenar `modules` desde
`vertical_key` (por ejemplo `{agenda}`): es lo mismo que el código
leería de todas formas.

Qué pasa al desactivar:

- Desaparece el menú **Ventas**, el botón **Crear pedido** del inbox y
  la lista de pedidos del contacto. Si alguien entra a `/ventas` por URL
  ve «Módulo no habilitado».
- La API responde **409** con el mensaje «El módulo Ventas no está
  activo para esta cuenta.» y la función `create_order()` de la base
  también rechaza pedidos nuevos. En pantalla, si una acción choca con
  eso, el panel muestra su propio texto: «El módulo de ventas no está
  activo para esta cuenta.»
- **No se borra nada**: pedidos, líneas, ajustes y el pipeline «Ventas»
  se quedan. Si se vuelve a activar, todo aparece como estaba.
- Los pedidos que estaban a medio camino no se pueden mover de estado
  mientras el módulo esté apagado, y no salen avisos.

## 3. Usar Ventas desde el inbox

Solo aparece si la cuenta tiene el módulo. **Crear pedido** es para los
roles **agent**, **admin** y **owner** (el mismo permiso que enviar
mensajes); un **viewer** no ve el botón.

### En el computador: el panel lateral del contacto

Abre la conversación. En el panel lateral del contacto aparece la
sección **«Pedidos de este contacto»**:

- botón **Crear pedido**;
- los **5 pedidos más recientes** del contacto, con número, total y
  estados. Cada uno abre su detalle en `/ventas?pedido=<número>`;
- enlace **«Ver en Ventas»**, que abre `/ventas` mostrando solo los
  pedidos de ese contacto (`/ventas?contacto=<id del contacto>`). En la
  URL va el id interno del contacto, nunca su teléfono ni su nombre
  (datos personales, Ley 1581).

Un viewer ve la lista de pedidos, pero no el botón.

### En el celular: el botón «Pedido»

En pantallas pequeñas el panel lateral no existe. En el encabezado de la
conversación aparece el botón **«Pedido»** (icono de bolsa de compras;
en pantallas muy angostas solo el icono). Abre una hoja desde abajo con
lo mismo del panel: los pedidos del contacto y **Crear pedido**. Este
botón solo lo ven agent, admin y owner.

### El formulario «Crear pedido»

- **Cliente:** el nombre y el teléfono salen del contacto; no se vuelven
  a pedir. Al guardar se **copian** al pedido (ver sección 7).
- **Productos:** nombre en texto libre (hasta 120 caracteres), cantidad
  entera (1 a 9.999) y precio unitario. **Agregar producto** suma
  líneas, hasta **50** por pedido; siempre queda al menos una.
- **Envío:** opcional; vacío cuenta como 0.
- **Subtotal y total:** se calculan en vivo como referencia. **El total
  real lo calcula la base al guardar** a partir de las líneas y el envío;
  el servidor nunca confía en el total que manda el navegador.
- **Entrega:** ciudad (hasta 80), dirección (hasta 200), cédula
  opcional (hasta 20; solo letras, números, puntos y guiones) y notas
  (hasta 500). Ciudad y dirección **no** son obligatorias al crear: se
  piden al marcar el pedido como enviado si faltan.
- **«El cliente ya pagó»:** si lo prendes, el pedido nace pagado y, con
  el aviso de pago prendido, al cliente le llega el aviso de pago.

**Cómo escribir los montos.** Sin símbolo y en formato colombiano: punto
para los miles y coma para los decimales (`150.000`, `12.000,50`). Se
admiten máximo 2 decimales. Al salir del campo, el valor **se reescribe**
como lo entendió el sistema, para que veas el número real antes de
guardar:

| Escribes | Queda |
| --- | --- |
| `150000` | `150.000` |
| `1.500` | `1.500` (mil quinientos) |
| `1,5` | `1,50` (uno y medio) |
| `0,500` | `0,50` |
| `1,234.56` | `1.234,56` (también entiende el formato gringo) |
| `$ 20.000` | `20.000` (el `$` y los espacios se ignoran) |

Regla: un solo separador seguido de exactamente 3 dígitos es de miles
(`1.500`, `1,500`); si no, es decimal (`1,5`). Con punto y coma a la vez,
el último es el decimal. Lo que no se pueda leer se deja tal cual y al
guardar sale el error en el campo.

**Más de 2 decimales no se redondea.** Si escribes `0,125` o `1.500,999`,
al salir del campo el valor **se queda tal como lo escribiste** (nunca se
redondea a escondidas) y, al guardar, el formulario marca el campo con
«el precio admite máximo 2 decimales.» (o «El envío admite máximo 2
decimales.»).

Al guardar aparece «Pedido #1001 creado.», el resultado del aviso (si
hubo) y dos botones: **Crear otro pedido** y **Listo**.

Los pedidos se numeran **por cuenta desde el 1001** (#1001, #1002…). La
base toma el número dentro de un candado por cuenta, así que dos pedidos
creados al mismo tiempo nunca repiten número.

## 4. La pestaña `/ventas`

### Resumen del mes

Tres cifras arriba, calculadas en **hora de Colombia**
(`America/Bogota`). «El mes» es el mes calendario actual en esa zona:

| Cifra | Qué suma exactamente |
| --- | --- |
| **Vendido este mes** | Suma del `total` de los pedidos **pagados y no cancelados** cuyo **pago** (`paid_at`) cae en este mes. La venta cuenta cuando se cobra, no cuando se crea ni cuando se entrega. Si un pedido pagado se cancela, deja de contar. |
| **Pedidos este mes** | Cantidad de pedidos **creados** este mes (`created_at`), **sin contar los cancelados**, estén pagados o no. |
| **Pendiente por cobrar** | Suma del `total` de los pedidos **sin pagar y no cancelados**, **de cualquier fecha** (incluye los enviados o entregados contraentrega que aún no se cobran). |

Si la cuenta tiene pedidos en varias monedas, cada moneda se suma por
separado y se muestra con su código (`$20.000 COP + US$10 USD`); nunca se
mezclan pesos con dólares.

**Límite de 1.000 filas.** Para el resumen se leen como máximo **1.000
pedidos**: los pagados o creados desde el inicio del mes, más todos los
pendientes de cobro, del más reciente al más viejo (por fecha de
creación). Si se llega al tope, quedan por fuera los más viejos y la
pantalla avisa «El resumen solo cuenta los primeros 1000 pedidos del mes:
las cifras pueden estar incompletas.».

### Lista, filtros y búsqueda

La lista trae los **500 pedidos más recientes** (por fecha de creación).
Si la cuenta tiene más, aparece «Se muestran los 500 pedidos más
recientes.» **Los filtros y la búsqueda solo trabajan sobre esos 500**:
un pedido más viejo no aparece al buscarlo (se puede abrir con
`?pedido=`).

Filtros:

| Filtro | Pedidos |
| --- | --- |
| Todos | Todos los cargados |
| Pendientes de pago | Sin pagar y no cancelados (incluye enviados o entregados contraentrega) |
| Pagados por enviar | Pagados y en estado «Nuevo» |
| Enviados | Estado «Enviado» |
| Entregados | Estado «Entregado» |
| Cancelados | Estado «Cancelado» |

Búsqueda («Buscar por número, nombre o teléfono»):

- **Nombre** del cliente, sin importar tildes ni mayúsculas.
- **Número** del pedido, con o sin `#` (busca dentro del número: `100`
  encuentra el #1001 y el #1002).
- **Teléfono**: solo cuenta los dígitos y pide al menos 4.

Enlaces directos:

- `/ventas?contacto=<id del contacto>` muestra solo los pedidos de ese
  contacto (lo usa «Ver en Ventas» del inbox). Arriba aparece un chip
  «Pedidos de <nombre>» con una ✕ para quitar el filtro; el nombre sale
  de los pedidos cargados, no de la URL. Al cerrar un detalle el filtro
  se conserva.
- `/ventas?q=<texto>` todavía llena la búsqueda si alguien lo escribe,
  pero ningún enlace de la app lo genera.
- `/ventas?pedido=<número>` abre el detalle de ese pedido, aunque no
  esté entre los 500 cargados. Al cerrar el detalle se quita del enlace.

Cada fila muestra número, cliente, fecha de creación, teléfono, total,
los estados (pago y pedido) y, si el último aviso falló, la etiqueta
**«Aviso sin mandar»**. **La cédula nunca se lee para la lista**; solo
el detalle la carga.

### Acciones y transiciones

Cada pedido muestra solo las acciones que su estado admite (las reglas
están en `applyOrderAction`, `src/modules/ventas/orders.ts`):

| Acción | Se puede desde | Qué pide | Aviso |
| --- | --- | --- | --- |
| **Marcar pagado** | Cualquier estado **no cancelado** que esté sin pagar (nuevo, enviado o entregado: sirve para la contraentrega) | Nada | Pago |
| **Marcar enviado** | Solo **Nuevo** | Transportadora y número de guía (obligatorios, hasta 60 caracteres). Si el pedido no tenía ciudad o dirección, también las pide y quedan guardadas | Envío |
| **Marcar entregado** | **Nuevo** o **Enviado**. Desde Nuevo es el **retiro en tienda** o la entrega local sin guía: no pide ciudad, dirección ni transportadora | Nada | Entrega |
| **Cancelar pedido** | **Nuevo** o **Enviado** | Confirmación («¿Cancelar el pedido #1001?») | Ninguno |

Reglas que no cambian:

- Un pedido **entregado o cancelado no se reabre**: si hace falta, se
  crea otro.
- El pago **nunca vuelve** de pagado a pendiente.
- Cancelar un pedido pagado no devuelve el dinero: «el reembolso lo
  manejas tú».
- Marcar pagado un pedido que ya está pagado no hace nada (ni aviso).
- Las fechas (pagado, enviado, entregado, cancelado) las pone el
  servidor y no se pueden cambiar después.
- Si dos personas actúan a la vez sobre el mismo pedido, la segunda ve
  «Alguien más cambió este pedido. Ya te mostramos cómo quedó.» y la
  lista se recarga. Dos clics seguidos no guardan ni avisan dos veces.

Estas reglas las aplica el servidor y, además, triggers de la base
(migración 054): aunque alguien llame la API de Supabase directo con su
sesión, no puede cambiar importes, número, cliente ni líneas, ni mover
el estado hacia atrás.

### Detalle del pedido

**Ver detalle** muestra cliente y teléfono, las líneas con subtotal,
envío y total, los datos de envío (ciudad, dirección, transportadora,
guía y **cédula**, con la nota «Dato personal: úsalo solo para el envío o
la factura.»), las notas, el historial de fechas y el estado del último
aviso al cliente.

### Roles: quién puede qué

| | viewer | agent | admin | owner |
| --- | --- | --- | --- | --- |
| Ver `/ventas`, resumen, lista y detalle (cédula incluida) | Sí | Sí | Sí | Sí |
| Ver los pedidos del contacto en el panel lateral del inbox | Sí | Sí | Sí | Sí |
| Botón «Pedido» del inbox en el celular | No | Sí | Sí | Sí |
| Crear pedidos | No | Sí | Sí | Sí |
| Marcar pagado, enviado, entregado o cancelar | No | Sí | Sí | Sí |
| Cambiar los interruptores de avisos | No | No | Sí | Sí |
| Activar o desactivar el módulo | No | No | No | No (solo Shift) |

El servidor valida el rol en cada escritura: crear y cambiar estado
exigen **agent** o más, y los ajustes **admin** o más. Nadie puede
**borrar** un pedido desde la app (se cancela).

### Si falta la migración

Si el código está desplegado pero la migración 054 no se aplicó, la
pestaña muestra «Ventas todavía no está instalado en la base de datos de
esta cuenta. Pídele a tu asesor de Shift Digital que termine la
instalación.».

## 5. El pipeline «Ventas»

Cada pedido crea un **negocio** (*deal*) en el pipeline **«Ventas»**,
con título «Pedido #1001», valor = total del pedido y la moneda del
pedido. Lo hace el sistema con permisos de servidor, así que funciona
aunque el asesor no pueda crear pipelines.

- **Cuándo se crea el pipeline:** con el **primer pedido** de la cuenta
  (no al activar el módulo). Si ya existe uno llamado «Ventas» (sin
  importar mayúsculas ni espacios), se usa ese.
- **Etapas (cinco):** Pago pendiente → Pagado → Enviado → Entregado, más
  Cancelado. Un pedido nace en «Pago pendiente» o en «Pagado», así que
  no hay etapa de pedido nuevo. Si al pipeline le falta alguna, se
  agrega al final en el siguiente pedido; las etapas propias del dueño se
  respetan. Un pipeline «Ventas» que ya tenga una etapa «Nuevo» (de una
  versión anterior) la conserva, pero ningún pedido la usa.

Cómo se mueve el negocio:

| Pedido | Etapa | Estado del negocio |
| --- | --- | --- |
| Sin pagar, sin enviar (estado del pedido «Nuevo») | Pago pendiente | Abierto |
| Pagado, sin enviar (estado del pedido «Nuevo») | Pagado | Abierto |
| Enviado (pagado o no) | Enviado | Abierto |
| Entregado | Entregado | **Ganado** |
| Cancelado | Cancelado | **Perdido** |

**El pedido manda.** El negocio es un reflejo:

- Mover la tarjeta a mano en el tablero **no** cambia el pedido; en el
  siguiente cambio del pedido el negocio vuelve a la etapa que le toca.
- Si falla algo con el negocio (crearlo o moverlo), el pedido se guarda
  igual y el error queda en el log del servidor.
- El valor del negocio no cambia después de creado (el total del pedido
  tampoco puede cambiar).

Si el dueño **borra o renombra** cosas:

- **Borra el negocio:** el pedido sigue funcionando, pierde el enlace y
  ya no se crea otro negocio para él.
- **Borra el pipeline:** se borran sus negocios (los pedidos quedan sin
  enlace). Con el siguiente pedido se crea un pipeline «Ventas» nuevo,
  solo para los pedidos nuevos.
- **Renombra el pipeline:** los negocios que ya tiene se siguen moviendo
  ahí; pero el siguiente pedido, al no encontrar uno llamado «Ventas»,
  crea un pipeline «Ventas» nuevo.
- **Renombra o quita una etapa:** los negocios que deberían ir a esa
  etapa se quedan donde están (el estado ganado/perdido sí se actualiza)
  y queda un aviso en el log. Con el siguiente pedido, la etapa con el
  nombre original se vuelve a agregar al final.

## 6. Avisos al cliente

Cuando un pedido se marca **pagado**, **enviado** o **entregado**, el
cliente recibe un aviso por WhatsApp (cancelar no avisa). El aviso sale
a la conversación del pedido o, si no tiene, a la más reciente del
contacto, y queda registrado en esa conversación como mensaje saliente.
**Un fallo del aviso nunca deshace el cambio de estado.**

### Texto dentro de la ventana, plantilla fuera

WhatsApp solo deja mandar mensajes libres si el cliente escribió en las
**últimas 24 horas** («ventana de 24 h»). La regla es la misma de los
recordatorios de la agenda:

- **El cliente escribió en las últimas 24 h** (hay un mensaje suyo en
  esa conversación) → **mensaje libre**.
- **Si no** → **plantilla aprobada por Meta** (`pedido_pagado`,
  `pedido_enviado` o `pedido_entregado`, idioma `es`).

**El texto es el mismo por los dos caminos.** El mensaje libre es
exactamente el cuerpo de la plantilla con sus variables puestas
(incluido el nombre del negocio en el aviso de pago), así que el cliente
lee lo mismo dentro o fuera de la ventana. Por ejemplo, para el pedido
#1001 de «Tienda Ejemplo», enviado con Coordinadora y guía
`700012345678`:

- Pago: «¡Hola! Tienda Ejemplo recibió tu pago. Tu pedido #1001 está
  confirmado. ¡Gracias por tu compra! 🙌»
- Envío: «¡Hola! Tu pedido #1001 ya va en camino 📦. Lo lleva
  Coordinadora con el número de guía 700012345678. Puedes rastrearlo en
  la página de la transportadora.»
- Entrega: «¡Hola! Tu pedido #1001 fue entregado. ¡Gracias por
  comprarnos! 🙌»

Si la cuenta no tiene nombre, el aviso de pago dice «tu tienda»; si
falta la transportadora o la guía, va un `-`.

Otros detalles del envío:

- **Respaldo 131047:** si el sistema creía la ventana abierta pero Meta
  responde con el error **131047** («fuera de la ventana de 24 h»), el
  mismo aviso se reintenta enseguida **por plantilla**.

Mientras las plantillas no estén creadas y aprobadas, los avisos fuera
de la ventana **fallan** y el pedido muestra «Aviso sin mandar» con el
motivo «Plantilla no aprobada en Meta».

### Los tres interruptores

En `/ventas` → tarjeta **«Avisos al cliente»** (solo admin y owner):

- **Aviso de pago recibido** — cuando marcas un pedido como pagado
  (también al crear un pedido con «El cliente ya pagó»).
- **Aviso de pedido enviado** — con la transportadora y el número de
  guía.
- **Aviso de pedido entregado** — cuando marcas un pedido como
  entregado.

Los tres vienen **prendidos**. El cambio se guarda al instante. Con un
interruptor apagado, ese aviso simplemente no se intenta: no sale nada y
el pedido no muestra error.

### «Aviso sin mandar»: qué se ve y por qué

Solo se guarda el resultado del **último** aviso intentado
(`orders.last_notice` y `orders.last_notice_error`). Si falló:

- en la lista y en el inbox, la etiqueta **«Aviso sin mandar»** (al
  pasar el mouse muestra el motivo);
- en el detalle, sección **«Aviso al cliente»**: «Aviso de pago: no se
  pudo mandar» (o de envío / de entrega) y «Motivo: …»;
- justo después de la acción: «El pedido quedó guardado, pero no
  pudimos avisarle al cliente por WhatsApp. Motivo: …».

Si un aviso posterior sale bien, la etiqueta desaparece. Los avisos no
se reintentan solos: el asesor puede escribirle al cliente por el chat.

Motivos posibles (`NOTICE_ERRORS` en `src/modules/ventas/notify.ts`):

| Motivo que se ve | Cuándo |
| --- | --- |
| No hay una conversación con el cliente | El pedido no tiene conversación y el contacto no tiene ninguna (o el contacto se borró) |
| El cliente no tiene WhatsApp vinculado | El contacto no tiene un número o id de WhatsApp al que mandar |
| WhatsApp no está conectado en esta cuenta | La cuenta no tiene WhatsApp conectado o no se pudieron leer sus credenciales |
| Plantilla no aprobada en Meta | Meta dice que la plantilla no existe en ese idioma, está pausada o deshabilitada (errores 132001, 132015, 132016) |
| Las variables no coinciden con la plantilla de Meta | El cuerpo creado en Meta no coincide con el del código, o Meta rechazó el contenido (132000, 132005, 132007, 132012) |
| El número del cliente no está autorizado en la cuenta de pruebas de Meta | Número de prueba de Meta que solo deja escribir a números autorizados (131030) |
| WhatsApp no pudo entregar el mensaje al cliente | El número no usa WhatsApp o no aceptó los términos (131026) |
| Pasaron más de 24 horas desde el último mensaje del cliente | Error 131047 que no se pudo resolver (raro: normalmente se reintenta por plantilla) |
| Error de WhatsApp: `<código>` | Cualquier otro error de Meta con código |
| No se pudo mandar el mensaje por WhatsApp | Cualquier otro fallo (por ejemplo, no se pudieron leer los ajustes) |

### Las 3 plantillas de Meta (paso manual)

> **PASO MANUAL DEL USUARIO, una vez por cada WABA (cuenta de WhatsApp
> Business) que use Ventas.** Las plantillas son de cada WABA: un cliente
> nuevo con su propio número necesita sus propias tres plantillas.
> Ningún despliegue de código las crea.

Las tres van con **categoría Utilidad (Utility)**, **idioma Español
(`es`)**, **solo cuerpo** (sin encabezado, sin pie y sin botones). El
nombre, el idioma y el cuerpo deben coincidir **exactamente** con el
código: `NOTICE_TEMPLATES` y `NOTICE_TEMPLATE_BODIES` en
`src/modules/ventas/texts.ts`, y `NOTICE_TEMPLATE_LANGUAGE = 'es'` en
`src/modules/ventas/notify.ts`. `NOTICE_TEMPLATE_BODIES` es la fuente
única del texto: de ahí sale también el mensaje libre dentro de la
ventana, y es lo que el sistema guarda en la conversación. Si el texto de
Meta es otro, el cliente recibiría por plantilla algo distinto de lo que
muestra la bandeja y de lo que recibe dentro de la ventana.

**1) `pedido_pagado`**

| Campo | Valor |
| --- | --- |
| Nombre | `pedido_pagado` |
| Categoría | Utilidad (Utility) |
| Idioma | Español → `es` |

Cuerpo (copiar tal cual):

```
¡Hola! {{1}} recibió tu pago. Tu pedido #{{2}} está confirmado. ¡Gracias por tu compra! 🙌
```

No promete «te avisamos cuando salga» a propósito: el pago puede llegar
después del envío (contraentrega).

| Variable | Contenido | Ejemplo para Meta |
| --- | --- | --- |
| `{{1}}` | Nombre del negocio (`accounts.name`, hasta 60 caracteres; si está vacío, «tu tienda») | `Tienda Ejemplo` |
| `{{2}}` | Número del pedido, sin `#` | `1001` |

**2) `pedido_enviado`**

| Campo | Valor |
| --- | --- |
| Nombre | `pedido_enviado` |
| Categoría | Utilidad (Utility) |
| Idioma | Español → `es` |

Cuerpo (copiar tal cual):

```
¡Hola! Tu pedido #{{1}} ya va en camino 📦. Lo lleva {{2}} con el número de guía {{3}}. Puedes rastrearlo en la página de la transportadora.
```

| Variable | Contenido | Ejemplo para Meta |
| --- | --- | --- |
| `{{1}}` | Número del pedido, sin `#` | `1001` |
| `{{2}}` | Transportadora (hasta 60 caracteres; vacía → `-`) | `Coordinadora` |
| `{{3}}` | Número de guía (hasta 60 caracteres; vacío → `-`) | `700012345678` |

**3) `pedido_entregado`**

| Campo | Valor |
| --- | --- |
| Nombre | `pedido_entregado` |
| Categoría | Utilidad (Utility) |
| Idioma | Español → `es` |

Cuerpo (copiar tal cual):

```
¡Hola! Tu pedido #{{1}} fue entregado. ¡Gracias por comprarnos! 🙌
```

| Variable | Contenido | Ejemplo para Meta |
| --- | --- | --- |
| `{{1}}` | Número del pedido, sin `#` | `1001` |

**Paso a paso en WhatsApp Manager** (repetir para cada plantilla):

1. Entra a **Meta Business Suite** (business.facebook.com) con la
   cuenta que administra la WABA del negocio → **WhatsApp Manager**.
2. Elige la cuenta de WhatsApp Business correcta (la del número que
   está conectado al CRM en esa cuenta).
3. Ve a **Herramientas de la cuenta → Plantillas de mensajes** y toca
   **Crear plantilla**.
4. Categoría: **Utilidad**. Si Meta pregunta el tipo, elige la plantilla
   **predeterminada / personalizada** (la de solo texto).
5. Nombre: el de la tabla (`pedido_pagado`, `pedido_enviado` o
   `pedido_entregado`), en minúsculas y con guion bajo.
6. Idioma: **Español** (código `es`). No elijas «Español (México)»,
   «Español (España)» ni «Español (Argentina)»: esas son `es_MX`,
   `es_ES` y `es_AR` y no coinciden con el código.
7. Si Meta pregunta el tipo de variable, elige **Número** (variables
   `{{1}}`, `{{2}}`…), no «Nombre».
8. Pega el **cuerpo** exacto de arriba. No agregues encabezado, pie ni
   botones.
9. Llena los **ejemplos de cada variable** (Meta los exige para revisar)
   con los valores de la columna «Ejemplo para Meta».
10. **Enviar a revisión.** Meta suele responder en minutos u horas.
    Mientras no esté aprobada, los avisos fuera de la ventana fallan
    con «Plantilla no aprobada en Meta»; dentro de la ventana salen como
    texto libre sin problema.
11. Cuando esté **Activa / Aprobada**, prueba un aviso fuera de la
    ventana (ver `docs/ventas-despliegue.md`).

> **Ojo con `pedido_enviado`.** Tiene **3 variables**, y Meta a veces
> rechaza plantillas con «demasiadas variables para la longitud del
> mensaje». Por eso el cuerpo ya trae texto fijo alrededor de las
> variables. Si aun así Meta la rechaza, agrega más texto **fijo** **en
> los dos sitios a la vez**: en el cuerpo de Meta **y** en
> `NOTICE_TEMPLATE_BODIES.shipped` de `src/modules/ventas/texts.ts`
> (con su prueba). Deben coincidir; cambiar solo uno hace que el aviso
> por plantilla no coincida con el mensaje libre ni con la bandeja.

> **No edites una plantilla ya aprobada** que esté en uso: mientras Meta
> revisa la edición, los envíos con esa plantilla pueden fallar. Si hay
> que cambiar el texto, mejor coordinar el cambio en el código y en Meta
> en una hora tranquila.

**Costo.** Cada aviso que sale **por plantilla** (fuera de la ventana de
24 h) tiene un costo según la tabla de precios vigente de Meta para la
categoría Utilidad y el país del cliente. Revisa los precios en la
documentación de Meta antes de prender los avisos para un cliente con
mucho volumen.

**`WHATSAPP_TEMPLATES_DRY_RUN` no frena los avisos.** Esa variable solo
afecta el **envío de plantillas a revisión** desde el CRM (las rutas
`/api/whatsapp/templates/submit` y `/api/whatsapp/templates/[id]`).
Ningún envío de mensajes la mira: ni los flujos, ni los recordatorios de
la agenda, ni los avisos de Ventas. Con la variable prendida, los avisos
**salen igual** y son mensajes reales.

## 7. Datos personales

Colombia regula los datos personales con la **Ley 1581 de 2012**
(«habeas data»). Un pedido guarda datos personales del cliente:

- **Nombre y teléfono:** se **copian del contacto** al crear el pedido
  (una «foto» de ese momento). Si después cambias el contacto, el pedido
  conserva los datos de cuando se vendió; si borras el contacto, el
  pedido se queda con esos datos y sin enlace al contacto. Si el contacto
  no tenía nombre, se usa el teléfono como nombre.
- **Dirección y ciudad:** opcionales al crear; obligatorias para marcar
  enviado. Se ven en el detalle; la lista no las muestra.
- **Cédula:** **opcional** («Solo si el cliente te la da. No se muestra
  en las listas.»). Nunca se lee para las listas (ni en `/ventas` ni en
  el inbox): **solo aparece en el detalle** del pedido, con la nota «Dato
  personal: úsalo solo para el envío o la factura.».
- **Quién los ve:** todos los miembros de la cuenta (owner, admin, agent
  y viewer) pueden abrir el detalle, cédula incluida. Hoy no hay permisos
  por campo, y la base deja leer el pedido completo a cualquier miembro.
- **Borrado:** un pedido no se puede borrar desde la app (se cancela).
  Solo Shift puede borrar datos desde la base.

**Para revisar con abogado** (esta guía no es asesoría legal):

- El **aviso de privacidad** de cada negocio: qué le dice al cliente
  sobre el uso de su cédula, dirección y teléfono, y cómo obtiene su
  autorización.
- La **conservación**: cuánto tiempo se guardan los pedidos con sus
  datos personales y cómo se atiende una solicitud de borrado (hoy no hay
  borrado desde la app).
- **Qué roles pueden ver** los datos personales (en especial la cédula):
  hoy los ve también el rol viewer.
- El papel de Shift como operador de la plataforma frente al negocio,
  responsable de los datos de sus clientes. Shift no es una empresa
  registrada (son dos personas naturales): no afirmar NIT ni razón
  social.

## 8. Límites conocidos y próximos pasos

- **Un pedido no se edita después de creado.** No hay pantalla ni ruta
  para cambiar productos, precios, envío, cliente, cédula ni notas; la
  base además congela importes, número, cliente y líneas. Si quedó mal,
  se cancela y se crea otro. Lo único que se completa después: ciudad y
  dirección (si faltaban, al marcar enviado), y transportadora y guía
  (al marcar enviado). Una guía mal escrita no se puede corregir desde la
  pantalla.
- **La moneda sale de la cuenta** (`accounts.default_currency`) en el
  momento de crear el pedido, nunca del navegador. Si después cambias la
  moneda de la cuenta, los pedidos viejos conservan la suya y el resumen
  las suma por separado.
- **Zona horaria fija:** el mes del resumen y las fechas se calculan en
  `America/Bogota` para todas las cuentas (igual que la agenda).
- **Lista de 500 y resumen de 1.000:** ver sección 4. Una cuenta con
  mucho volumen necesitará paginación y un resumen calculado en la base.
- **Solo se guarda el último aviso:** no hay historial de avisos fallidos
  ni reintento automático.
- **El pipeline se crea con el primer pedido,** no al activar el módulo.
  Si dos primeros pedidos llegan al mismo tiempo, podrían crearse dos
  pipelines «Ventas» (raro; no pierde datos y se arregla desde el CRM).
- **Sin bot:** Ventas no responde mensajes ni crea pedidos solo.
- **Ventas B:** catálogo con fotos y precios, variantes, carrito, link de
  pago con confirmación automática, comprobantes por foto, carritos
  abandonados, crear pedido dentro de los flujos, y decidir cómo
  repartir un mensaje entre dos bots si la cuenta también tiene agenda.
- **Ventas C:** precios por volumen y mínimos de mayorista,
  cotizaciones, reportes, conexión con la web o el POS del negocio.
