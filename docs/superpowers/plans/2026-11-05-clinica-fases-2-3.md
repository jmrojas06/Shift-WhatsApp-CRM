# Plan: Clínica Fases 2 y 3 (calendario, Google Calendar, llamadas por pasos, después de la cita)

Diseño aprobado: `docs/superpowers/specs/2026-11-05-clinica-fases-2-3-design.md` (léelo antes de tu
tarea; manda sobre este plan si chocan, y avísalo en tu informe).
Rama: `feat/clinica-fases-2-3`. Worktree:
`C:\Users\Game Station\Documents\JoseRojas\SHIFT_DIGITAL\Shift-WhatsApp-CRM\.claude\worktrees\clinica-odontologia`.

## Reglas para todo implementador

1. **Lee `AGENTS.md`**: Next.js 16 con cambios. Antes de escribir una ruta, una página o usar `after()`,
   lee la guía en `node_modules/next/dist/docs/` (p. ej. `01-app/03-api-reference/04-functions/after.md`).
   En las rutas dinámicas `params` es una `Promise`.
2. **TDD**: escribe primero la prueba que falla, luego el código. Vitest (`npx vitest run <ruta>`).
3. **Nunca toques la red ni la base real.** `.env.local` apunta a PRODUCCIÓN. No corras `next dev` contra
   ella para probar escrituras, nunca `supabase db push`, nunca uses `SUPABASE_SERVICE_ROLE_KEY` real.
   Google, Twilio/Telnyx y Meta se prueban con `fetch` falso.
4. **Commit local al final de tu tarea** con `git add <tus archivos>` (nunca `git add -A` ni `.`) y un
   mensaje convencional en inglés (`feat(agenda): ...`). Termina el mensaje con una línea en blanco y
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Nunca `git push`**, nunca
   `git stash` sin etiqueta, nunca reescribas historia.
5. Antes de commitear: `npx vitest run` de los archivos tocados, `npx tsc --noEmit` y
   `npx eslint <tus archivos>` limpios. Si una prueba ajena ya fallaba antes, dilo en el informe.
6. Comentarios y textos de UI **en español**, simples, como el resto del código. Identificadores en inglés.
7. Patrones del repo que debes copiar, no reinventar:
   - Rutas: `requireRole('agent'|'admin')` y `toErrorResponse` de `@/lib/auth/account`; pruebas con
     `src/app/api/verticals/agenda/_lib/route-testing.ts` y el fake de Supabase que ya usan las rutas de
     agenda (`route.test.ts` vecinos).
   - Cron: copia `src/app/api/verticals/agenda/reminders/run/route.ts` (secreto `AUTOMATION_CRON_SECRET`,
     `maxDuration`, respuesta 500 + `notifyAlert` si el runner lanza).
   - Envío de WhatsApp: `createAgendaSender` (`agent/index.ts`) con la ventana abierta; plantilla con
     `sendTemplateMessage` + variantes de teléfono + persistencia en `messages`, como
     `agent/reminders-send.ts`. Ventana: `hasRecentCustomerMessage` (`agent/reminders.ts`).
   - Avisos en la app: `insertNotification` (`agent/db.ts`). `conversation_id` puede ser null en la tabla.
   - Hora: `agent/time.ts` (`zonedParts`, `startOfZonedDay`, `addDaysToKey`, `zonedTimeToUtc`), zona
     America/Bogota.
   - Cifrado: `encrypt`/`decrypt` de `@/lib/whatsapp/encryption`.
   - Contactos: `findOrCreateContact` (`src/lib/api/v1/contacts.ts`) y
     `src/lib/whatsapp/resolve-conversation.ts` para la conversación.
   - Clínica: `src/modules/clinica/*` (`loadClinicContext`, `latestConsent`, `recordConsent`,
     `insertPatient`, `listPatients`, `loadClinicReminderInfo`).
8. Un paciente es dato personal: nunca pongas su nombre o teléfono en logs ni en mensajes de error.
9. **Trabajan varios agentes a la vez en este worktree**, en archivos distintos. Toca solo los archivos
   de tu tarea. Si `tsc` o `eslint` marcan errores solo en archivos que no son tuyos (los está
   escribiendo otro agente), ignóralos y menciónalos. Si `git commit` falla por `index.lock`, espera unos
   segundos y reintenta. Nunca hagas commit de archivos ajenos.
10. Informe final (≤ 250 palabras): qué hiciste, archivos, SHA del commit, pruebas corridas con su
   resultado, y cualquier desvío del diseño.

## Orden y dependencias

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 (Fase 2) · T9 → T10 → T11 (Google) · T12 → T13 → T14 → T15 (voz)
· T16 → T17 (Fase 3) · T18 (crons y docs) · T19 (revisión y verificación final).
Cada tarea parte del commit de la anterior.

---

## T1. Migración 056

