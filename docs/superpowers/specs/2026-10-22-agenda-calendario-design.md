# Agenda armable + calendario + video para todo negocio con citas

Fecha: 22/10/2026 · Estado: diseño aprobado en conversación, pendiente de revisión escrita.

## 1. Objetivo

Que el CRM sirva a **cualquier negocio que agenda por WhatsApp** (no solo barberías), que cada
negocio se configure en minutos y use solo lo que necesita, que el dueño **apruebe o rechace**
cada cita desde su WhatsApp y que las citas aparezcan solas en **Google, Apple u Outlook**.
Al final, mockups y un motion design grabados de la app real para venderlo.

### Fuera de alcance (fases siguientes)

- Google Calendar en vivo de doble vía (queda diseñado en §6).
- Ventas por WhatsApp, conexión con POS/inventario y pestaña de pedidos (pagados / pendientes).

## 2. Lo que ya existe (base)

- Motor de citas genérico en tablas `booking_*` (migración 047): servicios, personal
  (`booking_staff.phone` ya existe), horarios, ausencias, citas, sesiones del bot, eventos.
- **Choques de horario bloqueados en la base**: `EXCLUDE USING gist` sobre
  `(staff_id, tstzrange(starts_at, ends_at))` para citas `pending` y `confirmed`.
- Recordatorios (048/049): dentro de 24 h texto libre, fuera de 24 h plantilla aprobada en Meta.
- Lo único "de barbería": `vertical_key = 'barberia'`, `src/verticals/barberia/`, textos del bot
  ("barbero") y la página `/barberia`, que solo muestra **las citas de hoy**.
- El bot hoy crea la cita directamente como `confirmed`.

## 3. Fases y ramas

Cada fase con su rama, sus pruebas y su PR a `main`. Se empieza **después** de que
`chore/full-app-audit` esté subida y la migración 050 aplicada.

| Fase | Rama | Entrega |
| --- | --- | --- |
| 1 | `feat/agenda-armable` | Agenda para cualquier negocio, configurable |
| 2 | `feat/agenda-calendario` | Calendario interno, aprobación del dueño, sync con calendarios |
| 3 | proyecto aparte (`shift-agenda-demo`, Remotion) | Mockups + motion design |

## 4. Fase 1 — Agenda armable

### 4.1 De "Barbería" a "Agenda"

- Nuevo vertical `agenda` en `src/verticals/agenda/` (se mueve el código de `barberia`).
- Migración: cuentas con `vertical_key = 'barberia'` pasan a `'agenda'` con
  `preset_key = 'barberia'`. Sin borrar datos. Se conservan las reglas RLS de 050.
- Ruta `/agenda` (y `/agenda/configuracion`); `/barberia` redirige a `/agenda`.

### 4.2 Puntos de partida (presets)

Objetos en código (`src/verticals/agenda/presets/*.ts`), cada uno con: palabras, servicios de
ejemplo (nombre, duración, precio "desde"), horario base, textos del bot y piezas prendidas.

- Barbería · Salón / uñas / spa · Consultorio / salud · Taller / técnicos · Clases / sesiones ·
  En blanco.

Aplicar un preset **solo llena**; después todo se edita. Volver a aplicar uno pide confirmación
y no borra citas.

### 4.3 Palabras editables

`booking_settings.labels` (jsonb): `profesional`, `profesionales`, `servicio`, `servicios`,
`cita`, `citas`. Ej.: barbero/barberos, doctor/doctores, técnico/técnicos; cita, turno, sesión,
reserva. El bot y el panel leen estas palabras; ningún texto queda escrito a mano con "barbero".

### 4.4 Piezas que se prenden o apagan

Columnas nuevas en `booking_settings`:

| Pieza | Columna | Si está apagada |
| --- | --- | --- |
| Elegir profesional | `choose_staff` | El bot no pregunta "¿con quién?" y asigna al primero libre (el bloqueo de choques sigue igual). |
| Precios visibles | `show_price` | El menú del bot no muestra precio. |
| Duración visible | `show_duration` | El menú del bot no muestra duración. |
| Preguntas extra | tabla `booking_questions` | No se pregunta nada extra. |
| Recordatorios | `reminders_enabled` | No se envían recordatorios. |
| Reprogramar / cancelar | `allow_reschedule` | Los botones del recordatorio solo confirman. |
| Aprobar cada cita | `require_approval` | La cita se confirma al instante (comportamiento actual). Ver §5.2. |

