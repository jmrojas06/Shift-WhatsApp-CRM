# Montaje de una clínica odontológica

Guía para Shift. Aplica a una clínica con la Agenda de Shift. Diseño:
`docs/superpowers/specs/2026-11-02-odontologia-design.md`.

Antes de la primera clínica real, el abogado revisa lo de la sección 11
(la autorización de datos, entre otras cosas) y el director de la clínica
aprueba los signos de alarma.

Dos palabras que se repiten:

- **Autorización de datos:** el permiso que la persona da, con un botón,
  para que la clínica guarde sus datos (algunos son de salud). Sin ella
  el bot no sigue y la IA no ve el chat.
- **Aviso de urgencia:** el mensaje que ve el equipo en la app cuando una
  persona dice que le duele o toca "Tengo una urgencia".

## 1. Aplicar la migración 055

Solo con el OK de quien despliega, en el SQL Editor de Supabase y **antes**
de desplegar el código. Es aditiva (solo crea tablas, columnas y reglas) y
se puede correr de nuevo.

Antes de aplicarla, comprueba la versión de Postgres:

```sql
show server_version;
```

Tiene que dar **15 o más**. Con una versión menor, la migración falla (usa
una sintaxis de Postgres 15). Como corre en una sola transacción, no queda
nada a medias, pero tampoco queda aplicada: hay que subir la versión del
proyecto primero.

## 2. Activar los módulos

Solo lo hace Shift, en el SQL Editor. Se activan **los dos módulos
juntos**:

```sql
update public.accounts
set modules = array(select distinct unnest(array_cat(modules, array['agenda', 'clinica'])))
where id = '<uuid-de-la-cuenta>';
```

`clinica` sola no sirve: el bot de la clínica vive dentro del de la agenda,
y sin `agenda` nadie atiende el chat. Los mensajes de los pacientes
quedarían sin respuesta (y la IA no los vería, porque la cuenta es una
clínica). Si por error quedó solo `clinica`, vuelve a correr la consulta de
arriba.

## 3. Instalar la plantilla

`/agenda` → tipo de negocio **Clínica odontológica**. Crea el catálogo
(Valoración, Limpieza, Control, Control de ortodoncia, Urgencia), un doctor
de ejemplo, la configuración de la clínica y una sede.

La instalación no pisa nada que la cuenta ya tenga: ni el catálogo, ni el
prompt del agente de IA (ver la sección 7).

## 4. Ajustar la configuración

Doctores, horarios y atenciones se editan en `/agenda/configuracion`. Lo
demás va por SQL en esta fase.

### 4.1 La autorización de datos

El texto que ve la persona está en `clinic_settings.consent_text` (hasta 900
caracteres). El que trae por defecto es una propuesta: **el abogado lo
revisa antes de la primera clínica real**.

```sql
update public.clinic_settings
set consent_text = '<texto revisado por el abogado>',
    consent_version = consent_version + 1
where account_id = '<uuid-de-la-cuenta>';
```

Sube `consent_version` cada vez que cambie el texto. Cada respuesta guarda
el texto exacto que la persona vio y su versión, en un registro que solo
se agrega (nada se edita ni se borra). Subir la versión **no vuelve a
pedir** la autorización a quien ya aceptó.

Cómo se acepta:

- **Solo con el botón "Sí, acepto".** Escribir "sí", "acepto" o un número
  no acepta nada: el bot vuelve a mostrar los botones y, a la segunda, el
  chat pasa a una persona.
- Escribir una negación ("no acepto", "no") cuenta como rechazo. Quien no
  acepta queda con una persona, y el bot no sigue.
- Tocar "No acepto" después de haber aceptado **revoca** la autorización:
  queda registrado y el chat pasa a una persona.

Pregunta aparte, después de agendar: "¿Quieres que te avisemos cuando te
toque tu próximo control?". Es otra autorización (`mercadeo`), solo se
pregunta una vez y solo la da el botón "Sí, avísame". Hoy solo se guarda la
respuesta: **todavía no se envía ningún aviso de control**.

### 4.2 Signos de alarma y urgencias

```sql
update public.clinic_settings
set urgency_alarm_text = '<texto aprobado por el director>',
    urgency_words = array['urgencia', 'dolor', 'hinchazon', 'sangrado'],
    offer_days = 30
where account_id = '<uuid-de-la-cuenta>';
```

- `urgency_alarm_text` (hasta 900 caracteres): los signos de alarma que el
  bot le muestra a quien dice que le duele. Los aprueba el director.
- `urgency_words`: palabras que abren los signos de alarma. En minúsculas y
  **sin tildes**, y se comparan como palabra entera ("dolor" no se activa
  con "Dolores", que es un nombre).
- **El piso fijo.** Además de esa lista, el código trae un piso de palabras
  que siempre abren los signos de alarma (hinchazón, sangrado, "respirar",
  "golpe", dientes rotos o que se cayeron...). No se edita desde la base:
  una lista vacía o un fallo de lectura no dejan a nadie sin detectar. La
  lista de la clínica solo agrega.