**Archivos:** `supabase/migrations/056_clinica_recepcion_seguimientos.sql` (nuevo),
`supabase/ci/verify-schema.sql`, `src/verticals/agenda/rls-policies.test.ts`.

Contenido exacto en el diseño §3, con las tablas de voz como las define §6.4. Requisitos:

- Idempotente (`IF NOT EXISTS`, `DROP ... IF EXISTS` antes de `CREATE TRIGGER/POLICY`), aditiva, con
  comentario de cabecera como 055 (qué hace, orden: después de 055, Postgres ≥ 15).
- FK compuestas `(account_id, appointment_id) REFERENCES booking_appointments(account_id, id)`: si
  `booking_appointments` no tiene `UNIQUE (account_id, id)`, créalo (`CREATE UNIQUE INDEX IF NOT EXISTS`
  + constraint) igual que hizo 055 con otras tablas; revisa 055 primero.
- RLS en todas las tablas nuevas, con `is_account_member(account_id[, role])` (patrón 017/050/055):
  - `agenda_calendar_connections`: RLS prendida, **sin ninguna política** (solo service role), y
    `REVOKE ALL ... FROM anon, authenticated`.
  - `booking_call_settings`: SELECT miembros; INSERT/UPDATE admin.
  - `booking_calls`: SELECT miembros; INSERT `agent` solo con `channel = 'manual'`,
    `direction = 'outbound'` y `created_by = auth.uid()`; sin UPDATE/DELETE para clientes.
  - `booking_call_settings.inbound_number`: índice único parcial `WHERE inbound_number IS NOT NULL`.
  - `clinic_followups`, `clinic_ratings`, `clinic_day_closes`: SELECT miembros; sin escrituras de clientes.
- Trigger `mark_booking_google_dirty` (función `plpgsql`, `SET search_path = public`) como en el diseño.
  Debe correr ANTES que `set_updated_at` no importa; solo toca `google_dirty`.
- Índices: los del diseño, más `booking_calls (account_id, created_at)`, `booking_calls (appointment_id)`,
  `clinic_followups (account_id, status, due_at)`.
- CHECK de valores y largos para cada texto (copia el estilo de 055: `char_length(...) <= N`).
- `verify-schema.sql`: agrega asserts DENTRO del único bloque `DO` (lee el comentario final del archivo):
  tablas y columnas nuevas, RLS prendida, que `agenda_calendar_connections` no tenga políticas y que
  anon/authenticated no tengan SELECT sobre ella, y que el trigger exista.
- `rls-policies.test.ts`: amplía el parser/pruebas para las políticas nuevas (como se hizo con 055).

**Verificación local obligatoria:** Postgres 18 está instalado en `C:/Program Files/PostgreSQL/18/bin`.
Crea un clúster temporal en el scratchpad (`initdb -D <tmp> -U postgres -A trust`, `pg_ctl -D <tmp> -o
"-p 55432" start`), crea los stubs mínimos de Supabase (roles `anon`, `authenticated`, `service_role`;
esquema `auth` con `auth.users(id uuid primary key)` y `auth.uid()`; extensiones que pidan las
migraciones) y aplica **todas** las migraciones en orden 001…056 con `psql -v ON_ERROR_STOP=1`. Luego
aplica 056 **otra vez** (idempotencia) y corre `verify-schema.sql`. Prueba a mano: el trigger prende
`google_dirty` al cambiar `starts_at` y no al cambiar solo `google_synced_at`; el único de intentos del
robot rechaza un duplicado. Para el clúster al terminar y bórralo. Pon en el informe los comandos y la
salida resumida.

## T2. Confirmación del paciente y cupo de sillones

**Archivos:** `src/verticals/agenda/agent/db.ts`, `agent/internal-backend.ts`, `agent/chairs.ts` (nuevo),
sus pruebas.

- `markAppointmentConfirmed` escribe también `attendance_confirmed_at: confirmedAtIso`. Ajusta las pruebas
  que comparan el UPDATE.
- `chairs.ts`: `export function chairsFreeAt(args: { startsAt: Date; endsAt: Date; chairCount: number |
  null; active: { startsAt: Date; endsAt: Date }[] }): boolean` → `true` si `chairCount` es null o si las
  citas activas que se cruzan (`a.start < endsAt && a.end > startsAt`) son menos que `chairCount`. Y
  `export async function loadChairContext(db, accountId, fromIso, toIso): Promise<{ chairCount: number |
  null; active: {startsAt; endsAt}[] }>`: lee `chair_count` de la única `clinic_locations` activa de la
  cuenta y las citas `pending|confirmed` de **toda** la cuenta en el rango. Lanza si no puede leer.
- `createInternalBackend` recibe `clinic?: boolean` (el controlador pasa `true` cuando
  `modules` incluye `clinica`). Con `clinic`, `loadRange` carga además el contexto de sillones y
  `slotsForDay` descarta las horas sin silla libre. Sin `clinic`, conducta idéntica (pruebas existentes
  intactas). Busca todos los `createInternalBackend(` y pásale la bandera donde haya módulos.