### 4.5 Preguntas extra

Tabla `booking_questions (id, account_id, label, kind, required, options, position)`,
`kind ∈ {texto, direccion, numero, opcion}`. El bot las hace después de elegir la hora y antes
del resumen. Respuestas en `booking_appointments.answers` (jsonb), visibles en el panel y en la
cita. Ej.: dirección (servicio a domicilio), placa del carro, motivo de consulta.

### 4.6 Configurar en 1 minuto

Asistente en `/agenda/configuracion`: preset → nombre del negocio → horario → piezas → listo.
Lo usa Shift para dejar un cliente montado y lo usa el dueño para ajustar. Solo rol admin
(igual que hoy).

## 5. Fase 2 — Calendario

### 5.1 Calendario interno

- `/agenda/calendario`: vista **día** y **semana**, una columna por profesional, navegación por
  fechas. `/agenda` sigue siendo "hoy".
- Citas `pending` con borde punteado y botones Aceptar / Rechazar; `confirmed` sólidas.
- Crear, editar, mover y cancelar desde el panel. Mover pregunta si se avisa al cliente.
- Choques: los sigue bloqueando la base; el panel muestra el error en palabras simples.

### 5.2 Aprobación del dueño por WhatsApp

Cuando `require_approval` está prendido:

1. El cliente termina el flujo. La cita se crea como **`pending`** (el horario queda apartado,
   el bloqueo de choques ya cubre `pending`).
2. Al cliente: "Recibimos tu solicitud de {cita} para el {día} a las {hora}. Te confirmamos por
   aquí en cuanto el negocio la apruebe."
3. Al **aprobador** le llega un WhatsApp con los datos de la cita (servicio, cliente, día, hora,
   respuestas extra), botones **Aceptar** / **Rechazar** y el enlace **"Agregar a mi
   calendario"** (§5.4).
   - Aprobador = teléfono del profesional asignado (`booking_staff.phone`) si lo tiene; si no,
     el nuevo `booking_settings.approval_phone` (teléfono de avisos del negocio). Debe ser
     distinto del número de WhatsApp del negocio.
4. **Aceptar** → `confirmed`. Al cliente: confirmación + "Agregar a mi calendario". Desde aquí
   aplican los recordatorios por WhatsApp de siempre. La cita entra al enlace de sincronización.
5. **Rechazar** → `cancelled` (motivo `rejected_by_business`). Al cliente: "Ese horario ya no
   está disponible. ¿Quieres elegir otro?" y el bot retoma en el paso de la hora con el mismo
   servicio.
6. **Sin respuesta**: a los `approval_timeout_minutes` (por defecto 60) se le vuelve a escribir
   al aprobador una vez y la cita se resalta en el panel. **Nunca se confirma sola.** Si llega a
   2 h antes de la hora sin respuesta, se cancela y al cliente se le pide disculpas con la opción
   de reagendar.

Seguridad: el botón lleva el id de la cita y una firma HMAC; el webhook solo acepta la respuesta
si viene del teléfono del aprobador de **esa** cita y la firma es válida. Un cliente no puede
aprobar su propia cita.

WhatsApp/Meta: escribirle al aprobador es un mensaje que inicia el negocio. Dentro de 24 h desde
el último mensaje del aprobador se usan botones interactivos normales; fuera de 24 h hace falta
una **plantilla de utilidad aprobada en Meta** (`cita_por_aprobar`, con botones de respuesta
rápida), igual que los recordatorios. La plantilla la crea el usuario en WhatsApp Manager.
Esas conversaciones tienen costo según la tarifa de Meta (a revisar).

Cuando `require_approval` está apagado: la cita se confirma al instante y, si hay aprobador
configurado, solo se le avisa ("Nueva {cita}") con el enlace "Agregar a mi calendario".

### 5.3 Sincronización automática (enlace de suscripción .ics)

