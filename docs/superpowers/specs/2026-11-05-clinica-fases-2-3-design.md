# Clínica, Fases 2 y 3: calendario, Google Calendar, llamadas por pasos y después de la cita

Fecha: 2026-11-05. Sigue a `2026-11-02-odontologia-design.md` (Fase 1, PR #11). Rama
`feat/clinica-fases-2-3`, hecha desde `feat/clinica-odontologia`.

## 1. Qué pidió el usuario

- **Calendario en el panel**, donde la recepción crea, mueve y cancela citas y estas se guardan con las
  mismas reglas del bot.
- **Copia a Google Calendar** de cada cita.
- **Solo WhatsApp** como canal de mensajes por ahora (sin Instagram ni Messenger).
- **Llamadas con voz por pasos**, como el bot de WhatsApp: "Hola, soy el asistente virtual de X.
  Marca 1 para…, marca 2 para…". No es una IA que conversa: es un menú fijo con voz sintética.
- **Fase 3**: cierre del día, cuidados, "¿Cómo sigues?" y calificación con el enlace de Google.

Fuera de esta entrega: leer los ocupados de Google para bloquear horas (doble vía), sedes múltiples en
la Agenda de Shift, lista de espera, volver y pagar, reportes y conector Dentalink.

## 2. A quién aplica

| Pieza | Cuentas |
| --- | --- |
| Calendario, crear, mover y cancelar desde el panel | Todas las cuentas con `agenda` |
| Paciente, cupo de sillones, plantillas `_clinica` | Solo con `clinica` |
| Google Calendar | Todas con `agenda`, si el dueño lo conecta |
| Llamadas por pasos | Todas con `agenda`, apagadas por defecto y con un tope mensual |
| Lista "Para llamar" | Todas con `agenda` |
| Fase 3 completa | Solo con `clinica` |

Una cuenta que no prende nada nuevo no cambia de conducta. La única excepción es que **Confirmar** en
un recordatorio ahora también marca `attendance_confirmed_at` (§4.1).

## 3. Migración 056 (una sola, aditiva e idempotente)

Se aplica a mano en el SQL Editor, con OK del usuario, **después de la 055** y antes de unir este PR.
Se prueba en un Postgres temporal como la 055.

- `booking_appointments`:
  - `attendance_confirmed_at timestamptz`: el paciente dijo que va (botón del recordatorio, llamada o
    recepción). Se distingue de `confirmed_at`, que el bot pone al reservar.
  - `google_calendar_id text`, `google_dirty boolean NOT NULL DEFAULT true`, `google_synced_at
    timestamptz`, `google_sync_error text` (máx. 300).
  - Trigger `BEFORE INSERT OR UPDATE` `mark_booking_google_dirty`: en INSERT, o si cambian `starts_at`,
    `ends_at`, `status`, `staff_id`, `service_id`, `contact_id`, `patient_id`, `location_id` o `notes`,
    pone `google_dirty = true`. Un UPDATE que solo toca las columnas `google_*` no lo prende, y así la
    sincronización no se dispara a sí misma.
  - Índice parcial `(account_id) WHERE google_dirty`.
- `booking_staff.google_calendar_id text`: calendario de Google de ese profesional. Null = el de la
  conexión.
- `agenda_calendar_connections`: `account_id` PK, `provider` ('google'), `google_email`,
  `refresh_token_encrypted`, `default_calendar_id` (por defecto 'primary'), `status` ('active',
  'error', 'revoked'), `last_error`, `last_sync_at`, `connected_by`, `created_at`, `updated_at`. RLS
  prendida **sin políticas para clientes**: el token solo lo lee el servidor. El panel ve el estado por
  una ruta API que nunca devuelve el token.
- `booking_call_settings`: `account_id` PK, `enabled` (false), `caller_id` (número que marca, E.164),
  `call_after_minutes` (180, tiempo después del recordatorio de 24 h sin confirmar), `min_lead_minutes`
  (120, no se llama si faltan menos), `max_attempts` (2, entre 1 y 3), `retry_minutes` (90),
  `window_start` ('08:00'), `window_end` ('19:00'), `call_saturday` (true), `monthly_limit` (300),
  `voice` (null = la de la plataforma), `updated_at`. Miembros leen, admin escribe (patrón 050).
- `booking_calls`: `id`, `account_id`, `appointment_id` (FK compuesta con cuenta, `ON DELETE
  CASCADE`), `contact_id` (SET NULL), `channel` ('robot', 'manual'), `attempt` (1–3), `status`
  ('queued', 'calling', 'completed', 'no_answer', 'busy', 'failed', 'canceled'), `outcome`
  ('confirmed', 'cancelled', 'human', 'no_response', 'wrong_number', null), `digits` (máx. 10),
  `provider_call_sid`, `error` (máx. 300), `duration_seconds`, `created_by`, `created_at`,
  `finished_at`. Único por (`appointment_id`, `channel`, `attempt`) cuando `channel = 'robot'`.
  Miembros leen; los agentes insertan filas `manual` de su cuenta; el robot escribe con service role.
- `clinic_followups`: `id`, `account_id`, `appointment_id` (FK compuesta, CASCADE), `contact_id`
  (SET NULL), `kind` ('cuidados', 'como_sigues', 'calificacion'), `due_at`, `status` ('pending',
  'sent', 'skipped', 'failed'), `attempts` (0–5), `skip_reason` (máx. 60), `response` ('bien',
  'molestias', 'ayuda', null), `sent_at`, `responded_at`, `created_at`. Único por (`appointment_id`,
  `kind`). Índice parcial `(due_at) WHERE status = 'pending'`. Miembros leen; el servidor escribe.
- `clinic_ratings`: `id`, `account_id`, `appointment_id` (SET NULL), `contact_id` (SET NULL),
  `location_id` (SET NULL), `value` ('bien', 'regular', 'mal'), `followup_id` único, `created_at`.
  Miembros leen; el servidor escribe.
- `clinic_day_closes`: `account_id`, `date_key` ('YYYY-MM-DD'), `notified_at`. PK (`account_id`,
  `date_key`). Sirve para avisar una sola vez por día.
- Todas con RLS 017/050, CHECK de largos y valores, y `supabase/ci/verify-schema.sql` +
  `rls-policies.test.ts` actualizados.

## 4. Fase 2: agenda para recepción

### 4.1 Confirmación del paciente

`attendance_confirmed_at` se escribe cuando:
- el paciente toca **Confirmar** en un recordatorio (texto o plantilla), en cualquier cuenta;
- marca 1 en la llamada;
- la recepción anota "Confirmó" en la lista Para llamar.

Mover una cita lo borra junto con `reminder_sent_at` y `reminder_2h_sent_at`: los recordatorios
vuelven a salir para la nueva hora.

### 4.2 `/agenda/calendario`

- Vista **día**, con una columna por profesional, y vista **semana**, con una columna por día y filtro
  de profesional. Navegación anterior, hoy y siguiente. Franja de 6:00 a 22:00, ajustada a los horarios
  del equipo. Hora de Bogotá (la cuenta no tiene zona propia en esta versión).
- Cada cita es un bloque con hora, nombre y atención. Colores por estado: confirmada sólida; confirmada
  por el paciente con ícono de visto; cancelada oculta por defecto ("Mostrar canceladas"); atendida y
  no vino en gris.
- Bloqueos (`booking_time_off`) y horas fuera del horario sombreados.
- Clic en un hueco: abre **Nueva cita** con ese profesional y esa hora. Clic en una cita: abre su
  detalle con **Mover**, **Cancelar**, **Marcar atendida / No vino** y **Abrir conversación**.
- Se diseña con las skills de diseño del usuario (taste-skill, design-md-library,
  web-design-guidelines) y se revisa con capturas en escritorio y celular.
- `/agenda` (hoy) gana un enlace "Ver calendario".

### 4.3 Crear cita desde el panel

`POST /api/verticals/agenda/appointments`, con `requireRole('agent')`.

Cuerpo:
- `contact_id` existente, o `new_contact { name, phone }`. El teléfono se normaliza con los helpers del
  CRM. Si ya existe un contacto con ese número en la cuenta, se usa ese.
- Clínica: `patient_id` existente del contacto, o `new_patient_name`. Si el contacto no tiene
  pacientes, se crea uno con su nombre.
- `service_id`, `staff_id` (debe atender ese servicio), `starts_at` (ISO). `ends_at` se calcula con la
  duración del servicio.
- `outside_hours_ok` (bool): fuera del horario o en un bloqueo la ruta responde 409
  `outside_hours`, y la UI pregunta "Está fuera del horario de X. ¿Agendar igual?".
- `notify` (bool, por defecto true): avisar al paciente por WhatsApp.

Reglas:
- Pasa por una función pura `validateNewAppointment` y escribe con `insertAppointment`, ampliado para
  `createdVia: 'dashboard'`, `created_by` y `status: 'confirmed'`.
- Un choque del profesional (23P01) da 409 `slot_taken`: "X ya tiene una cita a esa hora".
- Cupo de sillones (clínica): si las citas activas que se cruzan con esa franja ya igualan
  `chair_count`, 409 `chairs_full`: "No quedan sillones libres a esa hora".
- Una hora pasada se rechaza (400).
- Una clínica nueva por recepción: si `clinic_settings.reception_consent_declared_at` está puesto, se
  agrega `clinic_consents` con `source = 'recepcion'` y el texto vigente. Si no, el contacto queda sin
  autorización y el bot la pedirá en su primer mensaje. Los recordatorios siguen las reglas actuales.
- Conversación: se usa la del contacto si existe. Si no, se crea una conversación de WhatsApp vacía,
  igual que hace el CRM al escribir a un contacto nuevo.

### 4.4 Mover y cancelar desde el panel

`PATCH /api/verticals/agenda/appointments/[id]` gana dos acciones además del cambio de estado:

- `{ action: 'move', starts_at, staff_id?, notify, outside_hours_ok? }`: actualiza en la misma fila
  (el id y el evento de Google se conservan), con las mismas validaciones de §4.3 y bloqueo optimista
  por `updated_at`. Borra las marcas de recordatorio y de confirmación del paciente. Solo para citas
  `pending` o `confirmed` futuras.
- `{ action: 'cancel', reason?, notify }`: pasa a `cancelled` con `cancelled_at` y `cancel_reason`
  ('clinic' por defecto).
- El cambio de estado actual sigue igual.

### 4.5 Avisar al paciente

Módulo `src/verticals/agenda/notify-patient.ts`. Si el paciente escribió en las últimas 24 h, sale
texto libre (mensaje de servicio, sin costo dentro de las 1.000 del mes). Si no, sale una plantilla:

| Plantilla | Variables | Botones |
| --- | --- | --- |
| `cita_agendada` | negocio, servicio, profesional, fecha, hora | — |
| `cita_cancelada` | negocio, fecha, hora | Agendar otra (`book:again`) |
| `cita_agendada_clinica` | paciente, negocio, sede, doctor, fecha, hora | — |
| `cita_cancelada_clinica` | paciente, negocio, fecha, hora | Agendar otra (`book:again`) |

Las de clínica nunca nombran el procedimiento. Mover usa `cita_agendada*` con la nueva hora. Si el
envío falla, la cita igual queda guardada y el panel dice "La cita quedó guardada, pero no se pudo
avisar por WhatsApp: …". El toque de **Agendar otra** abre el flujo de reservas del bot.

Las plantillas las crea el usuario en WhatsApp Manager. El texto exacto va en `docs/clinica-montaje.md`.

### 4.6 Cupo de sillones

`InternalBackend` (bot) y la ruta de creación comparten `chairsFreeAt(...)`. Para cuentas con
`clinica` y `chair_count` puesto, una hora no se ofrece si las citas activas de toda la cuenta que se
cruzan con ella ya igualan el cupo. Dos reservas al mismo instante pueden pasarse en uno: se acepta en
esta versión (el calendario lo muestra).

### 4.7 Lista "Para llamar"

Sección en `/agenda`, encima de las citas de hoy, con las citas activas de las próximas 48 h que:
- ya recibieron el recordatorio de 24 h hace más de `call_after_minutes`, y
- no tienen `attendance_confirmed_at`;

y además las que el robot dejó en `human`, `no_response` o `failed`. Cada fila muestra paciente,
teléfono (enlace `tel:`), hora, profesional e intentos del robot. Acciones: **Confirmó**, **Canceló**
(cancela con aviso opcional), **No contestó** y **Llamar con el robot ahora** (si las llamadas están
prendidas). Lo manual se guarda en `booking_calls` con `channel = 'manual'`.

## 5. Google Calendar (una vía: Shift → Google)

- **Conectar:** en `/agenda/configuracion`, tarjeta "Google Calendar" (solo owner/admin).
  `GET /api/integrations/google-calendar/connect` redirige a Google con `access_type=offline`,
  `prompt=consent` y los permisos `openid email`, `calendar.events` y
  `calendar.calendarlist.readonly`. `state` es un valor aleatorio en una cookie httpOnly de 10
  minutos. `GET .../callback` lo verifica, exige admin otra vez, cambia el código por tokens, guarda el
  refresh token cifrado con `encrypt()` de `lib/whatsapp/encryption` y marca para sincronizar las citas
  activas desde hace 1 día hasta 180 días adelante.
- **Elegir calendarios:** `GET /api/integrations/google-calendar/calendars` lista los calendarios con
  permiso de escritura. Se elige el calendario general y, opcionalmente, uno por profesional.
- **Desconectar:** borra el token (y lo revoca en Google). Los eventos ya creados se quedan.
- **Sincronizar:** `syncAccountCalendar(db, accountId)` toma hasta 50 citas con `google_dirty`, de
  hace 1 día a 180 días adelante:
  - El id del evento es el uuid de la cita sin guiones: es base32hex válido y permite reintentar sin
    duplicar. Primero `PUT events/{id}`; si responde 404, `POST events` con ese id.
  - `pending` → evento `tentative`; `confirmed` → `confirmed`; `completed` → título con "✓ ";
    `no_show` → título con "No vino · "; `cancelled` → se borra el evento.
  - Título: "{atención} · {nombre}". Descripción: profesional y "Creada desde Shift". **Sin teléfonos
    ni notas.** En clínica, el nombre es el del paciente.
  - Si cambió el calendario de destino, se borra del anterior.
  - Al terminar, `google_dirty = false`, `google_synced_at` y `google_calendar_id`, con la condición
    `updated_at = <el leído>`: si la cita cambió mientras tanto, queda pendiente.
  - Error de una cita: `google_sync_error` y sigue con la siguiente. `invalid_grant`: conexión
    `revoked`, aviso al dueño en la app, y se deja de intentar hasta reconectar.
- **Cuándo corre:** cron `/api/verticals/agenda/calendar-sync/run` cada 5 minutos (Vercel y crontab del
  VPS), más un empujón con `after()` de Next al crear, mover, cancelar o cambiar el estado desde el
  panel.
- **Requisitos del usuario:** crear un proyecto en Google Cloud con OAuth (variables `GOOGLE_CLIENT_ID`
  y `GOOGLE_CLIENT_SECRET`, URL de retorno `{NEXT_PUBLIC_APP_URL}/api/integrations/google-calendar/
  callback`). Hay que **publicar la app en modo "En producción" aunque no esté verificada**: en modo
  "Prueba" Google vence los tokens a los 7 días. Sin verificar, Google muestra un aviso y admite hasta
  100 usuarios. La verificación (política de privacidad, dominio y video) se pide aparte.

## 6. Llamadas por pasos (robot de voz)

Proveedor: **Twilio Programmable Voice**, por API REST con `fetch` (sin SDK) y detrás de una interfaz
`VoiceProvider` para poder cambiarlo. Llamada a celular de Colombia: unos USD 0,038 por minuto según la
página de precios de Twilio (a confirmar). Variables: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y
`TWILIO_DEFAULT_CALLER_ID`. El número que marca puede ser uno de Twilio o el de la clínica verificado
en Twilio ("Verified Caller ID"). Twilio dice que en Colombia el identificador de un número que no es
de Twilio se respeta "lo mejor posible".

**Cuándo llama** (cron `/api/verticals/agenda/calls/run` cada 10 minutos):
- llamadas prendidas en la cuenta y credenciales puestas;
- cita activa y futura, sin `attendance_confirmed_at`, con el recordatorio de 24 h enviado hace más de
  `call_after_minutes`, y faltando más de `min_lead_minutes`;
- dentro del horario (`window_start`–`window_end`, hora de Bogotá), de lunes a sábado (sábado si
  `call_saturday`), **nunca domingos ni festivos de Colombia** (cálculo propio con Ley Emiliani y
  Pascua);
- intentos por debajo de `max_attempts`, con `retry_minutes` desde el anterior, y la cuenta por debajo
  de `monthly_limit` en el mes;
- el contacto tiene teléfono, no tiene las etiquetas de baja ni `no-llamar` y, en clínica, no revocó la
  autorización.
- Se reclama insertando la fila `queued` con su `attempt` (el único impide dos llamadas). Si Twilio
  rechaza la llamada, la fila queda `failed` y la cita aparece en Para llamar.

**Qué dice** (voz `Polly.Mia-Neural`, `es-MX`, configurable; **siempre una voz nativa en español**):

1. "Hola, soy el asistente virtual de {negocio}. Te llamamos para recordar la cita de {paciente o
   "tu cita"} el {día} a las {hora} con {profesional}. Para confirmarla, marca 1. Para cancelarla,
   marca 2. Para hablar con alguien del equipo, marca 3." Se repite una vez si no marca nada.
