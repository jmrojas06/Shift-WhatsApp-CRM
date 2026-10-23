# Configuración de la agenda (Fase 1: agenda armable)

La agenda sirve a cualquier negocio que agende citas: barbería, salón de
belleza, consultorio, taller, clases o uno en blanco. Todo se arma desde
la interfaz, sin SQL: tipo de negocio, palabras, piezas, preguntas extra,
servicios, equipo, horarios, bloqueos y textos del bot. Esta guía cubre
qué toca cada pestaña, qué garantiza el servidor y cómo probarlo.

> Antes se llamaba «vertical de barbería» (`/barberia`). La barbería es
> ahora uno de los seis puntos de partida. Las rutas viejas siguen
> funcionando por compatibilidad (ver «Compatibilidad con la clave
> vieja»).

## Cómo entrar

`/agenda` → botón **Configuración** (arriba, a la derecha) →
`/agenda/configuracion`.

- Solo cuentas con el vertical de la agenda ven la página; el resto
  recibe el aviso de módulo no habilitado. El operador lo activa una vez
  por cuenta con `vertical_key = 'agenda'` y `agenda` en la lista
  `modules` (ver `docs/onboarding-cliente.md`).
- Una cuenta recién activada ve primero el **asistente de arranque**
  («Elige tu tipo de negocio») en `/agenda`: una tarjeta por punto de
  partida. Elegir una instala la plantilla y deja la agenda lista para
  ajustar.
- **owner** y **admin** pueden editar. **agent** y **viewer** entran en
  modo lectura (los formularios quedan deshabilitados).
- El servidor valida el rol en cada escritura (`requireRole('admin')`):
  aunque alguien llame la API directo, agent/viewer reciben **403**.
- Toda consulta y escritura se filtra por `account_id` (RLS + chequeo
  explícito); un id de otra cuenta responde **404**, nunca 403 ni datos.

## Pestañas

| Pestaña | Qué administra |
| --- | --- |
| **Negocio** | Nombre, dirección y moneda |
| **Tipo de negocio** | Punto de partida y las seis palabras del negocio |
| **Piezas** | Cinco interruptores que prenden o apagan pasos del bot |
| **Preguntas** | Hasta 5 preguntas extra que hace el bot |
| **Servicios** | Catálogo: crear, editar, activar/desactivar, orden |
| **Equipo** | Quien atiende (barberos, estilistas, técnicos… según el vocabulario): crear, editar, activar/desactivar, orden y servicios que atiende |
| **Horarios** | Semana laboral por persona del equipo (bloques por día) |
| **Bloqueos** | Vacaciones/diligencias puntuales por persona del equipo |
| **Bot y recordatorios** | Textos editables del bot + segunda señal de 2 h |

Los nombres de las pestañas de Servicios, Equipo, Horarios y Bloqueos
siguen el vocabulario elegido (una barbería ve «Barberos», un taller
«Técnicos»).

## Negocio

- **Nombre**: viene de `accounts.name`; se guarda con
  `PATCH /api/account` (ruta core) y el perfil se refresca para que el
  resto de la app lo vea (lo usan los recordatorios y la plantilla de
  Meta).
- **Dirección**: texto opcional (máx. 200) en
  `booking_settings.address`. La fila de `booking_settings` se crea
  sola en la primera escritura (config idempotente).
- **Moneda**: código ISO de 3 letras (se ofrece la lista de
  `lib/currency`). Se guarda en `accounts.default_currency` de la
  cuenta propia; con ella se formatean los precios.
- **Zona horaria**: **fija** `America/Bogota` (solo lectura). Todas las
  citas, horarios y bloqueos se guardan en UTC y se capturan/muestran
  en hora de Bogotá.
  - **Limitación conocida:** el producto asume `America/Bogota` para
    TODAS las cuentas (constante `AGENDA_TZ` en
    `src/verticals/agenda/agent/time.ts`: disponibilidad, menús del
    bot, agenda y recordatorios). Un negocio en otra zona (España,
    EE. UU.) vería las horas corridas. Soportar varias zonas horarias
    (p. ej. una columna `timezone` en `booking_settings`) es un
    **pendiente futuro**; hasta entonces, solo se activa el vertical
    para negocios en la hora de Colombia (UTC-5, sin horario de
    verano).

## Tipo de negocio

