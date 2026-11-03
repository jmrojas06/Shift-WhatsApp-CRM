# Módulo clínica odontológica: del primer mensaje a la calificación

Fecha: 02/11/2026 · Estado: aprobado por el usuario.
Parte de `main` (ac93c35). Depende de la Agenda armable (`2026-10-22-agenda-calendario-design.md`,
Fase 1, ya en `main`) y de los módulos combinables (`2026-10-22-modulos-ventas-a-design.md`).

Este documento es el mapa completo. Cada fase tiene después su propio plan y su PR. Las fases 5 y 6
son demasiado grandes para detallarlas aquí y tendrán su diseño aparte.

## 1. Objetivo

Que una clínica odontológica resuelva por WhatsApp lo que hoy hace su secretaria. Shift es la
recepción por WhatsApp; la historia clínica sigue donde la clínica la tenga.

Hay dos caminos con el mismo bot:

- **Agenda de Shift:** la clínica lleva sus citas en Shift. Es el camino de la primera clínica: no hay
  que pagar una API externa y nos da menos trabajo, lo que permite cobrar menos. Una sola sede en esta
  versión.
- **Conectada:** la clínica sigue con su software, de una sede o de varias. El primero es Dentalink.

Se considera logrado cuando, en cualquiera de los dos caminos:

1. Un paciente pasa del primer mensaje a una cita creada en la agenda de la clínica sin que intervenga
   una persona.
2. Toda cita recibe recordatorio, también las que creó la recepción.
3. Una cita marcada como atendida dispara los mensajes posteriores y la calificación.
4. Ninguna falla de la agenda produce una confirmación falsa.

## 2. Decisiones tomadas

| # | Decisión | Por qué |
| --- | --- | --- |
| 1 | Un solo bot con dos caminos: Agenda de Shift o software de la clínica conectado. | Decisión del usuario (02/11/2026): conectar, y arrancar con la Agenda de Shift para la primera clínica. |
| 2 | El primer conector es Dentalink. | Es el único de los revisados con documentación pública de API. |
| 3 | La primera clínica arranca con la Agenda de Shift y el conector viene después. | No hay que pagar la API de Dentalink ni esperar su acceso, y el bot se construye igual sobre una interfaz. |
| 4 | Shift no guarda la historia clínica. | Solo datos operativos. Evita asumir las obligaciones de esa norma (ver §12). |
| 5 | Una clínica es una cuenta, un número de WhatsApp y varias sedes. | `whatsapp_config` admite una fila por cuenta (`UNIQUE (account_id)`). |
| 6 | La IA no decide citas, urgencias ni instrucciones clínicas. | Sigue la regla del controlador actual. La IA solo convierte texto libre en opciones y responde dudas con los documentos de la clínica. |
| 7 | Primera versión solo para Colombia. | La zona horaria es fija en `America/Bogota`, y otros países traen otras leyes de salud. |
| 8 | No se copia el controlador. | Tiene 2.160 líneas. Una copia duplica cada arreglo y va contra "el núcleo es uno". |
| 9 | La Agenda de Shift tiene una sola sede en esta versión. | Alcanza para la primera clínica. Las sedes entran cuando llegue una clínica de varias sedes que no quiera conectar su software. |
| 10 | Nada se da por atendido sin una marca explícita. | Mandar cuidados a quien no vino es peor que no mandar nada. |

## 3. Qué existe y qué falta en `main`

**Se reutiliza:** motor de citas `booking_*`, bot por menús con sesión y estado, recordatorios de 24 h
y 2 h con botones, pase a una persona, preguntas extra, palabras por negocio, módulos por cuenta,
baja de envíos (`baja-envios`), cifrado de tokens (`src/lib/whatsapp/encryption`), IA con documentos
del negocio y cron de Vercel cada 10 minutos.

**Falta (verificado en `main`):**

- Paciente distinto del contacto. Hoy el bot actúa sobre la próxima cita del número.
- Autorización de datos personales y sensibles.
- Manejo de la agenda por recepción. Hoy solo el bot crea citas: `/agenda` es una lista del día y su
  API solo cambia estados, así que una recepcionista no puede agendar a quien llama o llega.
- Calendario por columnas. Está diseñado en `2026-10-22-agenda-calendario-design.md` §5.1, pero nunca
  se construyó.
- Sedes y sillones. Con el conector vienen del software. La Agenda de Shift tendrá una sede y un cupo
  de sillones (§6.9).
