# Recordatorios de citas — agenda (Fase 1: agenda armable)

Los recordatorios avisan al cliente por WhatsApp antes de su cita, con
botones para **Confirmar**, **Reprogramar** o **Cancelar** sin escribir
nada. Esta guía cubre la operación: activar la segunda señal, crear la
plantilla en Meta, programar el cron y probarlo. Aplica a cualquier tipo
de negocio de la agenda (barbería, salón, consultorio, taller…): en los
mensajes, «cita» y «barbero» siguen el vocabulario del negocio.

## Cómo funciona

- **Dos señales por cita.** La primera sale **24 h antes** (siempre).
  La segunda, **2 h antes**, es opcional por cuenta (ver «Activar la
  señal de 2 h»).
- **Se prende o apaga con la pieza «Recordatorios»** (`/agenda/configuracion`
  → pestaña **Piezas**). Apagada, no sale ningún recordatorio (ni la
  señal de 24 h ni la de 2 h).
- **Una sola señal si la cita se crea a menos de 2 h.** La señal de 2 h
  marca también la de 24 h: nunca llegan dos mensajes seguidos.
- **Canal según la ventana de 24 h de WhatsApp.**
  - Si el cliente escribió al negocio en las últimas 24 h → **mensaje
    libre con botones** (los mismos que ya usa el flujo de reserva).
    Con la pieza **«Reprogramar y cancelar»** apagada, el mensaje libre
    muestra solo **Confirmar**.
  - Si no → **plantilla aprobada** (`recordatorio_cita`), con los
    botones como quick replies. Los botones de la plantilla son fijos
    (ver «Plantilla de Meta»).
- **Sin duplicados.** Cada señal se reclama con un UPDATE condicional
  en la base antes de enviar (`reminder_sent_at` / `reminder_2h_sent_at`):
  dos corridas simultáneas del cron no mandan dos veces. Si el envío
  falla, la marca se revierte y la próxima corrida reintenta.
- **Nunca se recuerdan** citas canceladas, completadas, no-show, ni
  citas que ya empezaron.
- Zona horaria del negocio: America/Bogota (fija para todas las cuentas).

Los botones llevan ids **estáticos** (`rem:confirm`, `rem:reschedule`,
`rem:cancel`) porque los quick replies de plantilla de Meta no admiten
payloads dinámicos. Por eso el bot resuelve la cita al tocarlos: es la
**próxima cita activa** del contacto.

## Plantilla de Meta (`recordatorio_cita`)

> **PASO MANUAL DEL USUARIO.** Con la agenda genérica cambia el cuerpo de
> la plantilla (el 💈 de la versión de barbería pasa a 📌). Hay que
> **editar la plantilla en WhatsApp Manager** y Meta la **vuelve a
> revisar**. Hasta que se apruebe, las cuentas que no son barbería verán
> el 💈 de la versión vieja, y solo cuando el recordatorio salga por
> plantilla (fuera de la ventana de 24 h). Ningún despliegue de código
> hace este paso por ti.

Crear (o editar) en WhatsApp Manager → *Plantillas de mensaje* → **Crear plantilla**:

| Campo | Valor |
| --- | --- |
| Nombre | `recordatorio_cita` |
| Categoría | Utilidad (Utility) |
| Idioma | Español → `es` |

**Cuerpo** (5 variables, en este orden):

```
¡Hola! 👋 Te recordamos tu cita en {{1}}:

📌 {{2}}
👤 {{3}}
📅 {{4}}
🕐 {{5}}

¿Nos confirmas?
```

| Variable | Contenido |
| --- | --- |
| `{{1}}` | Nombre del negocio |
| `{{2}}` | Servicio |
| `{{3}}` | Quien atiende (barbero, estilista, técnico… según el vocabulario del negocio) |
| `{{4}}` | Fecha («martes 20 de octubre de 2026») |
| `{{5}}` | Hora («7:00 a. m.») |

**Quick replies** (exactamente estos tres):

| Texto del botón | Payload |
| --- | --- |
| `Confirmar` | `rem:confirm` |
| `Reprogramar` | `rem:reschedule` |
| `Cancelar` | `rem:cancel` |

**Los botones de la plantilla son fijos.** Meta no deja cambiarlos por
cuenta, así que la plantilla siempre muestra los tres. Si una cuenta
apagó la pieza **«Reprogramar y cancelar»**, el mensaje libre solo
muestra **Confirmar**, pero la plantilla sigue mostrando los tres. Un
toque en **Reprogramar** o **Cancelar** que llega desde la plantilla no
abre el flujo del bot: el bot avisa a una persona del equipo para que lo
atienda por el chat.

> El nombre y el idioma deben coincidir exactamente con los de
> `AGENDA_REMINDER_TEMPLATE` en
> `src/verticals/agenda/agent/reminders.ts`. Si hace falta otro idioma
> o nombre, se cambia en ambos sitios.

## Activar la señal de 2 h

Desde la interfaz: `/agenda` → **Configuración** → pestaña **Bot y
recordatorios** → interruptor «Segunda señal 2 h antes» (solo
owner/admin; el cambio se guarda al instante; requiere la pieza
**Recordatorios** prendida). Ver `docs/agenda-configuracion.md`.

Como respaldo (por ejemplo, una cuenta sin acceso a la interfaz), el
mismo dato se puede fijar en la base:

```sql
insert into booking_settings (account_id, reminders_2h_enabled)
values ('<uuid-de-la-cuenta>', true)
on conflict (account_id)
do update set reminders_2h_enabled = excluded.reminders_2h_enabled;
```

Para desactivarla, el mismo upsert con `false`.

## Programar el runner

El endpoint es `GET /api/verticals/agenda/reminders/run` y se protege
contra `AUTOMATION_CRON_SECRET` (el mismo secreto que usan los crons de
automatizaciones). Acepta el secreto de dos formas:

- `x-cron-secret: <secreto>` — pinger externo o cron del host.
- `Authorization: Bearer <secreto>` — lo agrega Vercel Cron cuando
  existe la env `CRON_SECRET` en el proyecto.

Sin secreto configurado responde 503; con secreto incorrecto, 401.

> **URL vieja:** `/api/verticals/barberia/reminders/run` sigue
> funcionando como alias de la nueva. Apunta los crons externos a
> `/api/verticals/agenda/reminders/run` cuando puedas
> (`docs/agenda-despliegue-fase1.md`).

### En Vercel (recomendado)

El repo incluye `vercel.json` con el cron nativo cada 10 minutos
(requiere plan Pro). Para activarlo define en Vercel:

- `AUTOMATION_CRON_SECRET` — secreto largo y aleatorio
  (`openssl rand -hex 32`).
- `CRON_SECRET` — el **mismo** valor (Vercel lo manda como Bearer).

Verificación: Vercel → proyecto → **Cron Jobs** (cada corrida con su
log). Guía completa: `docs/despliegue-vercel.md`.

### Pinger externo (alternativa o respaldo)

cron-job.org, UptimeRobot u otro pinger cada **10–15 minutos** con el
header `x-cron-secret`. Además avisa por correo si la ejecución falla —
útil como vigilante del cron nativo.

### Manual (probar, o completar una corrida)

```bash
curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  https://<tu-dominio>/api/verticals/agenda/reminders/run
```

### Alertas de fallos

Con `ALERT_WEBHOOK_URL` definida (opcional, compatible con Slack), el
runner avisa ahí cuando la corrida lanza una excepción o queda con
`failed > 0` o `errors` no vacío. Sin la variable, no hay alertas.

Respuesta (resumen de la corrida):

```json
{
  "accounts": 1,
  "due": 3,
  "sent": 2,
  "failed": 0,
  "skipped": 1,
  "byChannel": { "text": 2, "template": 0 },
  "byKind": { "h24": 2, "h2": 0 },
  "errors": []
}
```

- `due`: citas activas que empiezan dentro de 24 h (máx. 50 por corrida).
- `skipped`: ya tenían la señal enviada, o aún no les toca, o la cita
  cambió de estado mientras se procesaba.
- `failed`: el envío no llegó a Meta; la marca se revirtió y la próxima
  corrida reintenta (el error queda en `errors`).

## Probar sin esperar a la hora real

1. Crea una cita por WhatsApp a un horario dentro de las próximas 24 h.
2. Ejecuta el `curl` de arriba: la cita debe aparecer como `due` y
   `sent`, y el cliente recibe el mensaje.
3. Repite el `curl`: esa cita ya no debe enviarse (`due` baja).
4. En la base, `booking_appointments.reminder_sent_at` queda con la
   hora del envío; en `/agenda` → **Recordatorios** aparece en
   «Enviados».

Para repetir el flujo, limpia la marca y listo:

```sql
update booking_appointments
set reminder_sent_at = null, reminder_2h_sent_at = null
where id = '<uuid-de-la-cita>';
```

## Preguntas frecuentes

- **¿Qué pasa si el cliente toca un botón viejo?** Si al tocarlo ya no
  tiene una cita activa, el bot responde que la cita ya no está activa y
  no crea nada.
- **¿Y si toca «Reprogramar» o «Cancelar»?** El bot abre el mismo flujo
  de gestión que existe dentro del chat (elegir día/hora, o confirmar la
  cancelación). Al confirmar la cancelación, se aplica la etiqueta
  `cita-cancelada` y queda el evento en el historial de la cita.
- **¿Y si el chat lo tiene un asesor (agente asignado o bot en pausa)?**
  **Confirmar** y **Cancelar** funcionan igual (Cancelar sigue pidiendo
  «Sí, cancelar»). **Reprogramar** NO abre el flujo del bot encima del
  asesor: el bot avisa al agente asignado (o al dueño si nadie tiene el
  chat) con una notificación, registra el intento en el historial de la
  cita (`reschedule_requested`) y le responde al cliente que un asesor lo
  ayuda por el mismo chat. Cualquier otro mensaje en ese chat es del
  asesor: el bot no responde.
- **¿La confirmación por botón etiqueta al cliente?** No: solo marca la
  cita como confirmada y registra el evento (`via: recordatorio`). Las
  etiquetas se reservan para cancelación/reprogramación/handoff.
- **¿Por qué no me llegó la plantilla?** Revisa que la plantilla esté
  **aprobada** en Meta, que el nombre/idioma coincidan (`recordatorio_cita`
  / `es`) y que el número tenga plantilla habilitada. Los errores de
  envío quedan en `errors` del resumen y la marca se revierte.
- **¿Y si el negocio responde «libre» en vez de plantilla aunque la
  ventana esté cerrada?** No ocurre: la decisión de canal es
  determinista (no pasa por la IA). Si el cliente escribió en las
  últimas 24 h, es texto libre; si no, plantilla.
