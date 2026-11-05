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
  Económicas, **activas las 24 horas** para llamadas entrantes, y con paso a un asesor solo en horario
  de atención; fuera de horario se le pide llamar en ese horario y marcar asesor.
- **Fase 3**: cierre del día, cuidados, "¿Cómo sigues?" y calificación con el enlace de Google.

Fuera de esta entrega: leer los ocupados de Google para bloquear horas (doble vía), sedes múltiples en
la Agenda de Shift, lista de espera, volver y pagar, reportes y conector Dentalink.

## 2. A quién aplica

| Pieza | Cuentas |
| --- | --- |
| Calendario, crear, mover y cancelar desde el panel | Todas las cuentas con `agenda` |
| Paciente, cupo de sillones, plantillas `_clinica` | Solo con `clinica` |
| Google Calendar | Todas con `agenda`, si el dueño lo conecta |
| Llamadas por pasos (salientes y entrantes) | Todas con `agenda`, apagadas por defecto y con un tope mensual |
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
- `booking_call_settings`: columnas en §6.4. Miembros leen, admin escribe (patrón 050).
- `booking_calls`: columnas en §6.4. Miembros leen; los agentes insertan filas `manual` de su cuenta; el
  robot escribe con service role.
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

Es un menú fijo con voz sintética, como el bot de WhatsApp: no conversa con IA. **Contesta las 24
horas** las llamadas entrantes y hace llamadas cortas para confirmar citas. Solo pasa a un asesor en el
horario de atención.

### 6.1 Proveedor: Telnyx (TeXML)

Se escogió por costo. Precios publicados, por confirmar en la cuenta:

| | Telnyx | Twilio |
| --- | --- | --- |
| Número local de Colombia | USD 13,50 al mes | USD 17,50 al mes |
| Llamada saliente a celular | USD 0,0125/min + 0,002 de TeXML | USD 0,0377/min |
| Llamada entrante | desde USD 0,065/min + 0,002 | USD 0,0945/min |
| Voz neural (Polly) | USD 0,000024 por carácter | USD 0,000032 por carácter |

Costo aproximado:
- Confirmación de 45 segundos: unos USD 0,016.
- Llamada entrante de 1 minuto: unos USD 0,07.
- Llamada entrante de 3 minutos pasada a un asesor: entre USD 0,24 y 0,34. Falta confirmar si Telnyx
  cobra USD 0,10 por cada transferencia.

Las llamadas por WhatsApp (API de Meta) se descartan por ahora:
- no permiten pasar la llamada al celular de un asesor;
- el número necesita un límite de mensajes de al menos 2.000 destinatarios;
- el paciente tiene que dar permiso antes;
- casi no ahorran.

TeXML es compatible con TwiML: el marcado (`Say`, `Gather`, `Dial`, `Hangup`, `Redirect`) sirve para
los dos proveedores. Todo queda detrás de una interfaz `VoiceProvider`, y en esta entrega solo se
programa Telnyx.

Datos técnicos de Telnyx:
- Llamada saliente: `POST https://api.telnyx.com/v2/texml/Accounts/{TELNYX_ACCOUNT_SID}/Calls`, con
  `Authorization: Bearer {TELNYX_API_KEY}` y el cuerpo `To`, `From`, `ApplicationSid`
  (`TELNYX_TEXML_APP_ID`), `Url`, `StatusCallback`, `StatusCallbackEvent=completed` y `Timeout=25`.
  La respuesta documentada no trae id. Por eso **el id de nuestra fila va en la URL**, y el `CallSid`
  se guarda cuando llega en el primer webhook.
- Firma: Ed25519 sobre `"{telnyx-timestamp}|{cuerpo crudo}"`, en las cabeceras
  `telnyx-signature-ed25519` y `telnyx-timestamp`, con 5 minutos de tolerancia. La clave pública
  (`TELNYX_PUBLIC_KEY`, base64 de 32 bytes) se envuelve con el prefijo SPKI
  `302a300506032b6570032100` para `crypto.verify`.
- Telnyx no documenta que firme el primer pedido de instrucciones. Por eso **toda URL de webhook lleva
  además `t`**, un HMAC-SHA256 con `VOICE_WEBHOOK_SECRET` del id de la llamada (o de `"inbound"`).
  Sin `t` válido se responde 403. Si llegan las cabeceras de firma y no cuadran, también 403.
- Los webhooks llegan como formulario con `CallSid`, `From`, `To` y `Digits`. El resultado de `Dial`
  trae `DialCallStatus`. La app de TeXML se configura con método POST.
- Voz: `Polly.Mia-Neural` (español de México), configurable por cuenta. Se puede probar
  `Azure.es-CO-SalomeNeural`, pero Telnyx no la documenta.

### 6.2 Llamadas salientes de confirmación