### Los 6 puntos de partida

| Punto de partida | Para quién | Palabras (quien atiende / la reserva) | Detalle distinto |
| --- | --- | --- | --- |
| **Barbería** | Barberías y peluquerías de hombre | barbero / cita | — |
| **Salón de belleza** | Peluquería, uñas, estética y spa | estilista / cita | — |
| **Consultorio / salud** | Odontología, fisioterapia, psicología, medicina general | especialista / cita | Pregunta «¿Cuál es el motivo de la consulta?» (opcional) |
| **Taller** | Mecánica, latonería, servicio técnico | técnico / cita | No pregunta «¿con quién?»; pregunta «Placa del vehículo» (obligatoria) |
| **Clases** | Academias, tutorías, entrenamiento, talleres | profesor / sesión | — |
| **En blanco** | Empieza vacío y se arma a mano | profesional / cita | — |

Cada punto de partida trae servicios de ejemplo, una persona de equipo
de ejemplo, un horario semanal, etiquetas, pipeline, respuestas rápidas,
documentos de conocimiento, un prompt sugerido del agente de IA y una
bienvenida del bot. Su código vive en `src/verticals/agenda/presets/`.

### Elegir un punto de partida solo LLENA

Aplicar un punto de partida **nunca borra ni pisa** lo que el dueño ya
tiene:

- **Agrega** lo que falte: servicios, equipo, horario, preguntas,
  etiquetas, pipeline, respuestas rápidas y documentos. Lo que ya
  existe se queda activo (el dueño desactiva lo que no use).
- **Fija** las palabras y las piezas del tipo elegido, y la bienvenida
  solo si no la personalizó.
- El prompt del agente de IA solo se escribe si el de la cuenta está
  vacío.
- Al cambiar de tipo, la pantalla pide **confirmación** explicando esto.
  Volver a aplicar el mismo tipo solo rellena lo que falte.
- Es **idempotente**: repetirlo no duplica filas.
- Si la cuenta seguía en USD (el valor por defecto de la migración 021),
  el instalador la pasa a COP. Si ya había una moneda elegida, no la
  toca (ver `docs/agenda-notas.md`).

### Las palabras del negocio

Seis palabras editables, usadas **por el bot y por el panel**:

| Palabra | Ejemplo |
| --- | --- |
| Quien atiende (singular / plural) | barbero / barberos |
| Lo que se agenda (singular / plural) | servicio / servicios |
| La reserva (singular / plural) | cita / citas (o sesión / sesiones) |

- Tope: 24 caracteres por palabra (el límite de una fila de lista de
  WhatsApp). No se aceptan `*`, `_`, `~` ni comillas invertidas (romperían
  el formato de WhatsApp), ni caracteres de control o invisibles.
- Una palabra vacía vuelve a la de por defecto («profesional»,
  «servicio», «cita»…).
- Se guardan en `booking_settings.labels` (jsonb). El servidor mezcla
  lo recibido con lo guardado: un cuerpo parcial no borra el resto.

## Piezas

Cinco interruptores. El bot se salta los pasos que se apagan. Una
columna ausente cuenta como prendida (una cuenta sin configurar se
comporta como siempre).

| Pieza | Prendida | Apagada |
| --- | --- | --- |
| **Elegir quién atiende** | El bot pregunta «¿con qué barbero?» | Asigna a quien esté libre |
| **Mostrar precios** | Precio en el menú, el resumen y la confirmación | No se muestra el precio |
| **Mostrar duración** | Los minutos aparecen en el menú de servicios | No aparecen |
| **Recordatorios** | Mensaje automático 24 h antes (y 2 h si se activa) | No se envía ninguno |
| **Reprogramar y cancelar** | El cliente cambia o cancela desde el bot y desde el recordatorio | El bot avisa a una persona del equipo para que lo atienda por el chat |

Columnas: `choose_staff`, `show_price`, `show_duration`,
`reminders_enabled`, `allow_reschedule` en `booking_settings`.

> **Aprobar cada cita** (que el dueño apruebe por WhatsApp antes de
> confirmar) **NO está en esta fase.** Va en la Fase 2 junto con el
> calendario interno. Hoy toda cita que el cliente confirma queda
> confirmada.

