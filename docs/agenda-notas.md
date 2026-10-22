# Agenda armable — temas a revisar y decisiones

Notas abiertas de la Fase 1. Nada de esto bloquea el despliegue
(`docs/agenda-despliegue-fase1.md`), pero conviene resolverlo antes de
abrir la agenda a más tipos de negocio. Los temas legales o de impuestos
se marcan **para revisar con abogado o contador**; esta guía no es
asesoría legal.

## 1. Ley 1581 (protección de datos) — datos sensibles

Colombia regula los datos personales con la **Ley 1581 de 2012**
(«habeas data»). Los **datos sensibles** (por ejemplo, de salud) tienen
reglas más estrictas: requieren autorización expresa y el titular no
está obligado a darlos.

- La pregunta del punto de partida **Consultorio / salud** («¿Cuál es el
  motivo de la consulta?») y las preguntas extra que cree el dueño
  (dirección, placa, descripción de un problema) pueden guardar datos
  **sensibles** (salud) o **personales** (dirección de la casa).
- **Revisar con un abogado**: el texto de consentimiento que el bot
  debería mostrar antes de preguntar, dónde se guarda la autorización y
  cuánto tiempo se conservan las respuestas.
- Mientras tanto, la pregunta de salud viene como **opcional**: el
  cliente puede omitirla.
- Es un tema de **Shift como operador de la plataforma** y del dueño de
  cada negocio como responsable de los datos de sus clientes. Shift no es
  una empresa registrada (son dos personas naturales): marcar para
  abogado, no afirmar nada sobre razón social.

## 2. Las respuestas las ve todo el equipo

Las respuestas a las preguntas extra se guardan en la cita
(`booking_appointments.answers`) y se muestran en `/agenda`. Las ven
**todos los miembros de la cuenta** (owner, admin, agent y viewer): hoy
no hay permisos por campo. Si un negocio de salud no quiere que un
agente vea el motivo de la consulta, hoy no se puede restringir. Decisión
pendiente: ¿ocultar las respuestas a los roles agent/viewer, o a las
preguntas marcadas como sensibles?

## 3. Concurrencia del bot

No hay candado por conversación. Si el cliente manda **dos mensajes muy
seguidos**, el webhook puede procesarlos **en paralelo**; el segundo
puede leer el estado de la reserva antes de que el primero lo guarde.
Efecto posible: una respuesta repetida o un paso que se salta, y que la
conversación se vea confusa. Conviene probar el caso de doble mensaje
(incluida la confirmación de la cita) antes de abrir la agenda a mucho
tráfico. Pendiente: un lock o cola por conversación.

## 4. Moneda: el instalador fija COP

Al elegir un punto de partida, si la cuenta seguía en **USD** (el valor
por defecto de la migración 021), el instalador la pasa a **COP**. Si ya
había una moneda elegida, no la toca. Shift también vende en EE. UU. y
España: para esos negocios hay que **revisar la moneda** después de
elegir el tipo (pestaña **Negocio**). Decisión pendiente: preguntar la
moneda en el asistente en vez de asumir COP.

Relacionado: la zona horaria sigue fija en `America/Bogota` para todas
las cuentas (`docs/agenda-configuracion.md` → «Negocio»). Un negocio
fuera de Colombia vería las horas corridas hasta que exista soporte
multi-zona.

## 5. Trabajo de otra sesión sin commit (reprogramación)

En la **carpeta principal** del repo hay trabajo de otra sesión **sin
commit** (reprogramación a medias) que toca los **mismos archivos del
bot** que esta rama (`controller.ts`, `reminders.ts`, textos y sus
pruebas, el panel de recordatorios). Al integrarlo habrá conflictos:
hay que traerlo **a mano sobre esta rama** (no hacer merge ciego ni
pisar) y volver a correr typecheck, lint y las pruebas. Ojo con los
archivos que esta rama renombró de `barberia` a `agenda`.

## 6. Fuera de esta fase

- **Aprobar cada cita** (el dueño aprueba por WhatsApp antes de
  confirmar): Fase 2, junto con el calendario interno, el enlace `.ics`
  y «Agregar a mi calendario».
- Mockups y motion design: Fase 3.
- Soporte multi-zona horaria y multi-moneda en el asistente: sin fecha.