Cron `/api/verticals/agenda/calls/run` cada 10 minutos. Llama solo si se cumple todo esto:
- las llamadas salientes están prendidas en la cuenta y las credenciales están puestas;
- la cita está activa y es futura, sin `attendance_confirmed_at`;
- el recordatorio de 24 h salió hace más de `call_after_minutes`;
- faltan más de `min_lead_minutes` para la cita;
- es dentro de `window_start`–`window_end`, hora de Bogotá;
- es de lunes a sábado (sábado solo si `call_saturday`), **nunca domingo ni festivo de Colombia**. Los
  festivos se calculan en el código: fijos, Ley Emiliani y los que dependen de Pascua;
- la cita tiene menos de `max_attempts` intentos y pasaron `retry_minutes` desde el anterior;
- la cuenta está por debajo de `monthly_limit` llamadas salientes del mes;
- el contacto tiene teléfono, no tiene etiqueta de baja ni `no-llamar` y, en una clínica, no revocó la
  autorización.

Para que dos corridas no llamen dos veces, se reclama insertando la fila `queued` con su `attempt`.
Si Telnyx rechaza la llamada, la fila queda `failed` y la cita aparece en Para llamar.

Guion:
1. "Hola, soy el asistente virtual de {negocio}. Te llamamos para recordar la cita de {paciente o "tu
   cita"} el {día} a las {hora} con {profesional}. Para confirmarla, marca 1. Para cancelarla, marca
   2. Para hablar con alguien del equipo, marca 3." Se repite una vez si no marca nada.
2. **1:** se guarda `attendance_confirmed_at` y dice "Listo, tu cita quedó confirmada. Te esperamos.
   Hasta luego."
3. **2:** pregunta "¿Seguro que quieres cancelarla? Marca 1 para sí o 2 para no." Con 1 se cancela
   (`cancel_reason = 'patient_call'`), se avisa con `notifyPatient` (cancelada, con botón Agendar otra)
   y dice "Tu cita quedó cancelada. Te escribimos por WhatsApp para agendar otra." Con 2 vuelve al
   menú.
4. **3:** el resultado queda `human`, sale un aviso prioritario en la app y dice "Listo, alguien del
   equipo te va a contactar pronto. Hasta luego." En horario de atención y con asesores configurados, en
   cambio dice "Te comunico con un asesor" y conecta la llamada, igual que en §6.3.
5. Sin respuesta tras dos vueltas, el resultado queda `no_response` y dice "No recibimos respuesta.
   Hasta luego." Con otra tecla dice "No entendí" y repite.

Si la cita ya no está activa cuando contestan, dice "Esta cita ya no está activa. Hasta luego." Nunca
nombra el procedimiento.

### 6.3 Llamadas entrantes, las 24 horas

Cada cuenta tiene su `inbound_number`, único en toda la plataforma. El webhook
`/api/voice/telnyx/inbound` encuentra la cuenta por el `To`. Si no hay cuenta o la atención entrante
está apagada, dice "Este número no está disponible" y cuelga.

Menú: "Hola, gracias por llamar a {negocio}. Soy el asistente virtual." y luego:

- **9, solo clínicas:** "Si es una urgencia, marca 9." Va primero. Lee los signos de alarma de la
  clínica (`urgency_alarm_text`) y dice "Si tienes alguno de estos signos, ve a urgencias ahora".
  Después:
  - en horario, pasa a los asesores;
  - fuera de horario, pasa al teléfono de turno de la sede (`on_call_phone`) si existe;
  - si no hay a quién pasar, dice "Le avisamos al equipo y te escribirán a primera hora" y sale un
    aviso prioritario en la app.
- **1, agendar:** "Te enviamos un WhatsApp a este número para que agendes en un minuto." Sale la
  plantilla `agendar_por_llamada` (negocio), o un texto si la ventana está abierta, con el botón
  **Agendar** (`book:again`). Si el contacto no existe, se crea con el número que llamó. Si el envío
  falla, dice "No pudimos enviarte el WhatsApp. Escríbenos por WhatsApp para agendar."
- **2, mi cita:** busca el contacto por las variantes del número. Lee la próxima cita activa y ofrece 1
  para confirmar, 2 para cancelar (con doble confirmación, como §6.2) y 0 para volver. Si no hay citas,
  dice "No encontramos citas con este número. Para agendar, marca 1."
- **3, horario y dirección:** lee `info_text`. Si está vacío, lee el horario de atención generado desde
  `office_hours`. Luego vuelve al menú.
- **0, asesor:**
  - **En horario de atención** (`office_hours`, sin festivos) y con `advisor_phones`: dice "Te
    comunico con un asesor" y marca a los números a la vez (`Dial` con `timeout` 25 y `timeLimit`
    1800). Si nadie contesta, dice "En este momento no hay asesores disponibles. Le avisamos al equipo
    para que te llame", el resultado queda `advisor_missed` y sale un aviso en la app.
  - **Fuera de horario:** dice "En este momento estamos fuera del horario de atención. Atendemos
    {horario}. Si deseas hablar con un asesor, llama en ese horario y marca 0. Para agendar por
    WhatsApp, marca 1." y vuelve al menú. El resultado queda `out_of_hours`.