2. **1** → `attendance_confirmed_at`, "Listo, tu cita quedó confirmada. Te esperamos. Hasta luego."
3. **2** → "¿Seguro que quieres cancelarla? Marca 1 para sí o 2 para no." Con 1 se cancela
   (`cancel_reason = 'patient_call'`), "Tu cita quedó cancelada. Te escribiremos por WhatsApp para
   agendar otra." y, si la ventana de 24 h está abierta, sale el mensaje para reagendar. Con 2, vuelve
   al menú.
4. **3** → outcome `human`, aviso prioritario en la app, "Listo, alguien del equipo te va a contactar
   pronto. Hasta luego."
5. Sin respuesta tras dos vueltas → `no_response`, "No recibimos respuesta. Te escribiremos por
   WhatsApp. Hasta luego." Otra tecla → "No entendí" y se repite.

Nunca nombra el procedimiento ni dice nada clínico.

**Seguridad de los webhooks** (`/api/voice/twilio/answer`, `/gather`, `/status`): se valida
`X-Twilio-Signature` (HMAC-SHA1 sobre la URL pública `NEXT_PUBLIC_APP_URL` + ruta + query, más los
parámetros POST ordenados) con comparación de tiempo constante. La fila se busca por `call` id y
`provider_call_sid`. Cada acción es idempotente: un reintento de Twilio no cancela dos veces.

