# Alta de un cliente nuevo — checklist

Alta de un negocio en la instancia existente (multi-cliente: cada
negocio es una `account` con su propio login y datos aislados por RLS).
Sirve para los tres negocios que vende Shift:

| Negocio | Camino | Pasos |
| --- | --- | --- |
| Barbería, salón (y cualquier negocio que agenda citas) | Módulo **Agenda**: el bot agenda y manda recordatorios | 0, 1, 2–4, 5–10 |
| Inmobiliaria | Sin módulo: **flujo** que califica y pasa al asesor + **Embudo** | 0, 1, I, 5, 6, 8–10 |

Requisitos previos: instancia desplegada y sana
(`docs/despliegue-vps.md`). Tiempo estimado: 45–60 min, más lo que tarde
Meta en aprobar las plantillas.

## Qué canales se conectan hoy

**Solo WhatsApp** (Cloud API de Meta). Instagram y Facebook Messenger
**no** están en el CRM todavía: no hay conexión, ni bandeja, ni bot para
esos canales. No venderlos ni mostrarlos en una demo hasta que existan.

## 0. Qué pedirle al cliente antes de la llamada

- [ ] Email del dueño (será el owner de la cuenta).
- [ ] El número de WhatsApp que va a usar el bot. Al pasarlo a la API
      **deja de funcionar en la app de WhatsApp del celular**. La
      «coexistencia» (app y API en el mismo número) solo se activa con
      el registro integrado de Meta (*Embedded Signup*), que este CRM no
      tiene. Si el cliente no quiere perder la app, que use un número
      nuevo para el bot.
- [ ] Acceso a su portafolio de Meta Business (o crearlo con él en la
      llamada) y un **método de pago** en WhatsApp Manager: las
      plantillas se cobran y, desde octubre de 2026, también los
      mensajes de servicio después de los 1.000 gratis al mes por
      número.
- [ ] Los datos del negocio: servicios, precios, equipo y horarios
      (agenda) o zonas, rangos de presupuesto, fichas con foto y
      asesores (inmobiliaria).

## 1. Crear la cuenta

1. Abre `https://<dominio>/signup` y crea la cuenta con el email del
   dueño (queda como owner de su `account`).
2. El dueño inicia sesión en `https://<dominio>/login` y cambia la
   contraseña.
3. El dueño invita al correo de Shift como **admin**: Configuración →
   **Miembros del equipo**. Ese correo debe estar en
   `SHIFT_STAFF_EMAILS`; si no, Shift también ve la vista sencilla y no
   llega a WhatsApp, Flujos ni Agentes de IA.
4. (Opcional) Invitar al resto del equipo del negocio.

**Verificación:** el dueño ve solo Panel, Bandeja, Agenda o Ventas y
Contactos; Shift, entrando con su correo, ve todo.

> El registro en `/signup` está abierto a cualquiera. Una cuenta creada
> por un extraño queda vacía y sin WhatsApp (la pantalla para conectarlo
> solo la ve Shift), pero conviene revisar de vez en cuando la lista de
> cuentas.

Barberías y salones siguen en el paso 2. Inmobiliarias saltan al paso I.

## 2. Activar el vertical y la moneda (COP)

Hoy no hay UI para activar el vertical: lo hace el **operador** en la
base, una sola vez por cuenta, con `vertical_key = 'agenda'` **y**
`'agenda'` en la lista `modules`. Desde la migración 050, `vertical_key`
(y `owner_user_id`) **no se pueden cambiar desde la app** ni con la
sesión de un admin, y desde la 053 tampoco `modules`: se hace en
Supabase → SQL Editor, que corre como `postgres`.

Por qué los dos: desde la migración 053 una cuenta puede tener varios
módulos (`accounts.modules`, por ejemplo `{agenda,ventas}`), y el código
lee `modules` primero; solo mira `vertical_key` si `modules` está vacío.
Una cuenta con la agenda solo en `vertical_key` funciona, pero la
perdería (menú y bot) el día que se le active otro módulo, como Ventas
(`docs/ventas.md`). `vertical_key` se mantiene por compatibilidad.

> **Zona horaria:** el vertical asume `America/Bogota` para todas las
> cuentas (ver `docs/agenda-configuracion.md`). No lo actives para un
> negocio en otra zona horaria hasta que exista soporte multi-zona.

En Supabase → SQL Editor:

```sql
update public.accounts
set vertical_key = 'agenda',
    modules = case when 'agenda' = any(modules) then modules
                   else array_append(modules, 'agenda') end,
    default_currency = 'COP'
where id = '<uuid-de-la-cuenta>';
```

Es idempotente: si la repites, `agenda` no se duplica y los demás
módulos de la cuenta se conservan. Necesita la migración 053 aplicada
(si no, falla con «column "modules" does not exist»). Verifica:

```sql
select id, name, vertical_key, modules, default_currency
from public.accounts
where id = '<uuid-de-la-cuenta>';
```

`modules` debe traer `agenda`.