- Conexión con sistemas externos.
- Mensajes programados distintos del recordatorio.
- `completed` y `no_show` solo se marcan a mano en `/agenda`.
- `OFFER_DAYS = 7`: un control a 6 meses no cabe en el menú.
- Audio: no se transcribe.
- Candado por conversación (pendiente en `docs/agenda-notas.md` §3). El conector lo vuelve
  obligatorio porque cada llamada externa agranda la ventana de carrera.

## 4. Reglas externas que condicionan el diseño

Leídas el 02/11/2026. Lo marcado "inferencia" no lo dice la fuente de forma literal.

**WhatsApp (política actualizada el 23/09/2026):**

- No se puede pedir "personal ID card numbers". La cédula va por enlace, fuera del chat.
- No se puede usar WhatsApp para telemedicina ni para pedir o enviar información de salud **si la
  regulación aplicable lo prohíbe en sistemas sin requisitos reforzados**. Es condicional: lo revisa
  el abogado (§12).
- Se exige permiso del destinatario y respetar las bajas. El método de permiso es responsabilidad del
  negocio. Meta recomienda permiso separado por categoría.
- La automatización debe ofrecer una salida clara a una persona u otro canal.

**Precios de Meta (vigentes desde el 01/10/2026):**

- Los mensajes de servicio se cobran después de 1.000 entregados al mes por número.
- Las plantillas de utilidad dentro de la ventana de 24 h ya no son gratis.
- Sin medio de pago, Meta deja de entregar los mensajes de servicio.
- La tarifa de Colombia está en los archivos de tarifas en COP, que no se leyeron.

**Plantillas (categoría esperada):**

| Plantilla | Categoría | Base |
| --- | --- | --- |
| `recordatorio_cita_clinica` | Utilidad | Inferencia: es sobre su propia cita, sin promoción |
| `cita_cancelada_clinica` | Utilidad | Inferencia, igual que la anterior |
| `como_sigues` | Utilidad | Inferencia: atada a una visita concreta |
| `calificacion_visita` | Utilidad | Meta acepta feedback sobre una visita concreta, sin promoción |
| `control_pendiente` | Mercadeo | Inferencia: regla de retargeting |
| `saldo_pendiente` | Utilidad | Inferencia: atada a su cuenta |

Meta puede recategorizar una plantilla, así que cada una se revisa al aprobarse.

**Google:** prohíbe filtrar quién recibe el enlace de reseña según su opinión. Se leyó en fuentes
secundarias. Hay que confirmarlo en el texto oficial antes de la Fase 3.

**Colombia:** los datos de salud son sensibles y exigen autorización explícita. Hay que informar que
el titular no está obligado a darlos, y ningún servicio se puede condicionar a ellos.

## 5. El flujo completo

**Etapa 0. Montaje de la clínica (lo hace Shift).** Con Agenda de Shift: cargar doctores, horarios,
bloqueos y cupo de sillones. Conectada: conectar con el token, traer sedes, doctores, sillones y
estados de cita, mapear esos estados a los nuestros y apagar los avisos de citas del software para que
no lleguen dobles. En ambos casos: definir el catálogo que ve el paciente (por ejemplo Valoración,
Limpieza, Urgencia, Control de ortodoncia), con duración, doctores, instrucciones previas y cuidados,
y aprobar plantillas en Meta. El director aprueba los textos clínicos. Prueba de punta a punta.

**Etapa 1. Primer mensaje.** Se pide la autorización de datos con botones Acepto / No acepto. Quien
no acepta queda con una persona y se le atiende igual. El permiso de recordatorios de control se
pide aparte, después de agendar. Si el primer mensaje es una urgencia, la etapa 2b va antes que la
autorización: nadie con dolor se queda atascado en un aviso legal.

**Etapa 2. Entender qué necesita.** Menú con Agendar, Mis citas, Precios y dudas, Urgencia y Hablar
con una persona. Las dudas pasan a la IA con los documentos de la clínica. Pagos, documentos y quejas
van a una persona en esta versión.

**Etapa 2b. Urgencia (flujo fijo, sin IA).** Se activa por una lista fija de palabras o por el
botón. Se muestran los signos de alarma con el texto aprobado por el director.

- Con signos de alarma: indicación de ir a urgencias, y aviso prioritario a la clínica.
- Sin signos, en horario: primer cupo de la atención marcada como urgencia.
- Sin signos, fuera de horario: teléfono de turno de la sede. Si no hay, se avisa que se escribirá a
  primera hora, y se repiten los signos de alarma.