**Configuración:** tarjeta "Llamadas" en `/agenda/configuracion` con el interruptor, el número, el
horario, los intentos, el tope y un botón "Probar llamada a mi número", que llama a un número que se
escribe en el momento, con una cita de ejemplo marcada como prueba.

**Voz:** antes de prender las llamadas en una cuenta real se graba una llamada de prueba y se revisa
con faster-whisper sin forzar idioma: debe salir `es` y el texto exacto. Si sale otro idioma, se cambia
la voz.

## 7. Fase 3: después de la cita (solo `clinica`)

Cron `/api/verticals/clinica/followups/run` cada 10 minutos. Hace tres cosas.

**7.1 Crear seguimientos.** Citas de clínica `completed` con inicio en los últimos 3 días y sin filas:
- `cuidados`, para ya, solo si el servicio tiene `aftercare_instructions`;
- `como_sigues`, al día siguiente a las 10:00;
- `calificacion`, a los dos días a las 10:00. Se separa de `como_sigues` para no mandar dos mensajes
  el mismo día.

Con `upsert` e `ignoreDuplicates`, para que correr dos veces no duplique.

**7.2 Enviar los vencidos.** Se reclama con un UPDATE condicional (`pending` → `sent`), igual que los
recordatorios. Si el envío falla, vuelve a `pending` con `attempts + 1`, y a los 3 intentos queda
`failed`. Antes de enviar se omiten (`skipped` con motivo):
- todos: contacto con etiqueta de baja, autorización revocada o sin número;
- `calificacion`: cita futura activa, calificación en los últimos 90 días, etiqueta `queja-abierta`, o
  `como_sigues` respondido con molestias o ayuda.