Qué tipo de negocio es (barbería, salón, consultorio…) y su vocabulario
**no** se fijan aquí: el dueño los elige después con el asistente de
`/agenda` y los ajusta en `/agenda/configuracion` (paso 3).

Para encontrar el id:

```sql
select id, name, created_at
from public.accounts
order by created_at desc
limit 5;
```

**Verificación:** al recargar, el menú muestra **Agenda**.

## 3. Elegir el tipo de negocio (asistente de arranque)

`/agenda` → el asistente **«Elige tu tipo de negocio»** muestra seis
tarjetas: Barbería, Salón de belleza, Consultorio / salud, Taller,
Clases y En blanco. Al elegir una, se instala la plantilla: servicios
de ejemplo, una persona de equipo de ejemplo, horario, etiquetas,
pipeline, respuestas rápidas, base de conocimiento, prompt del agente,
las palabras del negocio (barbero / estilista / técnico…), las piezas y
las preguntas extra que corresponden al tipo. Solo owner/admin pueden
elegir.

Es **idempotente** y solo **llena**: repetirlo no duplica ni pisa datos
del dueño. Cambiar de tipo más adelante (pestaña **Tipo de negocio**)
tampoco borra nada.

**Verificación:** aparecen servicios, equipo y etiquetas en la UI.

## 4. Cargar la configuración real

Todo desde `/agenda` → **Configuración** (guía completa:
`docs/agenda-configuracion.md`):

- [ ] **Negocio:** nombre, dirección, moneda COP.
- [ ] **Tipo de negocio:** revisar las seis palabras (quien atiende, lo
      que se agenda, la reserva).
- [ ] **Piezas:** elegir quién atiende, precios, duración,
      recordatorios, reprogramar y cancelar.
- [ ] **Preguntas:** hasta 5 preguntas extra (placa, motivo de la
      consulta, dirección…). Si recogen datos de salud o direcciones,
      ver `docs/agenda-notas.md`.
- [ ] **Servicios:** reales (nombre, duración, precio); desactivar los
      de ejemplo.
- [ ] **Equipo:** personas reales + qué servicios atiende cada una.
- [ ] **Horarios:** días y franjas reales del local.
- [ ] **Bloqueos:** almuerzos, festivos, ausencias.
- [ ] **Bot y recordatorios:** textos del bot (saludo/despedida) y
      decisión sobre la segunda señal de 2 h.

**Verificación:** la agenda muestra las franjas correctas.

## I. Inmobiliaria: instalar el flujo y el embudo

Una inmobiliaria **no** lleva módulo (no se toca SQL): el bot es un flujo
y las oportunidades viven en el **Embudo**. Entrando con el correo de
Shift:

1. **Flujos → Nuevo flujo →** «Inmobiliaria: calificar y pasar a
   asesor». Un clic crea el flujo en borrador, 7 etiquetas, el embudo
   «Inmobiliaria» y la automatización «Inmobiliaria: calificado al
   embudo», que reparte los leads calificados entre los asesores por
   turnos. Reinstalar no duplica la automatización.
2. Cambia en el flujo lo que viene de ejemplo **antes de activarlo**:
   - las zonas (vienen de Bogotá);
   - los rangos de presupuesto de arriendo y de compra;
   - las fichas: texto, precio y foto (la de ejemplo dice «Plano de
     ejemplo»). La ficha no cambia según la zona elegida: el CRM no
     tiene catálogo de inmuebles, así que pon una ficha que le sirva a
     cualquiera o una invitación a ver el catálogo.
3. Invita a los asesores como miembros (Configuración → **Miembros del
   equipo**): el reparto por turnos solo asigna a miembros.
4. Activa el flujo **después** del paso 6 (webhook verificado). Arranca
   con el primer mensaje de cada contacto: quien ya había escrito antes
   no entra al bot.
5. El flujo usa el cron de flujos (`/api/flows/cron`). En el VPS ya
   está en el crontab (`docs/despliegue-vps.md` §6); en Vercel no
   estaba programado.

**Verificación:** el flujo pasa la validación al activarlo y el embudo
«Inmobiliaria» aparece en **Embudo** con sus 7 etapas.

## 5. Conectar WhatsApp Cloud API

Settings → pestaña **WhatsApp** (`/settings?tab=whatsapp`):

1. Número: Phone Number ID, WABA ID, token (System User de Meta) y
   verify token (inventa uno largo).
2. Botón **Verificar con Meta** (comprueba credenciales contra la API).
3. PIN de doble paso si Meta lo pide.

Errores comunes: `docs/whatsapp-connection-troubleshooting.md`. Varios
WABA/números: `docs/multi-waba.md`.

**Con qué app de Meta.** Lo simple es que el WABA del cliente quede
suscrito a la app de Meta de Shift (Setup A de `docs/multi-waba.md`).
Para manejar activos de **otros** negocios, Meta suele exigir que la app
tenga acceso avanzado (*Advanced Access*, por revisión de la app) y
verificación del negocio, y Shift no es una empresa registrada (revisar
con el contador o el abogado qué documento sirve). Si Meta lo bloquea,
la salida que no depende de eso es el Setup B: el cliente crea su propia
app en su portafolio, Shift la configura con él y su secreto se suma a
`META_APP_SECRET` separado por comas. Confirmarlo con el primer cliente
real antes de prometer tiempos.

