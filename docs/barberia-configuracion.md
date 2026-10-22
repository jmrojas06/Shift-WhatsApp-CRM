# Configuración del negocio — vertical de barbería (Fase 4)

Todo el onboarding de una barbería se hace desde la interfaz, sin SQL:
servicios, barberos, horarios semanales, bloqueos, textos del bot y la
segunda señal de recordatorio. Esta guía cubre qué toca cada pestaña,
qué garantiza el servidor y cómo probarlo.

## Cómo entrar

`/barberia` → botón **Configuración** (arriba, a la derecha) →
`/barberia/configuracion`.

- Solo cuentas con el vertical de barbería ven la página; el resto
  recibe el aviso de módulo no habilitado.
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
| **Servicios** | Catálogo: crear, editar, activar/desactivar, orden |
| **Barberos** | Equipo: crear, editar, activar/desactivar, orden y servicios que atiende |
| **Horarios** | Semana laboral por barbero (bloques por día) |
| **Bloqueos** | Vacaciones/diligencias puntuales por barbero |
| **Bot y recordatorios** | Textos editables del bot + segunda señal de 2 h |

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
    bot, agenda y recordatorios). Una barbería en otra zona (España,
    EE. UU.) vería las horas corridas. Soportar varias zonas horarias
    (p. ej. una columna `timezone` en `booking_settings`) es un
    **pendiente futuro**; hasta entonces, solo se activa el vertical
    para negocios en la hora de Colombia (UTC-5, sin horario de
    verano).

## Servicios

- Campos: nombre (obligatorio, máx. 80), descripción (opcional, máx.
  300), duración (1–480 min) y precio (0–99.999.999,99, 2 decimales).
- **Orden**: flechas **Subir/Bajar**; se guarda la permutación completa
  del catálogo (el servidor exige que la lista coincida con los
  servicios de la cuenta).
- **Desactivar no borra.** Un servicio inactivo deja de ofrecerse en
  nuevas reservas y no aparece en el menú del bot, pero las citas
  existentes conservan su referencia y su historial.
- **Duplicados**: dos servicios con el mismo nombre (sin distinguir
  mayúsculas) → **409**. Nota: `Corte` y `corte` cuentan como el mismo.
- Cambiar la **duración** recalcula al vuelo la disponibilidad de las
  nuevas reservas; las citas ya confirmadas no se tocan.

## Barberos

- Campos: nombre (obligatorio, máx. 80) y descripción corta (opcional,
  máx. 300).
- **Orden**: igual que servicios (permutación completa).
- **Servicios que atiende**: casillas en el diálogo de edición. Sin
  marcas, el barbero no se ofrece para ningún servicio. La opción
  **Cualquiera** del bot asigna al barbero disponible que atienda el
  servicio.
- **Desactivar no borra**: un barbero inactivo no se ofrece para citas
  nuevas (ni en el bot ni en los horarios de trabajo, que se
  conservan), pero su historial de citas queda intacto.
- Duplicados de nombre → **409**.

## Horarios

- Por barbero: 7 días, cada día con **cero o más bloques** (horario
  partido: 9:00–12:00 y 13:00–18:00).
- Guardar reemplaza el horario completo del barbero por **diff**: los
  bloques idénticos se conservan (no cambian de id), los nuevos se
  crean y los que salieron se borran.
- Bloques que se **traslapan** el mismo día o terminan antes de
  empezar → **400** con mensaje en es-CO (los bloques que solo se
  tocan, como 9–12 y 12–18, son válidos).
- La disponibilidad se recalcula al vuelo con el horario vigente; las
  citas confirmadas no se mueven.
- Vaciar los bloques de un día (guardar con la lista vacía) = ese día
  no acepta citas.

## Bloqueos puntuales

- Rango **desde/hasta** por barbero (vacaciones, citas médicas…), con
  motivo opcional (máx. 120).
- Se capturan en hora de Bogotá y se guardan como timestamp UTC.
- Mientras el rango está activo, el bot no ofrece horas dentro de él.
- Los bloqueos **sí se borran** (a diferencia de servicios/barberos):
  al eliminar, el barbero vuelve a estar disponible en ese rango.
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
- **Recordatorio de 24 h**: siempre activo (no se apaga desde la
  interfaz).
- **Segunda señal de 2 h**: interruptor con guardado inmediato. Se
  puede fijar también por SQL si hace falta — ver
  `docs/barberia-recordatorios.md`.

## API (roles y respuestas)