| Tipo | Ventana abierta | Ventana cerrada (plantilla) |
| --- | --- | --- |
| cuidados | Texto con las instrucciones del servicio | `cuidados_cita_clinica` (paciente, negocio), botón "Ver recomendaciones" (`fu:cuidados:<id>`) |
| como_sigues | Botones Bien / Tengo molestias / Necesito ayuda | `como_sigues_clinica` (paciente, negocio), mismos botones (`fu:bien|molestias|ayuda:<id>`) |
| calificacion | Botones Bien / Regular / Mal | `calificacion_visita_clinica` (paciente, negocio), mismos botones (`rt:bien|regular|mal:<id>`) |

**7.3 Cierre del día.** Desde las 20:00, si hay citas de hoy ya empezadas en `pending` o `confirmed`,
se avisa una vez al dueño en la app ("Tienes N citas de hoy sin marcar") y se guarda en
`clinic_day_closes`. En `/agenda` aparece la sección "Sin marcar" con **Atendió** y **No vino**.

**7.4 Respuestas en el bot** (antes del candado, como los toques `rem:*`):
- `fu:cuidados:<id>` → manda las instrucciones de cuidado del servicio de esa cita.
- `fu:bien` → "¡Qué bueno! Cualquier cosa, escríbenos por aquí."
- `fu:molestias` / `fu:ayuda` → guarda la respuesta, aviso prioritario al equipo, la conversación
  pasa a una persona, y "Le avisamos al equipo para que te contacten pronto." más los signos de alarma
  de la clínica (`urgency_alarm_text`).