Con **Recordatorios** apagado, la pestaña «Bot y recordatorios» muestra
la señal de 2 h en pausa. Con **Reprogramar y cancelar** apagado, el
recordatorio en texto libre solo muestra el botón «Confirmar»; ver
`docs/agenda-recordatorios.md`.

## Preguntas

Hasta **5 preguntas extra** (activas) que el bot hace **después de
elegir la hora y antes del resumen**: placa del vehículo, dirección,
motivo de la consulta, etc. Las respuestas se guardan en la cita
(`booking_appointments.answers`) y se ven en el panel con su etiqueta
(«Placa: ABC123»).

| Tipo | Qué acepta el cliente |
| --- | --- |
| Texto libre | Cualquier texto (máx. 200 caracteres) |
| Dirección | Texto libre pensado para una dirección |
| Número | Un número |
| Opciones | Una de 2 a 10 opciones (con 3 o menos, el bot las manda como botones de hasta 20 caracteres; con más, como lista de hasta 24) |

- **Obligatoria** (por defecto): el bot insiste hasta tener una
  respuesta válida.
- **Opcional**: el cliente puede **omitirla**. Basta con escribir
  «omitir» (o «no», «ninguno», «no aplica» como mensaje completo). En
  las preguntas de opciones aparece además una fila o botón **Omitir**
  (salvo cuando tiene exactamente 3 opciones, que se quedaría sin
  botones, o más de 9, que no cabe en la lista).
- Las opciones no pueden repetirse (sin distinguir mayúsculas ni
  tildes) ni ser solo números (el bot lee «2» como la posición en el
  menú).
- **Quitar una pregunta solo la desactiva**: el bot deja de hacerla,
  pero las respuestas que ya dieron los clientes se conservan, porque
  la cita guarda sus respuestas por id de pregunta.
- Editar reemplaza la definición completa (etiqueta, tipo, obligatoria
  y opciones). El orden se mantiene.
- Una sexta pregunta activa responde **409** (`limit_reached`).
- Al **reprogramar** una cita, las respuestas de la cita original se
  copian a la nueva; no se vuelven a preguntar.

> **Datos sensibles:** las preguntas extra pueden recoger datos de salud
> o direcciones. Ver «Temas a revisar» en `docs/agenda-notas.md`.

## Servicios

- Campos: nombre (obligatorio, máx. 80), descripción (opcional, máx.
  300), duración (1–480 min) y precio (0–99.999.999,99, 2 decimales).
- **Orden**: flechas **Subir/Bajar**; se guarda la permutación completa
  del catálogo (el servidor exige que la lista coincida con los
  servicios de la cuenta).
- **Desactivar no borra.** Un servicio inactivo deja de ofrecerse en
  nuevas reservas y no aparece en el menú del bot, pero lo ya agendado
  conserva su referencia y su historial.
- **Duplicados**: dos servicios con el mismo nombre (sin distinguir
  mayúsculas) → **409**. Nota: `Corte` y `corte` cuentan como el mismo.
- Cambiar la **duración** recalcula al vuelo la disponibilidad de las
  nuevas reservas; las citas ya confirmadas no se tocan.

## Equipo (quien atiende)

- Campos: nombre (obligatorio, máx. 80) y descripción corta (opcional,
  máx. 300).
- **Orden**: igual que servicios (permutación completa).
- **Servicios que atiende**: casillas en el diálogo de edición. Sin
  marcas, la persona no se ofrece para ningún servicio. La opción
  **Cualquiera** del bot asigna a quien esté disponible y atienda el
  servicio.
- **Desactivar no borra**: una persona inactiva no se ofrece para citas
  nuevas (ni en el bot ni en los horarios de trabajo, que se
  conservan), pero su historial de citas queda intacto.
- Con la pieza «Elegir quién atiende» apagada, el bot no pregunta y
  asigna a quien esté libre.
- Duplicados de nombre → **409**.

## Horarios

- Por persona del equipo: 7 días, cada día con **cero o más bloques**
  (horario partido: 9:00–12:00 y 13:00–18:00).
- Guardar reemplaza el horario completo por **diff**: los bloques
  idénticos se conservan (no cambian de id), los nuevos se crean y los
  que salieron se borran.
- Bloques que se **traslapan** el mismo día o terminan antes de
  empezar → **400** con mensaje en es-CO (los bloques que solo se
  tocan, como 9–12 y 12–18, son válidos).