- Pruebas: cupo null, cupo lleno, cruce parcial, cita cancelada no cuenta, y que una cuenta sin clínica
  no hace la lectura extra.

## T3. Reglas puras de citas desde el panel

**Archivo:** `src/verticals/agenda/panel-booking.ts` (nuevo) + prueba.

```ts
export type PanelBookingRejection =
  | 'invalid_input' | 'past' | 'staff_not_for_service' | 'outside_hours'
  | 'not_editable' | 'chairs_full'
export function validatePanelBooking(args: {
  startsAt: Date; durationMinutes: number; now: Date
  staffServesService: boolean
  workBlocks: { weekday: number; startTime: string; endTime: string }[]  // del profesional
  timeOff: { startsAt: Date; endsAt: Date }[]
  outsideHoursOk: boolean
  chairs: { chairCount: number | null; active: { startsAt: Date; endsAt: Date }[] } | null
}): { ok: true; endsAt: Date } | { ok: false; code: PanelBookingRejection }
export function canMove(status: AppointmentStatus, startsAt: Date, now: Date): boolean // pending|confirmed y futura
export const PANEL_BOOKING_MESSAGES: Record<PanelBookingRejection | 'slot_taken' | 'stale', string>
```

- "Dentro del horario" = el intervalo entero cae dentro de un bloque del día de la semana local y no
  cruza un `timeOff`. Usa los helpers de `time.ts`.
- Mensajes en palabras simples (diseño §4.3), p. ej. `slot_taken`: "Ese profesional ya tiene una cita a
  esa hora.", `stale`: "Alguien cambió esta cita mientras la editabas. Recarga e intenta de nuevo."
  Usa las etiquetas de la cuenta (`AgendaLabels`) si el texto nombra al profesional: acepta un
  parámetro `labels` en una función `panelBookingMessage(code, labels)`.

## T4. Rutas de crear, mover y cancelar

**Archivos:** `src/app/api/verticals/agenda/appointments/route.ts` (nuevo, POST),
`src/app/api/verticals/agenda/appointments/[id]/route.ts` (PATCH ampliado),
`src/verticals/agenda/panel-booking-repo.ts` (nuevo, acceso a datos), pruebas de ambos.

- POST según diseño §4.3. Pasos: `requireRole('agent')` → validar cuerpo (uuid, ISO, largos) → cargar
  servicio (activo, de la cuenta), profesional (activo, atiende el servicio vía la tabla de relación que
  ya usa el bot), bloques, time off y, si la cuenta tiene `clinica`, sillones → `validatePanelBooking`
  → contacto (`findOrCreateContact` con `ctx.userId`) → conversación (helper de
  `resolve-conversation.ts`; si ninguno sirve sin enviar mensaje, crea la fila de `conversations` con
  los mismos campos que usa ese helper) → paciente (clínica) → consentimiento de recepción (clínica,
  §4.3) → `insertAppointment` con `createdVia: 'dashboard'`, `created_by`, `status: 'confirmed'`,
  `confirmedAtIso` ahora. Amplía los tipos de `insertAppointment` (`createdVia: 'bot' | 'dashboard'`,
  `createdBy?: string`) sin cambiar lo que manda el bot. 23P01 → 409 `slot_taken`.
- Respuesta: `{ id, notified: boolean, notify_error?: string }`. El aviso (T5) se llama después de
  guardar y nunca deshace la cita. Mientras T5 no exista, deja la llamada detrás de una función
  inyectable para probar.
- PATCH: conserva el cambio de estado actual tal cual y agrega `action: 'move' | 'cancel'` (§4.4).
  Mover: bloqueo optimista con `.eq('updated_at', leído)`; si no actualiza filas → 409 `stale`. Pone a
  null `reminder_sent_at`, `reminder_2h_sent_at`, `attendance_confirmed_at`. Valida igual que crear
  (excluyendo la propia cita de los ocupados y del cupo). Cancelar: `status cancelled`, `cancelled_at`,
  `cancel_reason` (máx. 200, por defecto 'clinic').
- Después de guardar (crear, mover, cancelar, cambio de estado): `after(() => kickCalendarSync(accountId))`
  — en esta tarea crea `src/verticals/agenda/calendar-kick.ts` con una función que por ahora no hace nada
  y que T10 llenará.
- Pruebas: roles (viewer 403), cuenta ajena 404, choque 409, fuera de horario 409 y con
  `outside_hours_ok` pasa, sillones llenos 409, contacto nuevo con teléfono inválido 400, stale 409,
  mover borra marcas, cancelar escribe motivo, clínica sin declaración de recepción no inserta
  consentimiento.

## T5. Avisar al paciente y "Agendar otra"

**Archivos:** `src/verticals/agenda/notify-patient.ts` (nuevo), `agent/state.ts` (id `book:again`),
`agent/controller.ts` (tap), pruebas.