- `rt:<valor>` → guarda `clinic_ratings` (una vez por seguimiento) y responde a todos: "¡Gracias por
  contarnos! Si quieres, déjanos tu opinión en Google: {google_review_url}". Sin enlace, solo el
  agradecimiento. Regular y Mal avisan además al dueño para que alguien llame.
- Un id que no es de la cuenta o del contacto se ignora en silencio.

## 8. Errores y casos límite

| Caso | Qué pasa |
| --- | --- |
| Dos personas mueven la misma cita | Bloqueo optimista por `updated_at`: "Alguien cambió esta cita. Recarga." |
| La plantilla no está aprobada | La cita se guarda y el panel avisa que no se pudo notificar. |
| Google caído | La cita sigue sucia y se reintenta en 5 minutos. El panel muestra el último error de conexión. |
| Token de Google revocado | Conexión `revoked`, aviso al dueño y botón "Reconectar". |
| Twilio rechaza la llamada | Fila `failed` y la cita aparece en Para llamar. |
| El paciente cuelga a mitad | El `status` final de Twilio cierra la fila. Sin tecla: `no_response`. |
| Marca 2 y cuelga sin confirmar | No se cancela nada. |
| La cita se canceló antes de que contestara | La llamada dice "Esta cita ya no está activa" y cuelga. |
| La cita se movió entre recordatorio y llamada | Marcas borradas: no se llama hasta el nuevo recordatorio. |
| Toque de un seguimiento viejo | Se responde una sola vez: una calificación repetida no se guarda dos veces. |