El bot nunca opina sobre medicamentos ni diagnósticos.

**Etapa 3. Agendar.** ¿Para quién? → sede (o "La más pronta") → atención → doctor o "Cualquiera" →
día → hora → resumen → confirmar. Si el número tiene varios pacientes, se elige de la lista. Si no
tiene ninguno, se piden nombre y apellidos, que es lo mínimo para crear al paciente. Con una sola sede
ese paso se omite. Las horas se leen en vivo de la agenda de la clínica. El menú de días llega hasta `offer_days` y tiene "Ver más días", porque una lista de WhatsApp admite 10 filas.

**Etapa 4. Ficha de ingreso (solo pacientes nuevos).** Enlace seguro con documento, fecha de
nacimiento, acudiente y correo. Va directo al software de la clínica por `PUT /pacientes/{id}`. Shift
no guarda esos datos, solo la marca de completada. Los antecedentes médicos siguen en la historia
clínica. Requiere conector: con Agenda de Shift, esos datos los sigue tomando la recepción donde los
lleve hoy.

**Etapa 5. Antes de la cita.** Recordatorios de 24 h y 2 h a todas las citas, también las de
recepción. **La plantilla nombra al paciente, la sede, el doctor, la fecha y la hora, pero no el
procedimiento**, porque el teléfono puede ser compartido y el texto pasa por Meta. Al tocar Confirmar
se abre la ventana de 24 h y ahí salen el mapa y las instrucciones previas, sin necesitar otra
plantilla. Sin respuesta, la cita aparece para llamar en el panel "Para atender".

**Etapa 6. Cambios de la clínica.** Si recepción cancela una cita, por ejemplo porque un doctor se
enfermó, se detecta (al instante en la Agenda de Shift, en la copia si está conectada) y el paciente
recibe `cita_cancelada_clinica` con botón para reagendar. Desde la Fase 5, el cupo también se ofrece a
la lista de espera. Si recepción la mueve, se reinician
los recordatorios.

**Etapa 7. Después de la cita.** Con la marca de atendida:

- Cuidados del procedimiento, si la cita trae un servicio conocido.
- Propuesta de la siguiente sesión si aplica.
- Al día siguiente, `como_sigues` con Bien / Tengo molestias / Necesito ayuda. Las dos últimas
  alertan a una persona con prioridad.

Si la cita no dice qué procedimiento fue, por ejemplo una creada en el software, no se adivina: el auxiliar
envía los cuidados desde la conversación con un clic (Respuestas rápidas).

**Etapa 8. Calificación.** Sale un día después de una visita atendida, solo si el paciente no tiene
cita futura, no calificó en los últimos 90 días, no tiene la etiqueta `queja-abierta` (la ponen y la
quitan las personas del equipo) y no reportó molestias. La plantilla pregunta por esa visita con
Bien / Regular / Mal. Ese toque abre la ventana y ahí se manda
el enlace de Google de la sede **a todos, sea cual sea la respuesta**. Regular o Mal alerta además al
dueño para que una persona llame.

**Etapa 9. Volver y pagar (Fase 5).** Control cada 6 meses con permiso de mercadeo, controles
mensuales de ortodoncia, pacientes inactivos, saldo del tratamiento desde el software, y trabajos de
laboratorio listos. Los presupuestos sin aceptar dependen de que la API los exponga: hoy no hay
sección en su documentación.

**Lo que suma frente a una secretaria (Fase 6):** resumen diario al dueño, cifras por sede y doctor,
y alerta cuando un número se acerque a los 1.000 mensajes del mes.

## 6. Arquitectura

### 6.1 Dónde vive el código

- Módulo `clinica` en `src/modules/clinica/`: conector, copia de citas, seguimientos y panel. Clave
  en `accounts.modules`. Una clínica tiene `{agenda, clinica}`.
- El bot sigue siendo el de la Agenda: el dispatcher no cambia y sigue habiendo un solo bot por
  cuenta. Los pasos nuevos se prenden por configuración y viven en archivos propios
  (`agent/steps/*.ts`) para no engordar `controller.ts`.
- Nuevo punto de partida `presets/odontologia.ts`: palabras, catálogo sin precios visibles
  (`showPrice: false`, porque el valor depende de la valoración), y preguntas vacías.

### 6.2 La interfaz `ClinicBackend`

De las 32 funciones de `agent/db.ts`, 12 tocan citas o catálogo. El catálogo sigue local, así que la
interfaz se reduce a lo que de verdad cambia según quién manda:

```ts
// Fase 1 (src/verticals/agenda/agent/backend.ts), tal como quedó:
interface ClinicBackend {
  getDaySlots(query: SlotQuery): Promise<MergedSlot[]>
  getDaysWithSlots(query: DayRangeQuery): Promise<string[]>
  isStaffFree(args: { staffId: string; startIso: string; endIso: string }): Promise<boolean>
  findPatients(args: { contactId: string }): Promise<ClinicPatient[]>
  createPatient(args: { contactId: string; fullName: string }): Promise<ClinicPatient>
  listUpcoming(args: { contactId: string; nowIso: string }): Promise<AppointmentSnapshot[]>
  book(args: BookArgs): Promise<BookResult>
  cancel(args: { id: string; reason: string; cancelledAtIso: string }): Promise<void>
  confirm(args: { id: string; confirmedAtIso: string }): Promise<void>
}
```

El paciente se busca por el contacto (`contactId`), no por el teléfono, y `listUpcoming` devuelve las
citas del contacto con el nombre de su paciente. `capabilities`, `move` y `refresh` entran con el
conector (Fase 4): hasta entonces no hacen falta y no existen.


`BookResult` distingue `ok`, `slot_taken` y `failed`. Con el conector se suma `unknown`, que significa
que no se sabe si la cita quedó creada (§8). `move` y `unknown` entran en la Fase 4: hasta entonces,
reprogramar sigue siendo crear y cancelar, como hoy.

- `InternalBackend` envuelve las funciones actuales sin cambiar su conducta. Es el camino real de la
  primera clínica, no un simulador. Las pruebas actuales de `controller.test.ts` deben pasar sin
  tocarlas: esa es la garantía de que barberías y salones no se afectan.
- `DentalinkBackend` llama a la API. Otro software es otra implementación de esta interfaz.

### 6.3 Conector Dentalink

| Método | API |
| --- | --- |
| `getDaysWithSlots` | `GET /horariosdisponibles` (hasta 2 semanas) |
| `getDaySlots` | `GET /agendas` (trae `id_recurso`, el sillón) |
| `isStaffFree` | `GET /agendas`, la misma consulta del día, en vivo y sin caché (es la revisión final antes de crear la cita) |
| `findPatients` | `GET /pacientes` con filtro por `celular`, probando variantes del número |
| `createPatient` | `POST /pacientes` |
| `listUpcoming` | `GET /pacientes/{id}/citas`, una consulta por paciente |
| `book` | `POST /citas/` |
| `move` | `POST /citas/changeDate` |
| `cancel`, `confirm` | `PUT /citas/{id}` con el `id_estado` mapeado |
| `refresh` | `GET /citas/{id}` |

Autenticación: `Authorization: Token <token>`, creado por el administrador de la clínica. Se guarda
cifrado. **El token se limita en Configuración API → Permisos**: sin evoluciones, recetas, documentos
clínicos ni antecedentes. Por defecto trae todos los permisos.

Cada llamada tiene tiempo límite de 8 s. Las lecturas se reintentan una vez. Las escrituras no se
reintentan a ciegas (§8). Las consultas de horas se guardan 60 s por sede, fecha y duración, pero la
revisión final antes de crear la cita siempre es en vivo.

### 6.4 Copia local de citas (solo camino conectado)

La API no documenta avisos en tiempo real, así que se consulta cada 10 minutos.

- Las citas se guardan en `booking_appointments` con `external_source` y `external_id`. Reutilizar la
  tabla deja funcionando el runner de recordatorios, el panel y el historial.
- Cada corrida trae las citas de los próximos 14 días y, además, las de ayer y hoy para detectar
  atendidas. Las citas más lejanas no están en la copia: "Mis citas" y las reglas de calificación
  usan `listUpcoming`, que consulta en vivo.
- Se escribe primero en el software. Con su respuesta se actualiza la copia en el mismo momento, sin
  esperar la corrida.
- Una cita de un paciente sin contacto crea el contacto por su celular. Sin celular válido no se
  copia, porque no hay a quién escribirle.
- El anti-choques deja por fuera las citas copiadas. El software puede tener sobrecupos a propósito,
  y la copia nunca debe fallar por eso.
- El panel muestra esas citas en solo lectura, con el aviso de que se gestionan en el software. La
  única excepción es el cierre del día (§6.8), que escribe en el software.
- Las horas libres nunca salen de la copia.

