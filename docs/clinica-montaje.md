# Montaje de una clínica odontológica

Guía para Shift. Aplica a una clínica con la Agenda de Shift. Diseño:
`docs/superpowers/specs/2026-11-02-odontologia-design.md`.

## Qué cubre esta fase (y qué no)

Esta fase deja listo por WhatsApp lo que el paciente hace solo: pedir una
cita, agendar para él o para otra persona, recibir el recordatorio,
confirmar, reprogramar, cancelar, preguntar dudas y avisar de una urgencia.

**No basta para operar una clínica real.** Faltan, y no se deben
prometer:

- **La recepción no puede crear citas hasta la Fase 2.** Hoy las citas
  entran por el bot.
- **Los cuidados después de la visita y la calificación son de la Fase 3.**
  No existen todavía.
- **Los avisos de control** (la pregunta "¿quieres que te avisemos cuando te
  toque tu próximo control?") solo guardan la respuesta; no se envía ningún
  aviso.
- **Los avisos de urgencia solo se ven en la app** (sección 10).

Úsala como piloto, en una cuenta de prueba. Antes de la primera clínica
real, el abogado revisa lo de la sección 12 (la autorización de datos,
entre otras cosas) y el director de la clínica aprueba los signos de alarma.

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

## 3. Conectar el número de WhatsApp

Sin esto el bot no recibe ni envía nada. En la app:
**Configuración → pestaña WhatsApp** (`/settings?tab=whatsapp`):

1. Phone Number ID, WABA ID, token y verify token del número de la clínica.
2. Botón **Verificar con Meta**: tiene que salir bien.
3. En Meta → App → WhatsApp → Configuration: la Callback URL
   (`https://<dominio>/api/whatsapp/webhook`), el mismo verify token y la
   suscripción al campo `messages`.
4. Desde un celular de prueba, escribe al número: el mensaje tiene que
   aparecer en la **Bandeja de entrada** en segundos.

Los pasos completos y los errores comunes están en
`docs/onboarding-cliente.md` (pasos 5 y 6), en
`docs/whatsapp-connection-troubleshooting.md` y, con varios números, en
`docs/multi-waba.md`.

## 4. Instalar la plantilla

`/agenda` → tipo de negocio **Clínica odontológica**. Crea el catálogo
(Valoración, Limpieza, Control, Control de ortodoncia, Urgencia), un doctor
de ejemplo, la configuración de la clínica y una sede.

La instalación no pisa nada que la cuenta ya tenga: ni el catálogo, ni el
prompt del agente de IA (ver la sección 8).

## 5. Ajustar la configuración

Doctores, horarios y atenciones se editan en `/agenda/configuracion`. Lo
demás va por SQL en esta fase.

### 5.1 La autorización de datos

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

Cómo se revoca (con la autorización vigente, en cualquier paso, menos
mientras la persona responde los signos de alarma):

- Tocando "No acepto" en un menú que lo tenga.
- **Escribiendo:** "no acepto" o "ya no autorizo" (el mensaje completo), o
  una frase que junte un verbo (revoco, retiro, quiten, borren, eliminen,
  "no quiero que usen"...) con "autorización" o "mis datos": "ya no autorizo
  el uso de mis datos", "revoco mi autorización", "quiero que borren mis
  datos". "No acepto esa hora" o "borré el mensaje" **no** son revocaciones.
- Queda registrado (`granted: false`) y el chat pasa a una persona, con una
  nota. **Si pidió borrar sus datos, la nota lo dice: el bot no borra
  nada, hay que atenderlo a mano.**
- En un chat que ya lleva una persona, solo se registra y se avisa a quien
  lo lleva; el bot no le escribe al paciente.
- Quien revocó deja de recibir recordatorios, y su "Reprogramar" lo atiende
  una persona.

El texto por defecto no explica cómo revocar ni menciona el borrado de
datos, y no se cambió para no tocar el texto legal: es parte de lo que
revisa el abogado (sección 12).

Pregunta aparte, después de agendar: "¿Quieres que te avisemos cuando te
toque tu próximo control?". Es otra autorización (`mercadeo`), solo se
pregunta una vez y solo la da el botón "Sí, avísame". Solo un "no" completo
("no", "no gracias", "mejor no") la rechaza. Hoy solo se guarda la
respuesta: **todavía no se envía ningún aviso de control**.

### 5.2 Signos de alarma y urgencias

La instalación deja una lista de palabras de urgencia en
`clinic_settings.urgency_words`. **Agrégale las de la clínica con `||`; no
la reemplaces**, porque trae palabras (fiebre, absceso, fractura...) que el
piso fijo no tiene:

```sql
update public.clinic_settings
set urgency_alarm_text = '<texto aprobado por el director>',
    urgency_words = urgency_words || array['sangrado', 'se me cayo'],
    offer_days = 30
where account_id = '<uuid-de-la-cuenta>';
```

- `urgency_alarm_text` (hasta 900 caracteres): los signos de alarma que el
  bot le muestra a quien dice que le duele. Los aprueba el director.
- `urgency_words`: palabras que abren los signos de alarma. En minúsculas y
  **sin tildes**, y se comparan como palabra entera ("dolor" no se activa
  con "Dolores", que es un nombre).
- **El piso fijo.** Además de esa lista, el código trae un piso de palabras
  que siempre abren los signos de alarma, aunque la lista esté vacía:
  dolor, duele, duelen, urgencia, urgente, emergencia, "tragar",
  hinchazón, sangrado, "respirar", "golpe", dientes rotos o que se
  cayeron ("se me cayó un diente")... No se edita desde la base. La lista de la clínica **se suma**
  al piso; no lo reemplaza ni lo reduce.
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
  aviso de urgencia (ver la sección 10) y, si hay, el teléfono de turno.
- `offer_days`: cuántos días hacia adelante ofrece horas el bot ("Ver más
  días" muestra más).

### 5.3 La sede

La sede se crea sola y se llama **Principal**. El recordatorio dice "sede
Principal": por eso el nombre va **sin** la palabra "sede". Cámbiala por el
nombre real de la clínica ("Centro", "Chapinero"):

```sql
update public.clinic_locations
set name = '<nombre de la sede>', address = '<dirección>',
    latitude = <latitud>, longitude = <longitud>,
    on_call_phone = '<teléfono de turno>'
where account_id = '<uuid-de-la-cuenta>';
```

Reemplaza `<latitud>` y `<longitud>` por las coordenadas reales de la sede
(por ejemplo `4.711000` y `-74.072100`: salen del enlace de Google Maps).
**Un 0 literal deja el mapa mal**: 0, 0 es un punto en medio del océano,
y el bot lo manda tal cual. Si no tienes las coordenadas, pon
`latitude = null, longitude = null` y el bot no manda mapa.

Las coordenadas arman el mapa que llega al confirmar. El teléfono de turno
es el que recibe quien tiene una urgencia fuera de horario. Una cita sin
sede (por ejemplo, una anterior al módulo) se recuerda como "sede
Principal", aunque la sede real se llame distinto.

### 5.4 Instrucciones previas

Lo que se le manda a quien confirma una cita, por atención:

```sql
update public.booking_services
set prep_instructions = '<qué llevar o cómo prepararse>'
where account_id = '<uuid-de-la-cuenta>' and name = '<atención>';
```

Hasta 900 caracteres. Solo texto de la clínica: ni procedimiento ni
consejo médico. Un texto de solo espacios no manda nada.

## 6. Crear la plantilla en Meta

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
probado con Meta. Antes de la primera clínica, envía un recordatorio real
por plantilla (ver la sección 11, paso 9) a un celular de prueba, toca un
botón y revisa:

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

## 7. Revisar Meta

- Medio de pago en Billing Hub: sin él, Meta deja de entregar los mensajes
  del bot después de 1.000 al mes por número. Las plantillas de recordatorio
  también se cobran: revisa la tarifa vigente para Colombia.

## 8. El agente de IA y el agente de pase

El agente contesta "Precios y dudas". Se configura en **Agentes de IA** →
pestaña **Configuración**, con los documentos de la clínica.

- **Activa la IA y la respuesta automática.** "Activar asistente de IA" y
  "Responder automáticamente a mensajes entrantes", con la clave del
  proveedor.
- **Configura el agente de pase.** En la misma pestaña, **"Derivar a"**: la
  persona a la que la IA pasa un chat cuando no puede contestar. Elige a
  alguien de la recepción. Si lo dejas en "Cola sin asignar", el chat queda
  sin dueño y el aviso en la app le llega al dueño de la cuenta.
- **Revisa el prompt.** La instalación solo escribe el prompt si estaba
  vacío; si la cuenta ya tenía uno, queda como estaba. Compara el que
  quedó guardado con el de la plantilla (`src/verticals/agenda/presets/odontologia.ts`)
  y asegúrate de que tenga las **reglas de salud**: nunca dar diagnósticos,
  nunca recomendar medicamentos ni dosis, y mandar a "urgencia" a quien
  describa dolor fuerte, sangrado, hinchazón o un golpe.
- **El bloque fijo.** Aunque el prompt no tenga esas reglas, el código
  agrega al final unas reglas de seguridad que no se pueden editar (no
  diagnosticar, no mencionar medicamentos, pasar a una persona todo lo que
  hable de síntomas). Se aplican a la **respuesta automática** y a
  **"Redactar con IA"** de la bandeja. **El Playground NO las lleva**: lo que
  contesta ahí no es lo que recibirá el paciente, así que no sirve para
  juzgar la seguridad. El prompt es para el tono, no para la seguridad.
- **Cuando la IA pasa un chat de salud a una persona** (un síntoma sin
  palabra de urgencia: "me arde la encía desde ayer, ¿es normal?"), el
  paciente recibe un texto fijo: "Esto lo debe revisar una persona de la
  clínica. Ya le avisé y te escribe por este chat. Si aparece uno de estos
  signos, ve a urgencias sin esperar respuesta:", seguido de los signos de
  alarma de la clínica. Además el agente de pase (o el dueño) recibe un
  aviso en la app, y el chat queda en pausa (ver la sección 10).
- **La IA no ve el chat de nadie que no haya aceptado la autorización de
  datos.** Ni la respuesta automática ni "Redactar con IA".
- **Si la IA está apagada, las dudas pasan a una persona.** Cuenta como
  apagada: la respuesta automática desactivada, una automatización activa
  que contesta primero, el tope de respuestas de la conversación alcanzado
  o una llave que no se puede leer. En esos casos el bot no invita a
  escribir la duda: pasa el chat a una persona.
- Al activar la IA, los chats con datos de salud viajan al proveedor de IA
  que la clínica eligió: es un tema del abogado (sección 12).

## 9. Lo que el bot hace por su cuenta

- Si el paciente manda dos mensajes seguidos, el bot atiende uno a la vez.
  Si no logra atender uno en 5 segundos, lo descarta y avisa al equipo
  técnico de Shift (sin el texto del paciente). Las urgencias, el "No
  acepto" o la revocación escrita, y los botones del recordatorio se
  atienden siempre.
- Una cita se recuerda 24 h antes (y 2 h antes si la cuenta lo activa).
  Ver `docs/agenda-recordatorios.md`. **No se recuerda a quien escribió
  "baja" o "stop"** (tiene la etiqueta `baja-envios`) **ni a quien revocó la
  autorización**: la señal no se gasta, y si vuelve a autorizar o le quitan
  la etiqueta, el recordatorio sale en la siguiente corrida.
- Un número puede tener varios pacientes (una mamá agenda a sus hijos). La
  cita es del paciente; la autorización la da el número. Si dos pacientes
  tienen nombres parecidos, los botones salen numerados y los nombres
  completos van en el mensaje.

## 10. Los avisos y los pases

Hoy los avisos **solo se ven dentro de la app** (la campana de
notificaciones y la página de Notificaciones), para el agente asignado y el
dueño. No hay aviso por WhatsApp, correo ni mensaje de texto al doctor o a
la recepción, y **no se le debe prometer eso a la clínica**. Dile que
alguien del equipo tiene que mirar la app, o la bandeja, durante el horario
de atención.

Los avisos que existen:

- **"Revisa este chat: posible urgencia"**: sale **de inmediato**, con el
  primer mensaje que abre los signos de alarma (aunque la persona no los
  haya contestado). Uno por chat cada 10 minutos.
- **"Posible urgencia"**: cuando la persona confirma que tiene signos de
  alarma, o el bot no pudo seguir. Es el más grave y no se pierde por el
  límite de 10 minutos.
- **"Un paciente necesita a una persona"**: la IA no contestó algo de
  salud y pasó el chat.
- **"Un paciente pidió borrar sus datos"**: solo en un chat que ya lleva
  una persona. En los demás, la nota del chat lo dice.

Fuera de la app, solo Shift recibe una alerta cuando algo falla (por la
variable `ALERT_WEBHOOK_URL`, si está definida), sin el texto del
paciente.

**Los chats que el bot pasa a una persona quedan en pausa.** Para devolver
el chat al bot, en la **Bandeja** abre el chat y usa **"Reanudar bot"** (y
**"Reanudar IA"** para la respuesta automática), en el aviso de arriba del
chat. Hazlo después de cada paso de prueba que lo deje en pausa.

## 11. Probar

Desde un celular externo, sobre una cuenta de prueba, con WhatsApp conectado
(sección 3) y el agente de pase configurado (sección 8):

1. Escribe `Hola`: pide la autorización. Acepta con el botón: abre el menú.
2. Agenda para ti y para otra persona desde el mismo número. La cita debe
   empezar en **menos de 24 horas** (para el paso 9).
3. Después de agendar llega la pregunta de avisos de control. Responde
   "Sí, avísame" con el botón; la siguiente cita ya no la pregunta.
4. Escribe `tengo dolor`: muestra los signos de alarma y, **sin contestar**,
   en la app aparece el aviso "Revisa este chat: posible urgencia". Toca
   "Sí, tengo alguno": llega "Posible urgencia" y el chat **queda en
   pausa** (usa "Reanudar bot" en la Bandeja).
5. Con la IA prendida, escribe `me arde la encía desde ayer, ¿es normal?`:
   el paciente recibe el texto fijo con los signos de alarma, el agente de
   pase recibe "Un paciente necesita a una persona" y el chat **queda en
   pausa** (usa "Reanudar IA" en la Bandeja).
6. Prueba `Ver más días`.
7. Con la IA prendida, escribe una duda ("¿tienen parqueadero?"): la
   contesta la IA. Apágala y repite: el chat pasa a una persona (**en
   pausa**: "Reanudar bot").
8. Revisa lo que se mandó al confirmar la cita: el nombre del paciente, no
   el procedimiento.
9. **Dispara el recordatorio.** La cita tiene que empezar en menos de 24 h.
   Con la cuenta de prueba, desde una terminal:

   ```bash
   curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
     https://<tu-dominio>/api/verticals/agenda/reminders/run
   ```

   `$AUTOMATION_CRON_SECRET` es el secreto del entorno (ver
   `docs/agenda-recordatorios.md`). Mira la respuesta: `sent: 1` y, en
   `byChannel`, `template` o `text`.

   **Para probar la plantilla, el celular no debe haber escrito al número
   en las últimas 24 horas.** Si escribió, el recordatorio sale como un
   mensaje con botones (`text`), no como la plantilla de Meta. Para
   probarla ya, en la cuenta de prueba envejece sus mensajes:

   ```sql
   update public.messages
   set created_at = created_at - interval '2 days'
   where conversation_id = '<uuid-de-la-conversación>' and sender_type = 'customer';
   ```

   Para repetir el recordatorio de la misma cita:

   ```sql
   update public.booking_appointments
   set reminder_sent_at = null, reminder_2h_sent_at = null
   where id = '<uuid-de-la-cita>';
   ```

   El mensaje no nombra el procedimiento. Si `skipped` sube y no sale
   nada, la persona tiene la etiqueta `baja-envios` o revocó la
   autorización.
10. Toca Confirmar: responde con paciente, doctor, fecha y hora (sin el
    procedimiento) y llegan las instrucciones y el mapa. Revisa la
    consulta de la sección 6.
11. Con dos citas del mismo número, toca el botón de un recordatorio y
    comprueba que confirma la cita correcta (o pregunta cuál).
12. **Revocar:** escribe `ya no autorizo`. Queda registrado, el chat pasa a
    una persona y queda **en pausa** (devuélvelo con "Reanudar bot" solo
    si vas a seguir probando). Comprueba que ya no sale el recordatorio de
    esa persona (`skipped`) y que su "Reprogramar" lo atiende una persona.
    Para seguir probando, vuelve a aceptar la autorización con el botón.

Los datos de prueba se marcan y se limpian al terminar.

## 12. Pendientes del abogado

Nada de esto lo decide Shift. Hay que revisarlo con un abogado antes de la
primera clínica real:

- **El texto de la autorización de datos** (el que viene por defecto es una
  propuesta), si hay que volver a pedirla cuando el texto cambia, y si debe
  explicar cómo revocarla.
- **La revocación:** qué texto ve la persona al revocar (hoy se guarda el
  texto vigente), cómo debe quedar registrada y qué se hace con quien pide
  borrar sus datos (el bot no borra nada: se atiende a mano).
- **El permiso declarado en recepción:** si la clínica dice que obtiene el
  permiso en recepción, `clinic_settings.reception_consent_declared_at`
  deja la constancia, pero hoy el bot no la lee ni copia esa autorización
  a las citas que crea recepción.
- **El envío de chats al proveedor de IA:** que los datos de salud viajen
  al proveedor de IA que la clínica elija, y qué debe decir la autorización
  sobre eso.

Shift no es una empresa registrada: los temas legales y de impuestos se
revisan con abogado y contador, no se afirman aquí.