- La disponibilidad se recalcula al vuelo con el horario vigente; las
  citas confirmadas no se mueven.
- Vaciar los bloques de un día (guardar con la lista vacía) = ese día
  no acepta citas.

## Bloqueos puntuales

- Rango **desde/hasta** por persona del equipo (vacaciones, citas
  médicas…), con motivo opcional (máx. 120).
- Se capturan en hora de Bogotá y se guardan como timestamp UTC.
- Mientras el rango está activo, el bot no ofrece horas dentro de él.
- Los bloqueos **sí se borran** (a diferencia de servicios, equipo y
  preguntas): al eliminar, la persona vuelve a estar disponible en ese
  rango.
- Duración máxima: 366 días por bloqueo. Los bloqueos pasados se
  muestran aparte, solo como historial.

## Bot y recordatorios

- **Cinco textos editables** del flujo de reservas: bienvenida,
  respuesta no entendida, sin servicios activos, sin horarios
  disponibles y pase a un asesor. Se guardan como overrides en
  `booking_settings.bot_texts` (jsonb).
  - **Vacío = texto por defecto.** El botón «Usar texto por defecto»
    borra el override.
  - Tope: 320 caracteres por texto.
  - Los mensajes con datos de la cita (resumen, confirmación,
    recordatorio) **no** se editan aquí; viven en código para que las
    plantillas de Meta sigan cuadrando.
- **Recordatorio de 24 h**: activo mientras la pieza **Recordatorios**
  esté prendida (pestaña Piezas).
- **Segunda señal de 2 h**: interruptor con guardado inmediato. Se
  puede fijar también por SQL si hace falta — ver
  `docs/agenda-recordatorios.md`.

## API (roles y respuestas)

Todas las rutas exigen **admin+** (salvo el runner del cron, que usa
un secreto) y filtran por la cuenta del usuario:

| Método y ruta | Qué hace |
| --- | --- |
| `PATCH /api/account` | Renombrar la cuenta (ruta core) |
| `POST /api/verticals/agenda/setup` | Instalar/aplicar un punto de partida (`{ preset_key }`) |
| `PATCH /api/verticals/agenda/config` | Dirección, moneda, 2 h, textos, palabras (`labels`) y piezas (`toggles`) |
| `POST /api/verticals/agenda/questions` | Crear pregunta extra (máx. 5 activas) |
| `PATCH /api/verticals/agenda/questions/[id]` | Reemplazar la definición de una pregunta |
| `DELETE /api/verticals/agenda/questions/[id]` | Desactivar una pregunta |
| `POST /api/verticals/agenda/services` | Crear servicio |
| `PUT /api/verticals/agenda/services` | Reordenar (`{ ids }`) |
| `PATCH /api/verticals/agenda/services/[id]` | Editar/activar/desactivar |
| `POST /api/verticals/agenda/staff` | Crear persona del equipo |
| `PUT /api/verticals/agenda/staff` | Reordenar (`{ ids }`) |
| `PATCH /api/verticals/agenda/staff/[id]` | Editar/activar/desactivar |
| `PUT /api/verticals/agenda/staff/[id]/services` | Servicios que atiende (`{ service_ids }`) |
| `PUT /api/verticals/agenda/staff/[id]/hours` | Horario semanal (`{ hours }`) |
| `POST /api/verticals/agenda/time-off` | Crear bloqueo |
| `DELETE /api/verticals/agenda/time-off/[id]` | Eliminar bloqueo |
| `GET /api/verticals/agenda/reminders/run` | Runner del cron (secreto, no sesión) |

Códigos: **400** validación (mensaje en es-CO listo para mostrar),
**403** rol insuficiente, **404** id inexistente o de otra cuenta,
**409** nombre duplicado (`code: "duplicate_name"`) o límite de
preguntas (`code: "limit_reached"`), **500** si la base rechaza una
escritura (la pantalla muestra el error, nunca «Guardado»).

**Base de datos (RLS, migraciones 050 y 051):** la misma regla vale si
alguien escribe directo a Supabase con su sesión. Servicios, equipo,
relación equipo↔servicio, horarios, bloqueos, preguntas extra y
`booking_settings` (dirección, 2 h, textos del bot, palabras, piezas):
**lectura** para todos los roles, **escritura** solo owner/admin. Los
agentes no crean bloqueos. Citas y sesiones del bot siguen abiertas a
agentes (la agenda del día cambia estados). Las respuestas a las
preguntas viven en la cita, así que las ve cualquier miembro de la
cuenta.