Sin tecla o con una tecla inválida se repite hasta dos veces, y luego dice "Gracias por llamar. Hasta
luego." La llamada entrante dura como mucho 10 minutos antes de pasar al asesor. Cada llamada entrante
queda en `booking_calls` con `direction = 'inbound'`, `from_number`, el camino del menú y el
resultado. En la conversación de WhatsApp del contacto, si existe, se anota "Llamó: {resultado}" como
nota interna, sin enviarle nada al paciente.

### 6.4 Datos (en la 056)

`booking_call_settings`:
- `provider` ('telnyx');
- `outbound_enabled` (false) e `inbound_enabled` (false);
- `inbound_number` (E.164, único cuando no es null) y `caller_id` (si es null, se usa
  `inbound_number`);
- `advisor_phones text[]` (0 a 3 números E.164);
- `office_hours jsonb`, de la forma `{"1":[["08:00","18:00"]], …, "6":[["08:00","13:00"]]}` (0 =
  domingo), y `info_text` (máx. 500);
- `call_after_minutes` (180), `min_lead_minutes` (120), `max_attempts` (2, de 1 a 3) y
  `retry_minutes` (90);
- `window_start` ('08:00'), `window_end` ('19:00') y `call_saturday` (true);
- `monthly_limit` (300), `voice` (null = `VOICE_DEFAULT_VOICE`) y `updated_at`.

`booking_calls`:
- `id`, `account_id`, `direction` ('outbound', 'inbound') y `channel` ('robot', 'manual');
- `appointment_id` (null en las entrantes, FK compuesta con CASCADE) y `contact_id` (SET NULL);
- `attempt` (de 1 a 3, null en las entrantes), `from_number` y `to_number`;
- `status` ('queued', 'calling', 'in_progress', 'completed', 'no_answer', 'busy', 'failed',
  'canceled');
- `outcome`: 'confirmed', 'cancelled', 'human', 'no_response', 'wrong_number', 'booking_link_sent',
  'advisor_connected', 'advisor_missed', 'out_of_hours', 'info', 'urgency' o null;
- `menu_path` (máx. 60), `digits` (máx. 10), `provider_call_sid`, `error` (máx. 300) y
  `duration_seconds`;
- `created_by`, `created_at` y `finished_at`.

Es único por (`appointment_id`, `attempt`) cuando `direction = 'outbound'` y `channel = 'robot'`.

### 6.5 Configuración y prueba

En `/agenda/configuracion`, la tarjeta "Llamadas" (admin) tiene:
- los interruptores de salientes y entrantes;
- los números (entrante, el que marca y los de asesores);
- el horario de atención por día, el texto de horario y dirección, la ventana de llamadas salientes y
  los intentos;
- el tope del mes con lo usado;
- el botón **"Probar llamada"**, que llama al número que se escriba con un guion de ejemplo marcado
  como prueba.

Variables de entorno: `TELNYX_API_KEY`, `TELNYX_ACCOUNT_SID`, `TELNYX_TEXML_APP_ID`,
`TELNYX_PUBLIC_KEY`, `VOICE_WEBHOOK_SECRET` y `VOICE_DEFAULT_VOICE`.

**Voz:** antes de prender una cuenta real, se graba una llamada de prueba y se revisa con faster-whisper
sin forzar el idioma. Debe salir `es` y el texto exacto; si sale otro idioma, se cambia la voz.

## 7. Fase 3: después de la cita (solo `clinica`)

Cron `/api/verticals/clinica/followups/run` cada 10 minutos. Hace tres cosas.

**7.1 Crear seguimientos.** Citas de clínica `completed` con inicio en los últimos 3 días y sin filas:
- `cuidados`, a la hora de fin de la cita (si ya pasó, sale en la siguiente corrida), solo si el
  servicio tiene `aftercare_instructions`;
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
- Crear y aprobar en Meta las 8 plantillas nuevas (`cita_agendada`, `cita_cancelada`, sus versiones
  `_clinica`, `cuidados_cita_clinica`, `como_sigues_clinica`, `calificacion_visita_clinica` y
  `agendar_por_llamada`). Meta
  puede clasificar la calificación como marketing, que cuesta más.
- Google Cloud: proyecto, credenciales OAuth, app "En producción" y, después, la verificación.
- Telnyx: cuenta, saldo, número local de Colombia (pide nombre, apellido y dirección), app de TeXML con
  método POST, clave pública, y la llamada de prueba revisada con faster-whisper.
- **Para el abogado:** llamar al paciente con voz sintética (autorización y horario: la Ley 2300 de
  2023 limita horarios para cobranza y mercadeo, y aquí se aplica el mismo cuidado por prudencia),
  copiar nombres y citas a Google (Google como encargado del tratamiento), y la autorización declarada
  en recepción.
- Costos: Telnyx por minuto (las entrantes son lo que más pesa), plantillas de utilidad de Meta y el tope mensual de llamadas por cuenta.