## 9. Pruebas

- Funciones puras con Vitest: validación de nueva cita, cupo, festivos de Colombia, ventana de llamada,
  firma de Twilio (con el vector del ejemplo oficial), TwiML generado, mapeo de evento de Google,
  reglas de omisión de seguimientos y parseo de toques `fu:` / `rt:`.
- Rutas con el doble de Supabase de `route-testing.ts`. Runners con base falsa, como los recordatorios.
- Google y Twilio con `fetch` falso: nunca se llama a la red en pruebas.
- 056 en un Postgres temporal, con RLS y el trigger de `google_dirty`.
- UI del calendario: capturas en escritorio y celular con Playwright, con datos falsos en memoria y no
  contra producción (`.env.local` es producción).
- Al final: `npm test`, `tsc`, `eslint` y `next build`.

## 10. Pendientes del usuario y riesgos

- Aplicar 055 y luego 056 en el SQL Editor (con `SHOW server_version` ≥ 15).
- Crear y aprobar en Meta las 7 plantillas nuevas (`cita_agendada`, `cita_cancelada`, sus versiones
  `_clinica`, `cuidados_cita_clinica`, `como_sigues_clinica` y `calificacion_visita_clinica`). Meta
  puede clasificar la calificación como marketing, que cuesta más.
- Google Cloud: proyecto, credenciales OAuth, app "En producción" y, después, la verificación.
- Twilio: cuenta, saldo, número o caller ID verificado, y la llamada de prueba revisada con
  faster-whisper.
- **Para el abogado:** llamar al paciente con voz sintética (autorización y horario: la Ley 2300 de
  2023 limita horarios para cobranza y mercadeo, y aquí se aplica el mismo cuidado por prudencia),
  copiar nombres y citas a Google (Google como encargado del tratamiento), y la autorización declarada
  en recepción.
- Costos: Twilio por minuto, plantillas de utilidad de Meta y el tope mensual de llamadas por cuenta.