- `notifyPatient(args: { db; accountId; appointmentId; kind: 'booked' | 'moved' | 'cancelled'; now })`
  → `{ sent: true; channel: 'text' | 'template' } | { sent: false; error: string }`. Nunca lanza.
  Carga cita, cuenta, contacto, conversación, profesional, servicio (solo si NO es clínica), paciente y
  sede (clínica, con `loadClinicReminderInfo` o equivalente). Ventana abierta → texto con
  `createAgendaSender` (cancelada: con botón "Agendar otra" `book:again`). Cerrada → plantilla del
  diseño §4.5 con `quickReplyPayloads` cuando tiene botón. Variables en el orden exacto de la tabla del
  diseño. Textos centralizados en `src/verticals/agenda/texts.ts` (o el de clínica) para que el panel y
  la doc los citen.
- El texto guardado en `messages` es el equivalente legible, como en los recordatorios.
- Bot: `book:again` (tap) abre el flujo de reservas como lo hace el botón "Agendar" del menú; pásalo por
  la misma ruta de `isSystemTap` para que funcione aunque haya una persona a cargo? **No**: con humano a
  cargo se suelta como cualquier mensaje. Sin clínica también funciona.
- Conecta `notifyPatient` en las rutas de T4 cuando `notify` es true.
- Pruebas con fake db y sender/plantilla falsos: ventana abierta/cerrada, clínica sin procedimiento en
  ninguna variable, error de Meta → `sent: false` con mensaje, cancelada lleva el payload.

## T6. Horas libres para el panel

**Archivo:** `src/app/api/verticals/agenda/slots/route.ts` (nuevo, GET) + prueba.

`GET ?service_id&staff_id(opcional)&date=YYYY-MM-DD&exclude=<cita>` → `{ slots: [{ starts_at,
staff_ids }] }` usando `createInternalBackend({ clinic })`.getDaySlots con `now` real. `requireRole('agent')`.
`exclude` sirve al mover (la propia cita no ocupa). Si el backend no admite `exclude`, agrega un parámetro
opcional `excludeAppointmentId` a `listBusy`/carga de sillones sin cambiar las llamadas existentes.

## T7. Calendario `/agenda/calendario`

**Archivos:** `src/app/(dashboard)/agenda/calendario/page.tsx`, `_components/calendar-grid.tsx`,
`_components/new-appointment-dialog.tsx`, `_components/appointment-detail-dialog.tsx`,
`src/verticals/agenda/calendar-layout.ts` (puro: posiciona bloques, solapes en columnas, rango horario) +
prueba, enlace "Ver calendario" en `src/app/(dashboard)/agenda/page.tsx`.

- **Antes de escribir UI** carga las skills `taste-skill` (design-taste-frontend) y `design-md-library`
  y sigue la dirección aprobada del CRM: paleta suave, primero la experiencia, tema del sistema (lee la
  memoria `crm-ui-polish-direction` si está a tu alcance y `docs/superpowers/specs/2026-10-22-ui-polish-design.md`).
  Usa los componentes de `src/components/ui/*` existentes y `lucide-react`. Nada de librerías nuevas.
- Diseño §4.2. Lee citas, profesionales, bloques y time off con el cliente Supabase del navegador (RLS),
  igual que `/agenda`. Escribe solo por las rutas de T4/T6.
- `calendar-layout.ts`: función pura `layoutDay(appts, { startHour, endHour })` → bloques con `top`,
  `height` (en % o minutos) y `lane/lanes` para solapes; `visibleRange(workBlocks)` (6–22 por defecto,
  ajustado). Pruébala.
- Nueva cita: búsqueda de contacto por nombre/teléfono (consulta `contacts` con `ilike`, límite 8), o
  "Contacto nuevo" (nombre y celular con +57 sugerido). Clínica: elegir paciente del contacto o
  nombre nuevo. Servicio, profesional, día y hora: la hora sale de T6, con "Otra hora" manual. Si la
  ruta responde `outside_hours`, pregunta "¿Agendar igual?" y reintenta con `outside_hours_ok`.
  Interruptor "Avisar por WhatsApp" prendido. Al terminar, toast con `sonner` ("Cita guardada" y, si
  `notify_error`, "…pero no se pudo avisar por WhatsApp").
- Detalle: datos, estado, Mover (diálogo con día/hora/profesional y "Avisar"), Cancelar (confirmación,
  motivo opcional, "Avisar"), Atendida / No vino (ruta de estado existente), Abrir conversación.