**Estados:** cada clínica tiene los suyos, así que el mapeo se hace en el montaje. Un estado sin mapear
no se interpreta: la cita conserva su estado, se guarda el valor recibido y se avisa en el panel.

**Antes de cada recordatorio** se llama a `refresh`. Si falla, se usa la copia solo si tiene menos de
60 minutos. Si es más vieja, no se envía y se alerta.

### 6.5 Paciente y contacto

Un contacto (número de WhatsApp) tiene uno o varios pacientes. La autorización la da el contacto,
incluido el acudiente en el caso de menores.

Los botones del recordatorio llevan el id de la cita (`rem:confirm:<uuid>`): la plantilla clínica lo
manda en el payload de cada botón (`quickReplyPayloads`). La nota de `state.ts` que decía que no se
podía ya se corrigió. **Falta comprobar con un toque real que Meta lo devuelve**, junto con `context.id`
(`docs/clinica-montaje.md`). Hay respaldo: sin el id, el bot lee la etiqueta ("Confirmar") si responde a una
plantilla de recordatorio, y con más de una cita activa y sin exactamente una en 72 h pregunta cuál con
una lista.

### 6.6 Autorizaciones

Registro de solo agregar, con tipo (`datos_sensibles`, `mercadeo`), decisión, versión del texto,
origen (`whatsapp`, `recepcion`) y mensaje. El texto legal es por cuenta y tiene versión.

Citas creadas por recepción: la clínica declara en el montaje que obtiene el permiso en recepción
(Meta deja el método en manos del negocio). Al copiar la cita, el contacto queda con una autorización
de origen `recepcion`, y por eso el bot no se la vuelve a pedir. Toda plantilla respeta `baja-envios`.
Esta solución se revisa con el abogado antes de la primera clínica real.

Sin autorización de datos sensibles la IA no ve la conversación: el bot la consume y, si la respuesta
es No acepto, la deja con una persona.