Todas las rutas exigen **admin+** y filtran por la cuenta del usuario:

| Método y ruta | Qué hace |
| --- | --- |
| `PATCH /api/account` | Renombrar la cuenta (ruta core) |
| `PATCH /api/verticals/agenda/config` | Dirección, moneda, 2 h y textos |
| `POST /api/verticals/agenda/services` | Crear servicio |
| `PUT /api/verticals/agenda/services` | Reordenar (`{ ids }`) |
| `PATCH /api/verticals/agenda/services/[id]` | Editar/activar/desactivar |
| `POST /api/verticals/agenda/staff` | Crear barbero |
| `PUT /api/verticals/agenda/staff` | Reordenar (`{ ids }`) |
| `PATCH /api/verticals/agenda/staff/[id]` | Editar/activar/desactivar |
| `PUT /api/verticals/agenda/staff/[id]/services` | Servicios que atiende (`{ service_ids }`) |
| `PUT /api/verticals/agenda/staff/[id]/hours` | Horario semanal (`{ hours }`) |
| `POST /api/verticals/agenda/time-off` | Crear bloqueo |
| `DELETE /api/verticals/agenda/time-off/[id]` | Eliminar bloqueo |

Códigos: **400** validación (mensaje en es-CO listo para mostrar),
**403** rol insuficiente, **404** id inexistente o de otra cuenta,
**409** nombre duplicado (`code: "duplicate_name"`), **500** si la base
rechaza una escritura (la pantalla muestra el error, nunca «Guardado»).

**Base de datos (RLS, migración 050):** la misma regla vale si alguien
escribe directo a Supabase con su sesión. Servicios, barberos, relación
barbero↔servicio, horarios, bloqueos y `booking_settings` (dirección,
2 h, textos del bot): **lectura** para todos los roles, **escritura**
solo owner/admin. Los agentes no crean bloqueos. Citas y sesiones del
bot siguen abiertas a agentes (la agenda del día cambia estados).

## Idempotencia y efectos

- La configuración es idempotente: repetir la misma llamada no duplica
  filas (relación barbero↔servicios y horarios se aplican por diff;
  `booking_settings` es un upsert por `account_id`).
- Desactivar un servicio o un barbero **nunca** borra historial; los
  bloqueos puntuales son lo único que se elimina de verdad.
- Si dos pestañas guardan a la vez, gana la última escritura; el
  servidor rechaza listas incompletas o ids ajenos en vez de adivinar.

## Cómo probar el onboarding completo

1. Crea una cuenta con el vertical de barbería (o usa una existente) y
   entra como owner.
2. **Negocio**: cambia el nombre, guarda dirección y moneda.
3. **Servicios**: crea 2–3 (por ejemplo Corte 30 min, Barba 20 min);
   reordénalos y desactiva uno.
4. **Barberos**: crea 2, márcalos para los servicios activos y
   desactiva uno.
5. **Horarios**: dale bloques al barbero activo (ej. lunes–sábado
   9:00–12:00 y 13:00–18:00).
6. **Bloqueos**: agrega uno la próxima semana y verifica que ese rango
   no se ofrezca; bórralo.
7. **Bot**: personaliza la bienvenida y activa la señal de 2 h.
8. Escribe **«cita»** por WhatsApp: el menú debe mostrar los servicios
   activos, luego los barberos (el inactivo no), y las horas deben
   respetar horario + bloqueos. Desactivar un servicio/barbero debe
   dejar de ofrecerlo sin romper citas ya agendadas.
9. Entra como **viewer**: todo se ve, nada se edita; llamar cualquier
   ruta a mano responde 403.

## Preguntas frecuentes

- **¿Puedo borrar un servicio?** No desde la interfaz: desactívalo. El
  borrado rompería las citas que lo referencian.
- **¿Qué pasa si desactivo un barbero con citas futuras?** Las citas
  siguen en pie y en la agenda; el bot solo deja de ofrecerlo para
  citas nuevas.
- **¿Los cambios de horario mueven citas ya agendadas?** No. Solo
  cambian lo que el bot ofrece de ahora en adelante.
- **¿Dónde quedan estos datos?** `booking_settings` (config de la
  cuenta), `booking_services`, `booking_staff`,
  `booking_staff_services`, `booking_working_hours`,
  `booking_time_off` y `accounts` (nombre/moneda).
- **¿Hace falta migración?** Sí: la 049 agrega `address` y
  `bot_texts` a `booking_settings`. Sin ella, la pestaña Negocio y los
  textos del bot fallan al cargar.