- Respeta `canSendMessages`/rol: viewer ve el calendario sin botones de escritura (`GatedButton`).
- Celular: la vista día se desplaza en horizontal por columnas; la semana muestra lista por día.
- **Revisión visual:** crea `src/app/(dev)/calendario-preview/page.tsx` que en producción hace
  `notFound()` y en desarrollo renderiza `CalendarGrid` con datos falsos en memoria (sin Supabase). Revisa
  el middleware para que esa ruta no exija sesión **solo** en desarrollo. Arranca `next dev` con la letra
  `C:` en mayúscula y `SWC_NATIVE_BINDING_CACHE=C:\Users\Game Station\.swc-cache`, abre esa ruta con la
  skill `playwright-cli`, saca capturas en 1440×900 y 390×844 (claro y oscuro) y guárdalas en el
  scratchpad; corrige lo que se vea mal. **No abras páginas que lean la base.** Para el servidor al terminar.
  Luego audita con la skill `web-design-guidelines` y corrige.

## T8. "Para llamar" y "Sin marcar" en `/agenda`

**Archivos:** `src/verticals/agenda/call-list.ts` (puro + carga), `src/app/api/verticals/agenda/calls/route.ts`
(GET lista, POST manual), `src/app/(dashboard)/agenda/_components/call-list-section.tsx`,
`_components/unmarked-section.tsx`, `agenda/page.tsx`, pruebas.

- Lista según diseño §4.7. `GET` devuelve filas ya armadas (paciente o contacto, teléfono, hora,
  profesional, intentos, último resultado del robot). `POST { appointment_id, outcome: 'confirmed' |
  'cancelled' | 'no_response' | 'wrong_number', notify? }` inserta `booking_calls` manual (`attempt` =
  manuales previos + 1, tope 3 en la base → si ya hay 3, igual responde 200 sin insertar y avisa) y aplica:
  confirmed → `attendance_confirmed_at`; cancelled → cancela como T4 (con aviso opcional).
- "Llamar con el robot ahora": botón visible solo si las llamadas están prendidas; llama a la ruta de T13
  (`POST /api/verticals/agenda/calls/robot`). Mientras T13 no exista, el botón queda detrás de una bandera.
- "Sin marcar": citas de hoy ya empezadas en pending/confirmed, con Atendió / No vino (ruta de estado).
  Para todas las cuentas de agenda (es solo una lista).
- Diseño con las mismas skills de T7. Pruebas del armado de la lista (orden por hora, exclusiones).

## T9. Cliente de Google Calendar

**Archivo:** `src/lib/google/calendar-api.ts` (nuevo) + prueba con `fetch` falso.

- `buildAuthUrl({ clientId, redirectUri, state })` con `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=true`, scopes `openid email https://www.googleapis.com/auth/calendar.events
  https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
- `exchangeCode`, `refreshAccessToken` (errores tipados: `GoogleAuthError` con `code === 'invalid_grant'`),
  `revokeToken`, `fetchUserEmail` (userinfo), `listWritableCalendars` (calendarList con
  `minAccessRole=writer`), `putEvent(calendarId, eventId, body)` (PUT, 404 → POST con `id`),
  `deleteEvent` (404/410 = ya no está, no es error). Todos con `fetch` inyectable y timeout de 10 s.
- `eventIdForAppointment(uuid)` = uuid sin guiones en minúsculas (válido en base32hex).
- `buildEventBody({ title, description, startIso, endIso, status, timeZone })`.
- Nunca registres tokens. Pruebas de cada función con respuestas falsas, incluida la cadena PUT→404→POST.

## T10. Sincronización de citas con Google

**Archivos:** `src/verticals/agenda/calendar-sync.ts` (nuevo), `calendar-kick.ts` (llenar),
`src/app/api/verticals/agenda/calendar-sync/run/route.ts` (cron), pruebas.

- `syncAccountCalendar({ db, accountId, now, fetchImpl? })` según diseño §5 (tope 50 por corrida,
  ventana −1 día / +180 días, mapeo de estados y títulos, calendario por profesional o el general,
  borrar del calendario anterior, limpiar `google_dirty` con `.eq('updated_at', leído)`, error por cita,
  `invalid_grant` → conexión `revoked` + `insertNotification` al dueño, una vez).
- Título y descripción con textos centralizados. **Sin teléfono, sin notas, sin respuestas extra.**
  Clínica: nombre del paciente (`clinic_patients.full_name`) y la atención. Otras: servicio y nombre del
  contacto.
- `runCalendarSync({ db, now })`: todas las conexiones `active`, una tras otra, con resumen.
- `kickCalendarSync(accountId)`: llama a `syncAccountCalendar` con `supabaseAdmin()` y traga errores
  (log sin datos personales).
- Cron: igual que recordatorios.
- Pruebas: cada estado, cambio de calendario, carrera (updated_at distinto no limpia), invalid_grant,
  cuenta sin conexión no hace nada.

## T11. Conectar Google desde la configuración

**Archivos:** `src/app/api/integrations/google-calendar/{connect,callback,disconnect,calendars,settings}/route.ts`,
`src/app/(dashboard)/agenda/configuracion/_components/google-calendar-section.tsx`, `configuracion/page.tsx`,
`_components/staff-section.tsx` (selector de calendario por profesional), pruebas de rutas.

- connect: `requireRole('admin')`; sin `GOOGLE_CLIENT_ID/SECRET` → 503 con mensaje claro. `state` =
  32 bytes aleatorios en base64url, cookie `gcal_state` httpOnly, `secure` en producción, `sameSite=lax`,
  10 min, path del callback. Redirige.
- callback: compara `state` con la cookie en tiempo constante, borra la cookie, `requireRole('admin')`,
  cambia el código, guarda con service role (`supabaseAdmin()`) `refresh_token_encrypted = encrypt(...)`,
  correo, `status active`, `connected_by`. Marca `google_dirty = true` en las citas activas de la cuenta
  de −1 a +180 días. Redirige a `/agenda/configuracion?google=ok` (o `?google=error`). Si Google no
  devuelve refresh token → error claro ("Quita el acceso de Shift en tu cuenta de Google y vuelve a
  conectar").
- disconnect: revoca (best effort) y borra la fila. calendars: lista con el token. settings (GET/PATCH):
  estado seguro (`connected`, `google_email`, `status`, `last_error`, `last_sync_at`,
  `default_calendar_id`) y guardar el calendario general; el de cada profesional se guarda en
  `booking_staff.google_calendar_id` por la ruta de staff existente (amplíala).
- Tarjeta con las skills de diseño: estado, Conectar/Reconectar/Desconectar, selector de calendario,
  aviso "Los eventos no incluyen teléfonos ni notas".
- Pruebas: roles, state inválido, sin refresh token, que la respuesta de settings nunca trae el token.

## T12. Núcleo de voz (puro)

Diseño §6.1 y §6.4. **Archivos:** `src/lib/voice/texml.ts`, `src/lib/voice/telnyx.ts`,
`src/lib/voice/tokens.ts`, `src/lib/voice/co-holidays.ts`, `src/lib/voice/hours.ts`,
`src/verticals/agenda/voice/scripts.ts`, `src/verticals/agenda/voice/settings.ts` (lectura y validación de
`booking_call_settings`), pruebas de todos.

- `texml.ts`: constructor tipado que produce XML válido con escape de `& < > " '`:
  `say(text, voice)`, `gather({ action, numDigits, timeout }, children)`, `dial({ action, timeout,
  timeLimit, callerId }, numbers)`, `redirect(url)`, `pause(s)`, `hangup()`, `response(children)`. Sin
  atributo `method` en `Gather` (Telnyx no lo tiene); `Dial` con `method="POST"`.