- `urgency_service_id`: la atención con la que el bot ofrece la hora de
  hoy a quien no tiene signos de alarma. El instalador enlaza sola la
  atención que se llame **Urgencia** (sin importar mayúsculas), y solo la
  primera vez que crea la configuración. Si la atención se llama distinto o
  se creó después, enlázala:

  ```sql
  update public.clinic_settings
  set urgency_service_id = (
    select id from public.booking_services
    where account_id = '<uuid-de-la-cuenta>' and name = '<atención de urgencia>'
  )
  where account_id = '<uuid-de-la-cuenta>';
  ```

  Sin esa atención, o sin cupo hoy, la urgencia pasa a una persona con el
  aviso de urgencia (ver la sección 9) y, si hay, el teléfono de turno.
- `offer_days`: cuántos días hacia adelante ofrece horas el bot ("Ver más
  días" muestra más).

### 4.3 La sede

La sede se crea sola y se llama **Principal**. El recordatorio dice "sede
Principal": por eso el nombre va **sin** la palabra "sede". Cámbiala por el
nombre real de la clínica ("Centro", "Chapinero"):

```sql
update public.clinic_locations
set name = '<nombre de la sede>', address = '<dirección>',
    latitude = 0, longitude = 0,
    on_call_phone = '<teléfono de turno>'
where account_id = '<uuid-de-la-cuenta>';
```

Las coordenadas arman el mapa que llega al confirmar. El teléfono de turno
es el que recibe quien tiene una urgencia fuera de horario. Una cita sin
sede (por ejemplo, una anterior al módulo) se recuerda como "sede
Principal", aunque la sede real se llame distinto.

### 4.4 Instrucciones previas

Lo que se le manda a quien confirma una cita, por atención:

```sql
update public.booking_services
set prep_instructions = '<qué llevar o cómo prepararse>'
where account_id = '<uuid-de-la-cuenta>' and name = '<atención>';
```

Hasta 900 caracteres. Solo texto de la clínica: ni procedimiento ni
consejo médico. Un texto de solo espacios no manda nada.

## 5. Crear la plantilla en Meta

WhatsApp Manager → Plantillas → Crear:

| Campo | Valor |
| --- | --- |
| Nombre | `recordatorio_cita_clinica` |
| Categoría | Utilidad |
| Idioma | Español, `es` |

Cuerpo:

```
¡Hola! 👋 Te recordamos que {{1}} tiene cita en {{2}}, sede {{3}}:

👤 {{4}}
📅 {{5}}
🕐 {{6}}

¿Nos confirmas?
```

Las variables son, en este orden: paciente, clínica, sede, doctor, fecha y
hora. **No agregues el procedimiento**: el teléfono puede ser compartido,
y el recordatorio, lo que se guarda del mensaje y la respuesta a
"Confirmar" nunca lo nombran.

Botones de respuesta rápida, en este orden: `Confirmar`, `Reprogramar`,
`Cancelar`. Los botones de la plantilla son fijos: aunque la cuenta tenga
apagada la pieza de reprogramar, la plantilla muestra los tres.

El nombre y el idioma tienen que coincidir exactamente con
`CLINIC_REMINDER_TEMPLATE` en `src/verticals/agenda/agent/reminders.ts`.

**Falta comprobarlo con un toque real.** El código manda en cada botón un
payload con la cita (`rem:<acción>:<cita>`) y espera que Meta lo devuelva
junto con `context.id` (el mensaje al que responde el toque). No se ha
probado con Meta. Antes de la primera clínica, envía un recordatorio real a
un celular de prueba, toca un botón y revisa:

```sql
select m.interactive_reply_id, m.reply_to_message_id, p.template_name
from public.messages m
left join public.messages p on p.id = m.reply_to_message_id
where m.conversation_id = '<uuid-de-la-conversación>' and m.sender_type = 'customer'
order by m.created_at desc
limit 3;
```

- `interactive_reply_id` debe ser `rem:confirm:<id de la cita>`. Si es
  `Confirmar`, Meta ignoró el payload: el bot lo resuelve igual (es la
  próxima cita activa y, si hay más de una, pregunta cuál), pero hay que
  anotarlo.
- `reply_to_message_id` no debe ser nulo y `template_name` debe ser
  `recordatorio_cita_clinica`. Si queda vacío, el toque que llega solo con
  la etiqueta ("Confirmar") **no se reconoce** como respuesta a un
  recordatorio y el bot no lo atiende: no se puede abrir la clínica así.

## 6. Revisar Meta

- Medio de pago en Billing Hub: sin él, Meta deja de entregar los mensajes
  del bot después de 1.000 al mes por número. Las plantillas de recordatorio
  también se cobran: revisa la tarifa vigente para Colombia.

## 7. El agente de IA

El agente contesta "Precios y dudas". Se configura en **Agentes de IA** →
pestaña **Configuración**, con los documentos de la clínica.

- **Revisa el prompt.** La instalación solo escribe el prompt si estaba
  vacío; si la cuenta ya tenía uno, queda como estaba. Compara el que
  quedó guardado con el de la plantilla (`src/verticals/agenda/presets/odontologia.ts`)
  y asegúrate de que tenga las **reglas de salud**: nunca dar diagnósticos,
  nunca recomendar medicamentos ni dosis, y mandar a "urgencia" a quien
  describa dolor fuerte, sangrado, hinchazón o un golpe.
- **El bloque fijo se aplica igual.** Aunque el prompt no las tenga, el
  código agrega al final unas reglas de seguridad que no se pueden editar
  (no diagnosticar, no mencionar medicamentos, pasar a una persona todo lo
  que hable de síntomas). El prompt es para el tono, no para la seguridad.
- **La IA no ve el chat de nadie que no haya aceptado la autorización de
  datos.** Ni la respuesta automática ni "Sugerir con IA".
- **Si la IA está apagada, las dudas pasan a una persona.** Cuenta como
  apagada: la respuesta automática desactivada, una automatización activa
  que contesta primero, el tope de respuestas de la conversación alcanzado
  o una llave que no se puede leer. En esos casos el bot no invita a
  escribir la duda: pasa el chat a una persona.
- Al activar la IA, los chats con datos de salud viajan al proveedor de IA
  que la clínica eligió: es un tema del abogado (sección 11).

## 8. Lo que el bot hace por su cuenta

- Si el paciente manda dos mensajes seguidos, el bot atiende uno a la vez.
  Si no logra atender uno en 5 segundos, lo descarta y avisa al equipo
  técnico de Shift (sin el texto del paciente). Las urgencias, el "No
  acepto" y los botones del recordatorio se atienden siempre.
- Una cita se recuerda 24 h antes (y 2 h antes si la cuenta lo activa).
  Ver `docs/agenda-recordatorios.md`.
- Un número puede tener varios pacientes (una mamá agenda a sus hijos). La
  cita es del paciente; la autorización la da el número.

## 9. Los avisos de urgencia

Hoy los avisos de urgencia **solo se ven dentro de la app** (la campana de
notificaciones y la página de Notificaciones), para el agente asignado y el
dueño. No hay aviso por WhatsApp, correo ni mensaje de texto al doctor o a
la recepción, y **no se le debe prometer eso a la clínica**. Dile que
alguien del equipo tiene que mirar la app, o la bandeja, durante el horario
de atención.

Fuera de la app, solo Shift recibe una alerta cuando algo falla (por la
variable `ALERT_WEBHOOK_URL`, si está definida).

## 10. Probar

Desde un celular externo, sobre una cuenta de prueba:

1. Escribe `Hola`: pide la autorización. Acepta con el botón: abre el menú.
2. Agenda para ti y para otra persona desde el mismo número.
3. Después de agendar llega la pregunta de avisos de control. Responde
   "Sí, avísame" con el botón; la siguiente cita ya no la pregunta.
4. Escribe `tengo dolor`: muestra los signos de alarma. Revisa que el
   aviso de urgencia aparezca en la app.
5. Prueba `Ver más días`.
6. Con la IA prendida, escribe una duda ("¿tienen parqueadero?"): la
   contesta la IA. Apágala y repite: el chat pasa a una persona.
7. Dispara el recordatorio (sección 5): no nombra el procedimiento.
8. Toca Confirmar: responde con paciente, doctor, fecha y hora (sin el
   procedimiento) y llegan las instrucciones y el mapa.
9. Con dos citas del mismo número, toca el botón de un recordatorio y
   comprueba que confirma la cita correcta (o pregunta cuál).
10. Toca "No acepto" en el menú: queda registrado y el chat pasa a una
    persona.

Los datos de prueba se marcan y se limpian al terminar.

## 11. Pendientes del abogado

Nada de esto lo decide Shift. Hay que revisarlo con un abogado antes de la
primera clínica real:

- **El texto de la autorización de datos** (el que viene por defecto es una
  propuesta) y si hay que volver a pedirla cuando el texto cambia.
- **La revocación:** qué texto ve la persona al revocar y cómo debe
  quedar registrada (hoy se guarda el texto vigente).
- **El permiso declarado en recepción:** si la clínica dice que obtiene el
  permiso en recepción, `clinic_settings.reception_consent_declared_at`
  deja la constancia, pero hoy el bot no la lee ni copia esa autorización
  a las citas que crea recepción.
- **El envío de chats al proveedor de IA:** que los datos de salud viajen
  al proveedor de IA que la clínica elija, y qué debe decir la autorización
  sobre eso.

Shift no es una empresa registrada: los temas legales y de impuestos se
revisan con abogado y contador, no se afirman aquí.