- Un enlace privado por negocio y uno por profesional:
  `GET /api/agenda/feed/{token}.ics`. Se pega una vez en Google Calendar ("Desde URL"), Apple
  Calendar ("Nueva suscripción") u Outlook.
- Tabla `booking_calendar_feeds (id, account_id, staff_id null, token_hash, created_at,
  revoked_at)`. El token (32 bytes aleatorios) se muestra una vez; se guarda solo su hash. Se
  puede revocar y crear otro.
- Contenido: citas **`confirmed`** desde hace 30 días hasta 180 días adelante. `UID` = id de la
  cita (las ediciones actualizan el mismo evento; las canceladas desaparecen). Título
  "{servicio} · {nombre del cliente}". **Sin teléfonos**. Zona horaria de la cuenta
  (America/Bogota por defecto).
- Límite de pedidos por token. Respuesta con `Cache-Control` corto.
- Aviso honesto en el panel: Apple refresca en minutos; Google puede tardar varias horas. Para
  verla al instante está el botón de §5.4 y, más adelante, Google en vivo (§6).

### 5.4 "Agregar a mi calendario" (una cita)

Dos enlaces por cita, firmados:

- Google: enlace de plantilla de evento de Google Calendar con título, hora y lugar.
- Apple / Outlook: `GET /api/agenda/cita/{id}/{firma}.ics` (un solo evento).

Va en el mensaje al aprobador (§5.2 paso 3) y en la confirmación al cliente (paso 4).

## 6. Diseñado para después: Google en vivo (doble vía)

OAuth de Google por negocio o profesional, escribir la cita al confirmarse, leer ocupado
(`freeBusy`) para que el bot no ofrezca esas horas, y webhooks de cambios. Requiere proyecto en
Google Cloud y verificación de Google por usar el permiso de calendario. No entra en esta fase.

## 7. Fase 3 — Mockups y motion design

- Proyecto Remotion aparte (como `shift-whatsapp-demo`), grabado de la app real ya generalizada
  con datos ficticios y la cuenta smoke.
- Mensaje: "¿Tu negocio vive de citas por WhatsApp?" Muestra el mismo sistema cambiando de
  barbería a consultorio y a taller (presets reales), el dueño aceptando la cita desde su
  WhatsApp y la cita apareciendo en el calendario.
- Voz: receta única de Shift (Andre · MiniMax + frase ancla), siempre español nativo.
- Mockups premium (laptop + celular) para web e Instagram con pantallas reales.
- Reglas: sin personas, sin funciones inventadas, CTA oficial, precios "desde".

## 8. Pruebas

- Unitarias: presets, palabras y piezas → pasos del bot; generación de `.ics` (feed y una cita,
  zona horaria, escape de texto); firma HMAC de botones y enlaces; reglas de tiempo de la
  aprobación.
- Integración: webhook de aprobación (aprobador correcto / teléfono ajeno / firma inválida /
  cita ya cancelada); rechazo que retoma el flujo; recordatorios solo para `confirmed`.
- RLS de las tablas nuevas, siguiendo `rls-policies.test.ts`.
- Prueba manual con la cuenta smoke. Ojo: `.env.local` apunta a producción, así que los datos
  de prueba se marcan y se limpian.

## 9. Riesgos y temas a revisar

- Plantillas de Meta: aprobación y costo de los mensajes al aprobador.
- Protección de datos (Ley 1581): el enlace .ics lleva nombres de clientes. Va sin teléfonos y
  con token revocable, pero se marca para revisar con abogado.
- Google refresca las suscripciones .ics despacio: se explica en el panel.
- Mover `barberia` a `agenda` toca muchas rutas: redirección y pruebas de regresión.

## 10. Decisiones tomadas

- Un solo módulo "Agenda" configurable, no un módulo por tipo de negocio.
- Las 4 piezas pedidas (profesional, precios/duración, preguntas extra, recordatorios /
  reprogramar) más "aprobar cada cita".
- Calendario en esta fase: interno + enlace de suscripción .ics + "Agregar a mi calendario".
  Google en vivo después.
- El dueño aprueba o rechaza desde WhatsApp; una cita sin respuesta nunca se confirma sola.
- Ventas, POS e inventario, y pedidos quedan para después.