- `telnyx.ts`: `interface VoiceProvider { startCall(args: { to; from; url; statusCallback }):
  Promise<{ ok: true } | { ok: false; error: string }> }` y `createTelnyxProvider({ apiKey, accountSid,
  appId, fetchImpl? })` con el POST del diseño (form-urlencoded, `StatusCallbackEvent=completed`,
  `Timeout=25`, timeout de red 10 s). `verifyTelnyxSignature({ rawBody, signature, timestamp,
  publicKeyB64, nowSec })` con Ed25519 y el prefijo SPKI; prueba con un par de claves generado en la
  prueba (`crypto.generateKeyPairSync('ed25519')`). `parseForm(rawBody)`.
- `tokens.ts`: `voiceToken(subject)` = HMAC-SHA256 base64url con `VOICE_WEBHOOK_SECRET`;
  `checkVoiceToken(subject, t)` en tiempo constante; sin secreto → siempre falso.
  `voiceUrl(path, params)` con base `NEXT_PUBLIC_APP_URL` (sin barra final) que agrega `t`.
- `co-holidays.ts`: `colombianHolidays(year): string[]` ('YYYY-MM-DD') con los fijos (1 ene, 1 may,
  20 jul, 7 ago, 8 dic, 25 dic), los de Ley Emiliani que se corren al lunes (6 ene, 19 mar, 29 jun,
  15 ago, 12 oct, 1 nov, 11 nov) y los de Pascua (jueves y viernes santo; Ascensión +43, Corpus +64 y
  Sagrado Corazón +71 días desde Pascua, ya en lunes). Pruebas con los festivos oficiales de 2026 y 2027.
- `hours.ts`: `isWithinOfficeHours(officeHours, now)` (festivo = cerrado), `isWithinCallWindow(settings,
  now)` (lun–sáb según `call_saturday`, nunca domingo ni festivo, entre `window_start` y `window_end`),
  `formatOfficeHours(officeHours)` → "de lunes a viernes de 8 a. m. a 6 p. m. y los sábados de 8 a. m.
  a 1 p. m." (agrupa días seguidos con el mismo horario). Hora de Bogotá con `time.ts`.
- `scripts.ts`: TODAS las frases de §6.2 y §6.3 como funciones puras en español (`outboundMenu({
  business, patient, day, time, staff })`, etc.). Fechas y horas habladas ("el martes 10 de noviembre",
  "a las 3 y 30 de la tarde"), sin abreviaturas que la voz lea mal ("a. m."). Prueba que ninguna frase
  incluya el nombre del servicio.