## 6. Verificar el webhook en Meta

En Meta → App → WhatsApp → Configuration:

1. Callback URL: `https://<dominio>/api/whatsapp/webhook`
2. Verify token: **el mismo** que pusiste en el paso 5.
3. Suscribe el campo `messages`.
4. Desde otro celular, envía un mensaje de prueba al número del negocio:
   debe aparecer en la **Bandeja de entrada** en segundos.

Si el webhook rechaza con 401: `META_APP_SECRET` equivocado
(`docs/multi-waba.md`).

## 7. Crear la plantilla de recordatorio en Meta

Sigue la receta exacta de `docs/agenda-recordatorios.md` → *Plantilla
de Meta (`recordatorio_cita`)*: nombre, categoría Utilidad, idioma `es`,
cuerpo con 5 variables y los tres quick replies
(Confirmar / Reprogramar / Cancelar), con el cuerpo genérico (📌). Es
una plantilla **nueva** en la WABA del negocio. No edites una
`recordatorio_cita` que ya esté aprobada en otra WABA (por ejemplo, la
de una barbería existente): una edición en revisión puede bloquear sus
envíos.

Sin esta plantilla, los recordatorios fuera de la ventana de 24 h no se
pueden enviar (dentro de la ventana salen igual, como mensaje libre).

**Verificación:** la plantilla queda **Aprobada** en WhatsApp Manager
(minutos a ~1 día).

## 8. Probar el flujo completo

1. Desde un celular externo, escribe al número («Hola, quiero una
   cita») y agenda una cita completa con el bot.
2. La cita aparece en `/agenda` (con las respuestas a las preguntas
   extra, si las hay) y la conversación en la Bandeja de entrada.
3. Dispara el recordatorio sin esperar
   (`docs/agenda-recordatorios.md` → «Probar sin esperar a la hora
   real»): el cliente recibe el mensaje y la cita aparece en
   «Enviados».
4. El cliente toca **Confirmar**: la cita queda confirmada.
5. Si la segunda señal de 2 h está activa, repite la corrida y revisa
   que no se duplique nada.

**Inmobiliaria:** desde un celular externo escribe «Hola» y recorre
Arrendar → zona → presupuesto → ficha → **Quiero visitarlo**. El contacto
queda con la etiqueta `calificado`, aparece una oportunidad en la etapa
Calificado del embudo «Inmobiliaria» y la conversación queda asignada a
un asesor. Repite con **Hablar con asesor** desde el saludo: llega a la
Bandeja sin oportunidad (es lo esperado).

## 9. Confirmar cron y alertas

- [ ] `AUTOMATION_CRON_SECRET` definido en el entorno y los tres crons
      corriendo: recordatorios de la agenda, automatizaciones y flujos
      (`docs/despliegue-vps.md` §6: `journalctl -t shift-crm-cron`).
- [ ] `/api/health` monitoreado desde afuera (`docs/despliegue-vps.md`
      §8).
- [ ] (Opcional) `ALERT_WEBHOOK_URL` para avisos de fallos del runner.

## 10. Entrega al cliente

- Acceso del dueño (contraseña temporal ya cambiada).
- Lo que ve: Panel, Bandeja, Agenda o Ventas, Contactos (y Embudo si es
  inmobiliaria). Si WhatsApp se desconecta, el Panel le dice que le
  escriba a Shift: el arreglo lo hace Shift.
- Resumen de uso: agenda, bandeja y recordatorios
  (`docs/agenda-configuracion.md`, `docs/agenda-recordatorios.md`).
- Operación, respaldos y secretos: `docs/operacion-datos-y-secretos.md`.

## Resumen: paso → verificación → si falla

| Paso | Verificación | Si falla |
| --- | --- | --- |
| 1. Cuenta | Login OK | revisar `/signup` y el correo |
| 2. Vertical | menú **Agenda** visible | SQL (`vertical_key = 'agenda'` y `agenda` en `modules`) aplicado sobre la cuenta correcta |
| 3. Tipo de negocio | servicios visibles | reintentar el asistente (es idempotente) |
| 4. Configuración | agenda con horarios reales | `docs/agenda-configuracion.md` |
| I. Inmobiliaria | flujo validado y embudo con 7 etapas | reinstalar la plantilla (no duplica la automatización) |
| 5. WhatsApp | «Verificar con Meta» OK | `docs/whatsapp-connection-troubleshooting.md` |
| 6. Webhook | mensaje en la Bandeja | verify token / firma; `docs/multi-waba.md` |
| 7. Plantilla Meta | aprobada | nombre/idioma exactos `recordatorio_cita` / `es` |
| 8. Flujo | cita + recordatorio + Confirmar | `docs/agenda-recordatorios.md` |
| 9. Cron | los tres crons en `journalctl -t shift-crm-cron` | `docs/despliegue-vps.md` §6 |