**Revocar escribiendo.** No solo el botón "No acepto" revoca: también un mensaje completo ("no acepto",
"ya no autorizo") o una frase que junte un verbo de retirar (revoco, retiro, quiten, borren, eliminen, "no
quiero que usen") con "autorización" o "mis datos". "No acepto esa hora" o "borré el mensaje" no lo son. Con
la autorización vigente vale en cualquier paso, menos mientras la persona responde los signos de alarma:
registra `granted: false` y pasa a una persona con una nota; si pidió borrar sus datos, la nota dice que se
atiende a mano (el bot no borra nada). En un hilo que lleva una persona solo registra y le avisa. El detector
es estrecho a propósito: una revocación pausa el bot. No se agregó "Mis datos" al menú ni se cambió el texto
legal; cómo revocar y el borrado de datos quedan para el abogado.

**Recordatorios.** En una cuenta con `clinica`, una cita no recibe recordatorio si el contacto tiene la
etiqueta `baja-envios` o si su última autorización de datos es un no. Sin ninguna fila de autorización sí se
envía (las citas anteriores al módulo no la tienen). No se reclama la señal: si cambia de idea, la siguiente
corrida lo envía. Las demás cuentas no cambian. Un "Reprogramar" de quien revocó lo atiende una persona.

### 6.7 Orden dentro del bot (cuentas con `clinica`)

1. Toque de un recordatorio.
2. Palabra de urgencia. Gana sobre el pase a una persona porque los signos de alarma no pueden esperar.
3. Palabra de pase a una persona.
4. Autorización pendiente.
5. Sesión activa.
6. Intención de agendar o menú principal.

### 6.8 Mensajes programados

Tabla `clinic_followups` con tipo, cita, fecha debida y estado. La ruta
`/api/verticals/clinica/followups/run` reclama cada fila con un UPDATE condicional, igual que los
recordatorios: dos corridas no mandan doble. La copia corre en `/api/verticals/clinica/sync/run`.
Ambas van cada 10 minutos en `vercel.json`, con `AUTOMATION_CRON_SECRET`. Las filas se crean cuando una
cita pasa a atendida. Antes de enviar se revisan las reglas de la etapa 8.

**Cierre del día:** a las 8 p. m., las citas de hoy sin marcar aparecen en el panel con aviso en la
app. Desde ahí se marcan Atendió / No vino, y eso se escribe en la agenda de la clínica.

### 6.9 Agenda de Shift para recepción (solo camino sin conector)

Sin esto la clínica no puede vivir en Shift, porque la recepción necesita manejar la agenda. Toma el
calendario de `2026-10-22-agenda-calendario-design.md` §5.1. Aprobar cada cita y los enlaces `.ics` de
ese diseño no entran.

- `/agenda/calendario`: vista de día y de semana, con una columna por doctor.
- **Crear cita desde el panel:** paciente existente o nuevo (nombre, apellidos y celular), atención,
  doctor, fecha y hora. Si el contacto no existe, se crea, con autorización de origen `recepcion`.
- **Mover y cancelar desde el panel.** Mover pregunta si se avisa al paciente.
- Rutas `POST /api/verticals/agenda/appointments` y `PATCH` sobre `[id]`, con `requireRole('agent')` y
  pasando por `InternalBackend`: las mismas reglas del bot. Un choque de doctor se muestra en palabras
  simples.

**Cupo de sillones:** `clinic_locations.chair_count`. Si las citas activas a una hora ya igualan el
cupo, esa hora no se ofrece. Vacío significa sin límite. No se asigna un sillón específico, y así se
evita modelar sillones por cita y un segundo anti-choques. Como el bloqueo de la base sigue siendo por
doctor, dos reservas en el mismo instante podrían pasarse del cupo. Se acepta en esta versión porque
la recepción lo ve en el calendario.

## 7. Datos

Todas las tablas nuevas siguen RLS 017/050: los miembros leen, owner/admin escriben la configuración y
el bot escribe con service role. Migraciones aditivas, idempotentes y aplicadas en el SQL Editor con
OK del usuario. Nunca `supabase db push`.

**055 (Fase 1)**

- `clinic_settings`: `account_id` PK, `consent_text`, `consent_version`, `reception_consent_declared_at`,
  `urgency_words` text[], `urgency_alarm_text`, `urgency_service_id`, `offer_days` (por defecto 30).
- `clinic_locations`: `id`, `account_id`, `external_source`, `external_id`, `name`, `address`,
  `latitude`, `longitude`, `notice_phone`, `on_call_phone`, `google_review_url`, `chair_count`,
  `is_active`. Con Agenda de Shift hay una sola fila. Único por (`account_id`, `external_source`,
  `external_id`) cuando hay id externo, que va siempre junto a su fuente.
- `clinic_patients`: `id`, `account_id`, `contact_id` NOT NULL, `external_source`, `external_id`,
  `full_name`, `intake_completed_at`, `created_at`. Único por (`account_id`, `external_source`,
  `external_id`) cuando hay id externo. **Un contacto con paciente no se puede borrar**:
  `contact_id` no tiene cascada, la base rechaza el borrado (error `23503`) y la pantalla de
  Contactos avisa que es paciente de la clínica. Borrar la cuenta sí borra todo.
- `clinic_consents`: `id`, `account_id`, `contact_id` (anulable), `contact_ref`, `kind`, `granted`,
  `text_version`, `text_snapshot`, `source`, `message_id`, `created_at`. **Las autorizaciones
  sobreviven al contacto**: si se borra, `contact_id` queda en NULL y la fila conserva `contact_ref`
  (teléfono del titular, o su identificador de WhatsApp si no tiene teléfono) y `text_snapshot` (el
  texto exacto que aceptó; cambiar el texto de la clínica no altera lo que firmó cada persona). Sin
  política de escritura para clientes y, además, un trigger rechaza todo UPDATE y DELETE directo
  (las acciones de FK pasan) y se revoca TRUNCATE: solo se agrega.
- `booking_appointments.patient_id` y `location_id`, null para los demás negocios. Son FK compuestas
  con `account_id`: la cita no puede apuntar a un paciente ni a una sede de otra cuenta. Piden
  Postgres 15 o más (`ON DELETE SET NULL (columna)`).
- Lo que la FK sola no cierra lo cierra la política de escritura: el contacto de un paciente y el
  servicio de urgencias de la configuración deben ser de la misma cuenta.
- `conversations.bot_lock_until`: candado por conversación. Va en la conversación porque esa fila
  siempre existe, también en el primer mensaje.
- `booking_services.prep_instructions` y `aftercare_instructions`, máximo 900 caracteres.

**056 (seguimientos)**

- `clinic_followups`: `id`, `account_id`, `appointment_id`, `contact_id`, `kind`, `due_at`, `status`
  (`pending`, `sent`, `skipped`, `failed`), `sent_at`. Único por (`appointment_id`, `kind`).
- `clinic_ratings`: `id`, `account_id`, `appointment_id`, `contact_id`, `location_id`, `value`
  (`bien`, `regular`, `mal`), `created_at`.

**057 (conector)**

- `clinic_connections`: `account_id` PK, `provider`, `token_encrypted`, `state_map` jsonb, `status`,
  `last_sync_at`, `last_sync_error`. Sin acceso desde el navegador.
- `clinic_intake_tokens`: `id`, `account_id`, `patient_id`, `token_hash`, `expires_at`, `used_at`.
  Vence a los 7 días y se usa una vez.
- `booking_appointments`: `external_source`, `external_id`, `external_state`, `external_chair_id`,
  `synced_at`. Único por (`account_id`, `external_source`, `external_id`).
- `booking_appointments_no_overlap`: se recrea agregando `AND external_id IS NULL` al `WHERE`.
- `booking_staff.external_id` y `booking_services.external_ref` jsonb.

## 8. Errores y casos límite

| Caso | Qué pasa |
| --- | --- |
| La API no responde al mostrar horas | No se confirma nada. El bot toma lo que el paciente quería y lo deja con una persona, con esos datos en la nota. |
| Se corta `POST /citas/` | `BookResult = unknown`. Se consulta `GET /pacientes/{id}/citas` por esa fecha y hora. Si está, se confirma. Si no, nunca se dice "confirmada": pasa a una persona. |
| La hora se ocupó | Mismo flujo actual: aviso y otras horas. |
| La API no valida choques (si la Fase 0 lo confirma) | Tras crear se relee la agenda. Si hay choque en ese sillón, se anula la nuestra y se ofrecen otras horas. |
| Token revocado (401) | Conexión en error, alerta a ops, bot en modo pase a persona, recordatorios según §6.4. |
| Estado nuevo sin mapear | §6.4: no se interpreta y se avisa. |
| Toca un botón de una cita cancelada | `refresh` lo detecta: "esa cita ya no está activa". |
| Dos mensajes seguidos | El segundo espera el candado hasta 5 s. Si sigue ocupado, se registra y no se responde. |
| Paciente con otro número en el software | Se crea otro paciente. Recepción los une. Se acepta en esta versión. |
| Palabra de urgencia en un hilo que lleva una persona | El bot no responde, para no pisar a esa persona. Se le manda un aviso prioritario en la app. |

## 9. Fases

| Fase | Entrega | Depende de |
| --- | --- | --- |
| 1 | Bot dental sobre `ClinicBackend` con la Agenda de Shift: pacientes y familia, autorización, urgencias, punto de partida, candado, citas lejanas, plantilla sin procedimiento. Demo con clínica ficticia, presentada como ficticia. Después, texto libre y audio con IA. | Nada |
| 2 | Agenda para recepción: calendario, crear, mover y cancelar citas, cupo de sillones (§6.9), y citas sin confirmar para llamar. | Fase 1 |
| 3 | Después de la cita: cierre del día, cuidados, "¿Cómo sigues?", calificación. | Fase 1 |
| 0 | Acceso a Dentalink y prueba real de la API (§10). Sin código de producto. | Respuesta de Dentalink |
| 4 | Conector Dentalink: copia de citas, sedes, ficha de ingreso, cambios de la clínica, montaje guiado. | Fases 0 y 1 |
| 5 | Volver y pagar, y lista de espera. | Fase 3 |
| 6 | Resumen diario y reportes. | Fase 3 |

**Con las fases 1, 2 y 3 se atiende a la primera clínica con la Agenda de Shift, sin Dentalink.** Las
fases 2 y 3 son independientes entre sí. La Fase 0 ya no bloquea a la primera clínica: se hace cuando
aparezca una que no quiera dejar su software.

Todo sale en ramas desde `main`, con PR por fase. Cada módulo se activa solo para cuentas de clínica:
ningún negocio actual cambia de conducta, con **dos excepciones** que también tocan a las cuentas actuales:

1. **Los botones de `recordatorio_cita` ahora funcionan.** Antes, una plantilla enviada sin payload devolvía
   la etiqueta del botón ("Confirmar") y el bot no la entendía: el toque no hacía nada. Ahora la etiqueta se
   lee, pero solo si el mensaje responde a una plantilla de recordatorio; la de cualquier otra plantilla o
   difusión no se toca.
2. **"Atención" ya no abre el flujo de reservas.** Las palabras propias del negocio abren el flujo salvo que
   sean muy comunes; "atención" ("gracias por la atención") se agregó a esa lista. Un negocio que use
   "atención" como su palabra para la cita deja de abrir el flujo con ella.

## 10. Fase 0: preguntas por responder

**A Dentalink:** precio de la API, si dan acceso de prueba sin clínica, si aceptan integradores
externos, si existen webhooks (`GET /configuraciones` trae un campo `webhooks`), qué significa
`api_max_requests: 60,1` y si hay API de presupuestos.

**Con un token de prueba y pacientes ficticios:**

1. ¿`POST /citas/` rechaza una hora ocupada? ¿Con qué error?
2. ¿Cómo se anula una cita?
3. ¿`fecha_actualizacion` detecta citas nuevas y movidas, o solo cambios de estado?
4. ¿`/horariosdisponibles` y `/agendas` descuentan las citas ya tomadas?
5. ¿En qué formato están los celulares y cómo se comporta el filtro `eq`?
6. ¿La cita trae el procedimiento?
7. ¿Se pueden apagar los avisos propios de Dentalink?
8. ¿Se puede dejar el token sin permisos clínicos?

**Con Meta (no depende de Dentalink, se hace en la Fase 1):** enviar una plantilla real con `payload`
dinámico en el quick reply y confirmar que vuelve en `button.payload`.

**Si sale mal:** si no hay acceso sin clínica, la Fase 4 espera a la primera clínica con Dentalink. Si
el precio o el límite de consultas no dan, se revisa Saludtools, que tiene API según GetApp pero sin
documentación pública. Las fases 1, 2 y 3 no se afectan en ningún caso.

## 11. Pruebas

- **Regresión:** `controller.test.ts` y `reminders.test.ts` pasan sin cambios con `InternalBackend`.
- **Contrato:** la misma batería corre contra `InternalBackend` y contra un Dentalink simulado.
- **Simulador:** se arma con la documentación y se corrige con respuestas reales de la Fase 0. No
  prueba la conducta real de Dentalink: los puntos de §10 solo se dan por buenos con el token.
- **Conector:** corte en mitad de `POST`, 401, estado sin mapear, cita movida, número con varios
  pacientes.
- **Bot:** autorización aceptada y negada, urgencia antes de autorizar, urgencia fuera de horario,
  familia con dos citas tocando un recordatorio.
- **Recepción:** crear cita con contacto nuevo, choque de doctor, cupo de sillones lleno, mover con y
  sin aviso al paciente.
- **Seguimientos:** nada sale sin marca de atendida, sin duplicados entre corridas, enlace de Google
  para las tres respuestas.
- **RLS:** tablas nuevas en `rls-policies.test.ts` y `verify-schema.sql`.
- **Manual:** cuenta de prueba, porque `.env.local` apunta a producción. Datos marcados y limpiados al
  terminar.

## 12. Riesgos y temas a revisar

**Para abogado, antes de la primera clínica real:**

- Texto de autorización y su conservación.
- Papel de Shift frente a los datos de la clínica. Shift no es empresa registrada.
- Si el permiso declarado en recepción es suficiente.
- Enviar conversaciones de pacientes a un proveedor de IA, que puede ser una transferencia
  internacional de datos sensibles.
- Si los cuidados y los signos de alarma por WhatsApp entran en la regla condicional de Meta.
- Norma de historia clínica: un proyecto del Ministerio de 2026 derogaría la Resolución 1995 de 1999.
  Confirmar si ya se expidió, y si la Resolución 1888 de 2025 aplica a lo que hace Shift.

**Para contador:** cobros y soporte de pagos si se llega a la Fase 5.

**Negocio:**

- Dependemos de la API de pago de un proveedor que, según Capterra, vende su propio asistente de
  WhatsApp con IA.
- Una reserva por menús toma unos 7 mensajes del bot (estimado). El costo de Meta entra en la
  mensualidad.
- Cada número necesita medio de pago en Meta.

**Técnicos:**

- La copia tiene hasta 10 minutos de atraso en lo que hace recepción.
- Las llamadas externas alargan el trabajo de `after()` en el webhook: se vigila el tiempo por mensaje.
- Las respuestas de IA dependen del proveedor configurado en la cuenta.

## 13. Fuera de alcance

- Guardar historia clínica, antecedentes, recetas o radiografías.
- Generar facturas electrónicas o RIPS.
- Consentimiento informado firmado.
- Un número de WhatsApp por sede.
- Permisos por sede dentro de una cuenta.
- Sedes en la Agenda de Shift, y asignar un sillón específico a cada cita.
- Aprobar cada cita y enlaces `.ics`.
- Llamadas telefónicas por voz.
- Otros países.
- Conectores distintos de Dentalink.