- `settings.ts`: `loadCallSettings(db, accountId)` con valores por defecto si no hay fila;
  `validateCallSettingsPatch(body)` para la ruta de T15 (E.164, 0–3 asesores, horas `HH:MM`,
  rangos de enteros, largo de `info_text`).

## T13. Llamadas salientes

Diseño §6.2. **Archivos:** `src/verticals/agenda/voice/outbound-runner.ts`, `voice/outbound-flow.ts`
(máquina de pasos pura: estado + tecla → { xml, efectos }), `voice/effects.ts` (aplicar efectos: confirmar,
cancelar + `notifyPatient`, aviso), `src/app/api/verticals/agenda/calls/run/route.ts` (cron),
`src/app/api/voice/telnyx/outbound/route.ts` (instrucciones y `Gather`), `src/app/api/voice/telnyx/status/route.ts`,
`src/app/api/voice/telnyx/dial-result/route.ts` (compartida con T14), `src/app/api/verticals/agenda/calls/robot/route.ts`
(llamar ya, `requireRole('agent')`), `src/app/api/verticals/agenda/calls/test/route.ts` (prueba,
`requireRole('admin')`), pruebas.

- Runner con todas las condiciones del diseño; reclamo por insert con el único (23505 = otra corrida
  ganó). Credenciales ausentes → no hace nada y lo dice en el resumen.
- Las rutas de webhook: leen el cuerpo crudo una sola vez (`await request.text()`), verifican `t` y la
  firma si viene, cargan la fila por `call` (y la cuenta), guardan `provider_call_sid` la primera vez, y
  responden `Content-Type: text/xml`. El estado del menú va en la query (`step`, `loop`), nunca en
  memoria. Cada efecto es idempotente: confirmar o cancelar una cita que ya cambió no repite nada, y
  dice "Esta cita ya no está activa" si no está activa.
- `status`: mapea `CallStatus` (completed, busy, no-answer, failed, canceled) a `status`, guarda
  `duration_seconds` y `finished_at`; si terminó sin resultado, `outcome = 'no_response'`.
- La prueba de llamada usa una fila con `appointment_id` null y un guion de ejemplo; no toca citas.
- Pruebas: cada camino de teclas, doble confirmación de cancelar, token inválido 403, firma inválida 403,
  idempotencia ante reintentos, condiciones del runner (festivo, domingo, tope del mes, intentos,
  reintento, etiqueta `no-llamar`, autorización revocada).

## T14. Llamadas entrantes 24/7

Diseño §6.3. **Archivos:** `src/verticals/agenda/voice/inbound-flow.ts` (pura), `voice/inbound-effects.ts`,
`src/app/api/voice/telnyx/inbound/route.ts`, plantilla `agendar_por_llamada` en `notify-patient.ts` o un
módulo hermano, pruebas.

- Cuenta por `To` (`inbound_number`). Crea la fila `inbound` al primer pedido (usa `CallSid` para no
  duplicar si Telnyx reintenta). Menú con 9 (solo clínicas), 1, 2, 3 y 0 según el diseño; `menu_path`
  acumula las teclas (máx. 60).
- 0 en horario → `dial` a `advisor_phones` con `callerId = inbound_number`, `action` = dial-result. Fuera
  de horario → frase del diseño con `formatOfficeHours` y vuelta al menú.
- 1 → contacto por el número (crear si no existe, con nombre = número), conversación, y envío del enlace
  para agendar (texto si la ventana está abierta, plantilla si no) con botón `book:again`.
- 2 → próxima cita activa del contacto y submenú confirmar/cancelar/volver.
- Nota interna en la conversación ("Llamó: …"): usa el mecanismo de notas que ya tenga la bandeja; si no
  hay, omítelo y dilo en el informe.
- Pruebas: cada rama, fuera de horario, festivo, sin asesores, dial sin respuesta, número desconocido,
  atención entrante apagada.

## T15. Configuración de llamadas

Diseño §6.5. **Archivos:** `src/app/api/verticals/agenda/call-settings/route.ts` (GET miembros,
PATCH admin, con `validateCallSettingsPatch`; devuelve también lo usado en el mes),
`src/app/(dashboard)/agenda/configuracion/_components/calls-section.tsx`, `configuracion/page.tsx`, pruebas.

- Tarjeta con las skills de diseño de T7. Interruptores, números, horario de atención por día (con
  "copiar a lunes–viernes"), texto de horario y dirección, ventana de salientes, intentos, tope y uso del
  mes, y "Probar llamada" (campo de número + botón). Si faltan las variables de Telnyx, la tarjeta lo dice
  y deja guardar pero no prender.
- Aviso visible: "Las llamadas tienen costo por minuto. Las salientes solo salen de lunes a sábado en tu
  ventana y nunca en festivos."