## Compatibilidad con la clave vieja

- El código acepta `vertical_key = 'agenda'` **y** `'barberia'`
  (`isAgendaVerticalKey`). La migración 052 reescribe las cuentas viejas
  a `'agenda'`; hasta entonces ambas funcionan.
- `/barberia` y `/barberia/configuracion` redirigen a `/agenda` y
  `/agenda/configuracion`.
- La URL vieja del cron, `/api/verticals/barberia/reminders/run`, sigue
  funcionando como alias. Ver `docs/agenda-despliegue-fase1.md`.

## Idempotencia y efectos

- La configuración es idempotente: repetir la misma llamada no duplica
  filas (relación equipo↔servicios y horarios se aplican por diff;
  `booking_settings` es un upsert por `account_id`).
- Desactivar un servicio, una persona del equipo o una pregunta **nunca**
  borra historial; los bloqueos puntuales son lo único que se elimina de
  verdad.
- Si dos pestañas guardan a la vez, gana la última escritura; el
  servidor rechaza listas incompletas o ids ajenos en vez de adivinar.

## Cómo probar el onboarding completo

1. Crea una cuenta, que el operador le ponga `vertical_key = 'agenda'` y
   `agenda` en `modules` (SQL de `docs/onboarding-cliente.md`) y
   entra como owner. En `/agenda` elige un tipo de negocio en el
   asistente.
2. **Negocio**: cambia el nombre, guarda dirección y moneda.
3. **Tipo de negocio**: cambia una palabra (por ejemplo «barbero» por
   «estilista»), guarda y verifica que el panel y el bot la usan.
4. **Piezas**: apaga «Mostrar precios» y confirma que el bot ya no
   muestra el precio.
5. **Preguntas**: agrega una obligatoria («Placa del vehículo») y una
   opcional; en WhatsApp responde la primera y omite la segunda.
6. **Servicios**: crea 2–3, reordénalos y desactiva uno.
7. **Equipo**: crea 2, márcalos para los servicios activos y desactiva
   uno.
8. **Horarios**: dale bloques a la persona activa (ej. lunes–sábado
   9:00–12:00 y 13:00–18:00).
9. **Bloqueos**: agrega uno la próxima semana y verifica que ese rango
   no se ofrezca; bórralo.
10. **Bot**: personaliza la bienvenida y activa la señal de 2 h.
11. Escribe **«cita»** por WhatsApp: el menú debe mostrar los servicios
    activos, luego el equipo (el inactivo no), las preguntas extra y las
    horas deben respetar horario + bloqueos. La cita en `/agenda` debe
    mostrar las respuestas con su etiqueta.
12. Entra como **viewer**: todo se ve, nada se edita; llamar cualquier
    ruta a mano responde 403.

## Preguntas frecuentes

- **¿Puedo borrar un servicio o una pregunta?** No desde la interfaz:
  desactívalo. El borrado rompería las citas que lo referencian.
- **¿Qué pasa si desactivo a alguien del equipo con citas futuras?** Las
  citas siguen en pie y en la agenda; el bot solo deja de ofrecerlo para
  citas nuevas.
- **¿Los cambios de horario mueven citas ya agendadas?** No. Solo
  cambian lo que el bot ofrece de ahora en adelante.
- **¿Cambiar de tipo de negocio borra mis servicios?** No: solo agrega
  lo que falta y cambia palabras y piezas. Lo que no uses lo
  desactivas.
- **¿Dónde quedan estos datos?** `booking_settings` (config de la
  cuenta: dirección, textos, palabras, piezas, punto de partida),
  `booking_services`, `booking_staff`, `booking_staff_services`,
  `booking_working_hours`, `booking_time_off`, `booking_questions`,
  `booking_appointments.answers` y `accounts` (nombre/moneda).
- **¿Hace falta migración?** Sí: la 049 agrega `address` y `bot_texts`;
  la 050 endurece RLS; la **051** agrega punto de partida, palabras,
  piezas, preguntas y respuestas; la **052** reescribe la clave del
  vertical. Orden y pasos: `docs/agenda-despliegue-fase1.md`.
