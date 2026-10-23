# Onboarding de un negocio nuevo (agenda) — checklist

Alta de un negocio que agenda citas (barbería, salón, consultorio,
taller, clases…) en la instancia existente (multi-cliente: cada negocio
es una `account` con su propio login y datos aislados por RLS).

Requisitos previos: instancia desplegada y sana
(`docs/despliegue-vercel.md`), email del dueño y número de WhatsApp del
negocio. Tiempo estimado: 45–60 min, más lo que tarde Meta en aprobar la
plantilla de recordatorio.

## 1. Crear la cuenta

1. Abre `https://<dominio>/signup` y crea la cuenta con el email del
   dueño (queda como owner de su `account`).
2. El dueño inicia sesión en `https://<dominio>/login` y cambia la
   contraseña.
3. (Opcional) Invitar al equipo: Settings → **Members**.

**Verificación:** el usuario entra y ve el panel general.

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

## 5. Conectar WhatsApp Cloud API

Settings → pestaña **WhatsApp** (`/settings?tab=whatsapp`):

1. Número: Phone Number ID, WABA ID, token (System User de Meta) y
   verify token (inventa uno largo).
2. Botón **Verificar con Meta** (comprueba credenciales contra la API).
3. PIN de doble paso si Meta lo pide.

Errores comunes: `docs/whatsapp-connection-troubleshooting.md`. Varios
WABA/números: `docs/multi-waba.md`.

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

## 9. Confirmar cron y alertas

- [ ] `AUTOMATION_CRON_SECRET` y `CRON_SECRET` definidos en el entorno;
      el cron corre (Vercel → **Cron Jobs**, o pinger externo).
- [ ] `/api/health` monitoreado desde afuera
      (`docs/despliegue-vercel.md` §6).
- [ ] (Opcional) `ALERT_WEBHOOK_URL` para avisos de fallos del runner.

## 10. Entrega al cliente

- Acceso del dueño (contraseña temporal ya cambiada).
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
| 5. WhatsApp | «Verificar con Meta» OK | `docs/whatsapp-connection-troubleshooting.md` |
| 6. Webhook | mensaje en la Bandeja | verify token / firma; `docs/multi-waba.md` |
| 7. Plantilla Meta | aprobada | nombre/idioma exactos `recordatorio_cita` / `es` |
| 8. Flujo | cita + recordatorio + Confirmar | `docs/agenda-recordatorios.md` |
| 9. Cron | corrida OK en Cron Jobs | pinger externo de respaldo |