## T16. Seguimientos después de la cita (runner)

**Archivos:** `src/modules/clinica/followups.ts` (nuevo: reglas puras + runner), `followups-send.ts`
(envío), `src/app/api/verticals/clinica/followups/run/route.ts` (cron), `src/modules/clinica/texts.ts`,
pruebas.

- Diseño §7.1–7.3. Funciones puras probadas: `followupSchedule(appt, serviceHasAftercare)` →
  `[{kind, dueAt}]` (10:00 local del día +1 y +2), `ratingSkipReason({...})`, `commonSkipReason({...})`.
- Runner `runClinicFollowups({ db, send, now, limit })`: cuentas con `clinica` (usa `hasModule`), siembra
  con `upsert(..., { onConflict: 'appointment_id,kind', ignoreDuplicates: true })`, reclama con UPDATE
  condicional, envía, revierte con `attempts + 1`, `failed` a los 3. Cierre del día (§7.3) con
  `clinic_day_closes` (insert; conflicto = ya avisado).
- Envío: ventana abierta → texto/botones (`createAgendaSender`); cerrada → plantillas
  `cuidados_cita_clinica`, `como_sigues_clinica`, `calificacion_visita_clinica` con `quickReplyPayloads`
  `fu:cuidados:<id>`, `fu:bien|molestias|ayuda:<id>`, `rt:bien|regular|mal:<id>`. Variables: paciente y
  negocio. Nunca el procedimiento en la plantilla. Los cuidados (texto del servicio) solo salen con la
  ventana abierta.
- Pruebas: siembra idempotente, cada omisión, revertir y fallar, cierre del día una vez, cuenta sin
  clínica ignorada.

## T17. Respuestas a los seguimientos en el bot

**Archivos:** `src/verticals/agenda/agent/state.ts` (`parseFollowupTap`), `agent/steps/followup-taps.ts`
(nuevo), `agent/controller.ts` (enganche junto al de recordatorios), `agent/index.ts`
(`mustNotBeDropped` y bypass del candado), pruebas con `testing/clinic-harness.ts`.

- `parseFollowupTap(id)` → `{ type: 'fu', action: 'cuidados'|'bien'|'molestias'|'ayuda', followupId } |
  { type: 'rt', value: 'bien'|'regular'|'mal', followupId } | null`. Solo payloads, nunca etiquetas.
- Diseño §7.4. Verifica que el seguimiento sea de la cuenta y del contacto; si no, se ignora sin
  responder (`consumed: true`). `rt` guarda una sola vez (único por `followup_id`; conflicto = ya
  calificó, responde igual el agradecimiento). Molestias/ayuda: `response`, aviso prioritario
  (`insertNotification` al dueño y al asignado), pasar a persona con el mismo camino que "Hablar con una
  persona" del bot, y texto + `urgency_alarm_text`.
- Funciona aunque una persona lleve el hilo (es respuesta a un mensaje del sistema), como `rem:*`.
- Pruebas: cada acción, id ajeno, calificación repetida, hilo humano, Regular/Mal avisan.

## T18. Crons, variables y documentación

**Archivos:** `vercel.json`, `deploy/vps/crontab.example`, `.env.example`, `docs/clinica-montaje.md`,
`docs/agenda-recordatorios.md` (si menciona confirmación), `docs/superpowers/specs/2026-11-02-odontologia-design.md`
(§9: Fases 2 y 3 hechas, enlace al nuevo diseño).

- Crons: `calendar-sync/run` cada 5 min; `calls/run` cada 10 min; `clinica/followups/run` cada 10 min.
- `.env.example`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TELNYX_API_KEY`, `TELNYX_ACCOUNT_SID`,
  `TELNYX_TEXML_APP_ID`, `TELNYX_PUBLIC_KEY`, `VOICE_WEBHOOK_SECRET`, `VOICE_DEFAULT_VOICE`, con
  comentario en español.
- Plantillas: 8 (agrega `agendar_por_llamada`). Telnyx paso a paso: cuenta, número local (nombre, apellido
  y dirección), app de TeXML con método POST y URL de entrada
  `{NEXT_PUBLIC_APP_URL}/api/voice/telnyx/inbound?t=<voiceToken("inbound")>` (explica cómo generar `t`
  con un comando de una línea), clave pública, saldo.
- `clinica-montaje.md`: orden 055 → 056; texto exacto de las 7 plantillas de Meta (categoría,
  idioma `es`, variables numeradas, botones y payloads); Google Cloud paso a paso (pantalla de
  consentimiento "En producción", URL de retorno, por qué); voz paso a paso (cuenta, número, caller ID,
  prueba con faster-whisper); cómo prender llamadas por cuenta; pendientes para el abogado.

## T19. Revisión final y verificación

La hace el coordinador: revisión Haiku de toda la rama contra el diseño, `npm test`, `npx tsc --noEmit`,
`npm run lint`, `npm run build`, capturas finales del calendario.
