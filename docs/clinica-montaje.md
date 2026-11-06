# Montaje de una clínica odontológica

Guía para Shift. Aplica a una clínica con la Agenda de Shift. Diseño:
`docs/superpowers/specs/2026-11-02-odontologia-design.md`. Las Fases 2 y 3
tienen el suyo: `docs/superpowers/specs/2026-11-05-clinica-fases-2-3-design.md`.

## Qué cubre esta guía (y qué no)

Las secciones 1 a 12 dejan listo por WhatsApp lo que el paciente hace solo
(Fase 1): pedir una cita, agendar para él o para otra persona, recibir el
recordatorio, confirmar, reprogramar, cancelar, preguntar dudas y avisar de
una urgencia.

Las secciones 13 a 23 agregan las Fases 2 y 3 (rama
`feat/clinica-fases-2-3`): el calendario para la recepción, la copia a Google
Calendar, las llamadas con voz por pasos y los mensajes de después de la
cita. Se montan después de la Fase 1 y cada pieza tiene sus pasos.

**No basta para operar una clínica real.** Faltan, y no se deben
prometer:

- **Sin las Fases 2 y 3, la recepción no puede crear citas** y las citas
  entran solo por el bot. Con ellas aplicadas (sección 13), la recepción
  crea, mueve y cancela desde `/agenda/calendario`.
- **Los cuidados después de la visita y la calificación son de la Fase 3.**
  No existen sin la migración 056 y las plantillas de la sección 15.
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
primera clínica real. Lo de las Fases 2 y 3 (llamadas con voz sintética,
Google y la autorización de recepción) está en la sección 23:

- **El texto de la autorización de datos** (el que viene por defecto es una
  propuesta), si hay que volver a pedirla cuando el texto cambia, y si debe
  explicar cómo revocarla.
- **La revocación:** qué texto ve la persona al revocar (hoy se guarda el
  texto vigente), cómo debe quedar registrada y qué se hace con quien pide
  borrar sus datos (el bot no borra nada: se atiende a mano).
- **El permiso declarado en recepción:** si la clínica dice que obtiene el
  permiso en recepción, `clinic_settings.reception_consent_declared_at`
  deja la constancia. Sin las Fases 2 y 3, el bot no la lee ni copia esa
  autorización a las citas que crea recepción. Con ellas, el calendario sí
  la copia (sección 16.4), y eso se revisa en la sección 23.
- **El envío de chats al proveedor de IA:** que los datos de salud viajen
  al proveedor de IA que la clínica elija, y qué debe decir la autorización
  sobre eso.

Shift no es una empresa registrada: los temas legales y de impuestos se
revisan con abogado y contador, no se afirman aquí.

---

## 13. Fases 2 y 3: qué se agrega y en qué orden se prende

Las Fases 2 y 3 están en la rama `feat/clinica-fases-2-3`. Su diseño está en
`docs/superpowers/specs/2026-11-05-clinica-fases-2-3-design.md`. Agregan
cuatro piezas. El calendario aparece en toda cuenta con `agenda` en cuanto
se despliega el código. Google y las llamadas se prenden aparte, cuenta por
cuenta. Los seguimientos de después de la cita también vienen apagados y se
prenden por SQL, cuenta por cuenta, cuando Meta aprobó las plantillas
(sección 16.5). Una cuenta que no prende nada de eso sigue como antes.

La única excepción: el botón **Confirmar** de un recordatorio ahora también
anota que el paciente dijo que va (`attendance_confirmed_at`), en todas las
cuentas. Está explicado en `docs/agenda-recordatorios.md`.

| Pieza | Para quién | Qué necesita |
| --- | --- | --- |
| Calendario de recepción (`/agenda/calendario`): crear, mover y cancelar citas, y la lista "Para llamar" en `/agenda` | Toda cuenta con `agenda` | Migración 056. Para avisar al paciente, las plantillas de la sección 15 |
| Copia a Google Calendar | Toda cuenta con `agenda`; la conecta el dueño | 056, Google Cloud (sección 17) y las variables de la sección 20 |
| Llamadas con voz por pasos (salientes y entrantes) | Toda cuenta con `agenda`; vienen apagadas | 056, Telnyx (sección 18) y prenderlas por cuenta (sección 19) |
| Después de la cita: cuidados, "¿Cómo sigues?" y calificación | Solo con `clinica`; vienen apagados y Shift los prende por cuenta (16.5) | 056, tres plantillas aprobadas (sección 15) y los ajustes de la sección 16 |
| Después de la cita: aviso del cierre del día | Solo con `clinica`; corre solo, sin interruptor | 056. Solo avisa al dueño dentro de la app; no le escribe a nadie más |

Palabras que se repiten en estas secciones:

- **SQL Editor:** la pantalla de Supabase donde Shift corre consultas con
  permisos de administrador de la base. Un administrador de la clínica no
  tiene esos permisos.
- **Variable de entorno:** un dato secreto o de configuración que se pone en
  el servidor (Vercel o el VPS), no en el código. Los secretos se guardan en
  Bitwarden.
- **Cron:** una tarea que el servidor repite sola cada cierto tiempo.
- **Webhook:** una dirección de la app a la que otro servicio (Meta, Google,
  Telnyx) le avisa que pasó algo.
- **TeXML:** el lenguaje en el que la app le dice a Telnyx qué hacer durante
  una llamada: "di esta frase", "espera una tecla", "pasa la llamada".
- **Identificador de llamada (caller ID):** el número que ve el paciente en
  su celular cuando lo llama el robot.
- **E.164:** la forma de escribir un teléfono con el signo `+` y el
  indicativo del país, sin espacios. Ejemplo: `+573001234567`.

**Orden recomendado:**

1. Aplicar la 056 (sección 14).
2. Pedir las plantillas en Meta (sección 15). Meta tarda en aprobarlas, así
   que se piden primero.
3. Ajustes por SQL de la clínica (sección 16, menos el interruptor de los
   seguimientos, 16.5).
4. Poner las variables y desplegar el código con los crons (sección 20).
5. Conectar Google (sección 17).
6. Montar Telnyx (sección 18) y prender las llamadas de esa cuenta
   (sección 19).
7. Cuando Meta haya aprobado las tres plantillas de después de la cita
   (15.6, 15.7 y 15.8), prender los seguimientos de esa cuenta (16.5).
8. Probar todo (sección 21).

**Las plantillas se piden y se aprueban antes de unir el PR y desplegar.**
Sin la plantilla aprobada, el aviso a un paciente que no ha escrito en 24
horas no sale. En el calendario eso no es grave: la cita se guarda y el panel
avisa que no se pudo notificar. En los seguimientos sí importa: un seguimiento
sin plantilla aprobada falla tres veces y se pierde. Por eso vienen apagados
(`followups_enabled = false` en `clinic_settings`): desplegar el código no le
escribe a ningún paciente, y Shift los prende cuenta por cuenta (16.5) solo
cuando las tres plantillas ya están aprobadas.

## 14. Aplicar la migración 056

La 056 crea lo que necesitan las Fases 2 y 3: las tablas de llamadas,
seguimientos y conexión con Google, y columnas nuevas en las citas. Es
aditiva (solo agrega) y se puede correr de nuevo, igual que la 055.

1. Comprueba que la 055 ya está aplicada:

   ```sql
   select to_regclass('public.clinic_settings') is not null as la_055_esta_aplicada;
   ```

   Debe dar `true`. Si da `false`, aplica primero la 055 (sección 1).

2. Comprueba la versión de Postgres, como en la sección 1:

   ```sql
   show server_version;
   ```

   Tiene que dar **15 o más**. Con una versión menor, la 056 falla por la
   misma razón que la 055.

3. **Solo con el OK de quien despliega**, en el SQL Editor de Supabase: pega
   el contenido completo de
   `supabase/migrations/056_clinica_recepcion_seguimientos.sql` y córrelo.
   Hazlo **antes** de desplegar el código de esta rama. Si dice que venció
   el tiempo del candado (`lock timeout`), hay una consulta larga
   sosteniendo una tabla: espera unos minutos y vuelve a correrla.

4. Pega y corre `supabase/ci/verify-schema.sql`. Si falta algo de la 056, el
   error dice qué.

**Nunca uses `supabase db push`.** `.env.local` apunta a la base de
producción y no hay staging: las migraciones se aplican a mano, una por una,
en el SQL Editor (`docs/agenda-despliegue-fase1.md`).

## 15. Las 8 plantillas nuevas en Meta

Meta solo deja escribirle a alguien que no ha escrito en las últimas 24
horas con una **plantilla aprobada**. Dentro de esas 24 horas el CRM manda
texto libre y no usa plantillas. Estas 8 sirven para avisar de una cita que
la recepción creó, movió o canceló, para los mensajes de después de la
visita y para mandar el enlace de agendar tras una llamada.

Se crean en WhatsApp Manager de la cuenta de WhatsApp Business (WABA) de la
clínica, como la plantilla de la sección 6: **Plantillas → Crear**. Reglas
para las 8:

- **Categoría Utilidad**, salvo que se diga otra cosa. Meta puede cambiarla
  a Marketing al revisarla (más probable en la calificación, 15.8). Si lo
  hace, acéptala: el mensaje funciona igual, pero se cobra más.
- **Idioma Español, `es`.** El nombre y el idioma tienen que coincidir
  letra por letra con los del código.
- **Cuerpo exactamente como está aquí.** Sale de
  `src/verticals/agenda/notify-texts.ts` y de `src/modules/clinica/texts.ts`.
  Las variables `{{1}}`, `{{2}}`... se llenan en el orden de cada tabla y
  aparecen en el texto en orden numérico (Meta no guarda una plantilla que
  nombre `{{2}}` antes que `{{1}}`). Meta pide un **valor de ejemplo** por
  variable: usa los de la columna "Ejemplo".
- **Nunca el procedimiento.** Ninguna plantilla de clínica lo nombra: el
  teléfono puede ser compartido y el texto pasa por Meta.
- **Botones:** solo de **Respuesta rápida**, con el texto exacto. Meta no
  pide el payload (la señal interna del botón) al crear la plantilla: el
  código lo manda al enviarla. Aquí se anota por si hay que revisarlo con la
  consulta de la sección 6.
- **No edites una plantilla aprobada.** Una edición en revisión puede bloquear
  los envíos mientras Meta la revisa. Si hay que cambiar un texto, se crea una
  plantilla nueva con otro nombre y se cambia el código.
- **Tienen que estar aprobadas antes de desplegar** (las de los seguimientos,
  antes de prender el interruptor de 16.5). Si falta una, el panel dice "La
  cita quedó guardada, pero no se pudo avisar por WhatsApp" y, en los
  seguimientos de una cuenta que ya los tiene prendidos, el envío se reintenta
  y a los 3 intentos queda como fallido.

| Plantilla | Para quién | Cuándo sale | Botones |
| --- | --- | --- | --- |
| `cita_agendada` | Cuentas con agenda que no son clínica | La recepción crea o mueve una cita | Ninguno |
| `cita_cancelada` | Igual | La recepción cancela, o el paciente cancela por llamada | Agendar otra |
| `cita_agendada_clinica` | Clínicas | La recepción crea o mueve una cita | Ninguno |
| `cita_cancelada_clinica` | Clínicas | La recepción cancela, o el paciente cancela por llamada | Agendar otra |
| `agendar_por_llamada` | Toda cuenta con agenda | Alguien marca 1 en la llamada entrante | Agendar |
| `cuidados_cita_clinica` | Clínicas | Después de una cita atendida | Ver recomendaciones |
| `como_sigues_clinica` | Clínicas | Al día siguiente de la cita, 10:00 | Bien, Tengo molestias, Necesito ayuda |
| `calificacion_visita_clinica` | Clínicas | A los dos días de la cita, 10:00 | Bien, Regular, Mal |

Si el paciente escribió en las últimas 24 horas, ninguna sale como plantilla:
sale texto libre (un mensaje de servicio, sin costo mientras no pases de los
1.000 mensajes de servicio al mes por número).

### 15.1 `cita_agendada`

Cuerpo:

```
¡Hola! 👋 Te confirmamos tu cita en {{1}}:

📌 {{2}}
👤 {{3}}
📅 {{4}}
🕐 {{5}}

¡Te esperamos! 🙌
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre del negocio | Clínica Ejemplo |
| `{{2}}` | La atención o servicio | Limpieza |
| `{{3}}` | Quién atiende; «Cualquiera» si la cita no tiene a nadie | Laura |
| `{{4}}` | Fecha | martes 10 de noviembre de 2026 |
| `{{5}}` | Hora | 3:30 p. m. |

Botones: ninguno. El cuerpo dice «cita» para todos los negocios: Meta no
admite palabras que cambien por cuenta.

### 15.2 `cita_cancelada`

Cuerpo:

```
Hola 👋 Cancelamos tu cita en {{1}} del {{2}} a las {{3}}.

Si quieres volver a agendar, toca el botón.
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre del negocio | Clínica Ejemplo |
| `{{2}}` | Fecha | martes 10 de noviembre de 2026 |
| `{{3}}` | Hora | 3:30 p. m. |

Botón de respuesta rápida: **Agendar otra**. Payload que manda el código:
`book:again`. Al tocarlo, el bot abre el flujo de reservas.

### 15.3 `cita_agendada_clinica`

Cuerpo:

```
¡Hola! 👋 Te confirmamos que {{1}} tiene cita en {{2}}, sede {{3}}:

👤 {{4}}
📅 {{5}}
🕐 {{6}}

¡Te esperamos! 🙌
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Paciente | Camila |
| `{{2}}` | Nombre de la clínica | Clínica Ejemplo |
| `{{3}}` | Sede, **sin** la palabra «sede» | Principal |
| `{{4}}` | Doctor; «el equipo de la clínica» si no hay | la doctora Laura |
| `{{5}}` | Fecha | martes 10 de noviembre de 2026 |
| `{{6}}` | Hora | 3:30 p. m. |

Botones: ninguno. No agregues el procedimiento.

### 15.4 `cita_cancelada_clinica`

Cuerpo:

```
Hola 👋 Cancelamos lo agendado para {{1}} en {{2}} el {{3}} a las {{4}}.

Si quieres volver a agendar, toca el botón.
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Paciente | Camila |
| `{{2}}` | Nombre de la clínica | Clínica Ejemplo |
| `{{3}}` | Fecha | martes 10 de noviembre de 2026 |
| `{{4}}` | Hora | 3:30 p. m. |

Botón de respuesta rápida: **Agendar otra**. Payload: `book:again`.

### 15.5 `agendar_por_llamada`

Cuerpo:

```
¡Hola! 👋 Gracias por llamar a {{1}}. Para agendar tu cita en un minuto, toca el botón.
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre del negocio | Clínica Ejemplo |

Botón de respuesta rápida: **Agendar**. Payload: `book:again`. Sale cuando
alguien marca 1 en la llamada entrante y no ha escrito en las últimas 24
horas. Si escribió, recibe un texto con el mismo botón.

### 15.6 `cuidados_cita_clinica`

Cuerpo:

```
¡Hola! 👋 Gracias por venir a {{1}}. Tenemos unas recomendaciones de cuidado para {{2}} después de su visita. Toca el botón para verlas.
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre de la clínica | Clínica Ejemplo |
| `{{2}}` | Paciente | Camila |

Botón de respuesta rápida: **Ver recomendaciones**. Payload:
`fu:cuidados:<id del seguimiento>`. La plantilla **no lleva las
instrucciones**: solo invita a verlas. Al tocar el botón, el bot manda el
texto de cuidados de esa atención (sección 16.2).

### 15.7 `como_sigues_clinica`

Cuerpo:

```
¡Hola! 👋 Te escribimos de {{1}}. ¿Cómo sigue {{2}} después de su visita?
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre de la clínica | Clínica Ejemplo |
| `{{2}}` | Paciente | Camila |

Tres botones de respuesta rápida, en este orden:

| Texto del botón | Payload |
| --- | --- |
| Bien | `fu:bien:<id>` |
| Tengo molestias | `fu:molestias:<id>` |
| Necesito ayuda | `fu:ayuda:<id>` |

### 15.8 `calificacion_visita_clinica`

Categoría Utilidad, pero **Meta puede pasarla a Marketing**.

Cuerpo:

```
¡Hola! 👋 En {{1}} queremos saber cómo le fue a {{2}} en su visita. ¿Cómo la calificas?
```

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `{{1}}` | Nombre de la clínica | Clínica Ejemplo |
| `{{2}}` | Paciente | Camila |

Tres botones de respuesta rápida, en este orden:

| Texto del botón | Payload |
| --- | --- |
| Bien | `rt:bien:<id>` |
| Regular | `rt:regular:<id>` |
| Mal | `rt:mal:<id>` |

**Sobre el orden de las variables en 15.6, 15.7 y 15.8:** Meta exige que
`{{1}}`, `{{2}}`... aparezcan en orden numérico dentro del texto. En estas tres
la clínica se nombra antes que el paciente, así que la clínica es `{{1}}` y el
paciente `{{2}}` (al revés que en 15.3 y 15.4, donde el paciente va primero).
El código manda los valores en ese orden: negocio y luego paciente
(`buildFollowupTemplateParams`, en `src/modules/clinica/followups.ts`). Si algún
día se cambia el orden de las frases de `src/modules/clinica/texts.ts`, hay que
cambiar también el de los valores, y crear una plantilla nueva con otro nombre
(una aprobada no se edita).

## 16. Ajustes de la clínica por SQL

Se hacen en el SQL Editor, como los de la sección 5. Reemplaza
`<uuid-de-la-cuenta>` por el id de la cuenta.

### 16.1 Cupo de sillones

Si la clínica tiene `n` sillones, el calendario y el bot no ofrecen ni
aceptan una hora en la que las citas activas ya llenen los `n`. Cuenta las
citas de toda la cuenta. Sin este dato, no hay límite.

```sql
update public.clinic_locations
set chair_count = 3
where account_id = '<uuid-de-la-cuenta>';
```

Dos reservas al mismo instante pueden pasarse en una: el calendario lo
muestra.

### 16.2 Cuidados después de la cita

El mensaje de cuidados solo sale si la atención tiene texto. Hasta 900
caracteres. Solo texto que apruebe el director de la clínica: ni diagnósticos
ni medicamentos.

```sql
update public.booking_services
set aftercare_instructions = '<cuidados aprobados por el director>'
where account_id = '<uuid-de-la-cuenta>' and name = '<atención>';
```

Una atención sin texto no genera mensaje de cuidados. Con la ventana
abierta, el texto sale tal cual. Con la ventana cerrada sale la plantilla
`cuidados_cita_clinica` y el texto llega cuando el paciente toca **Ver
recomendaciones**.

### 16.3 Enlace de reseñas de Google

Después de calificar, el paciente recibe un agradecimiento. Si la sede tiene
un enlace de reseñas, el mensaje lo incluye. El enlace sale del perfil de la
clínica en Google (Perfil de Empresa → pedir reseñas → copiar el enlace).

```sql
update public.clinic_locations
set google_review_url = 'https://g.page/r/<el-enlace-de-la-clinica>/review'
where account_id = '<uuid-de-la-cuenta>';
```

Hasta 500 caracteres. Sin enlace, el agradecimiento sale sin él.

### 16.4 Permiso declarado en recepción

Solo si la clínica dice que pide el permiso de datos en recepción y el
abogado lo aprobó (sección 23):

```sql
update public.clinic_settings
set reception_consent_declared_at = now()
where account_id = '<uuid-de-la-cuenta>';
```

Con eso, cuando la recepción crea un paciente nuevo desde el calendario, el
CRM guarda su autorización con origen `recepcion` y el texto vigente. Sin
eso, el paciente queda sin autorización y el bot se la pide en su primer
mensaje. Para quitarlo, pon `reception_consent_declared_at = null`: solo
afecta a los pacientes nuevos; lo ya guardado se queda.

### 16.5 Prender los seguimientos de una cuenta

Los cuidados, el «¿Cómo sigues?» y la calificación **vienen apagados** en
todas las cuentas (`clinic_settings.followups_enabled`, que la 056 crea en
`false`). Mientras estén apagados el cron no siembra ni envía nada de eso. Se
prenden a mano, **solo después de que Meta apruebe las tres plantillas**
(15.6, 15.7 y 15.8) y con el OK de la clínica:

```sql
update public.clinic_settings
set followups_enabled = true
where account_id = '<uuid-de-la-cuenta>';
```

Tiene que decir `UPDATE 1`. Si dice `UPDATE 0`, la cuenta no tiene la
configuración de clínica: vuelve a las secciones 4 y 5.

Qué esperar al prenderlos:

- En la siguiente corrida del cron (hasta 10 minutos) entran **las citas
  atendidas en los últimos 3 días**. Lo que ya venció de ellas sale de una
  vez, hasta 50 mensajes por corrida. Si no quieres que salgan mensajes de
  visitas de hace dos días, prende el interruptor cuando no haya citas
  atendidas recientes sin mensaje, o acepta que salgan.
- De ahí en adelante, cada cita marcada como atendida genera sus mensajes.

Para apagarlos: `set followups_enabled = false`. Deja de salir todo lo que
siga pendiente; si se vuelve a prender, sale lo que ya haya vencido.

El **aviso del cierre del día** («Cierre del día pendiente», después de las
20:00) no depende de este interruptor: solo avisa al dueño dentro de la app y
no le escribe a ningún paciente, así que corre en toda cuenta con `clinica`.

## 17. Google Calendar paso a paso

**Qué hace.** Copia cada cita a un calendario de Google, en un solo
sentido: de Shift a Google. Cada cita nueva, movida, atendida o cancelada se
actualiza sola en unos 5 minutos; una cita cancelada borra su evento. El
evento lleva:

- **Título:** «atención · nombre» (en una clínica, el nombre es el del
  paciente), por ejemplo «Limpieza · Camila». Una cita atendida empieza con
  «✓ » y una en la que no vino, con «No vino · ».
- **Descripción:** el profesional y «Creada desde Shift».
- **Nunca** teléfonos ni notas.

Quien lo conecta es el dueño o un administrador de la clínica. Shift
prepara Google Cloud una sola vez para toda la plataforma.

### 17.1 En Google Cloud (Shift, una sola vez)

Los menús de Google cambian de nombre con el tiempo. Si no ves uno, busca el
más parecido.

1. Entra a `console.cloud.google.com` con la cuenta de Google de Shift (una
   cuenta que no se vaya a perder) y crea un **proyecto nuevo**, por ejemplo
   «Shift CRM».
2. **APIs y servicios → Biblioteca:** busca **Google Calendar API** y
   púlsale **Habilitar**.
3. **Google Auth Platform** (la pantalla de consentimiento de OAuth; OAuth es
   el «Iniciar sesión con Google»). Si pide «Comenzar»: nombre de la
   aplicación (Shift), correo de asistencia, público **Externo** y correo de
   contacto.
4. **Acceso a los datos (Data Access) → Agregar o quitar permisos.** Los
   permisos que pide el CRM son estos:

   | Permiso | Para qué |
   | --- | --- |
   | `openid` y `email` | Saber con qué cuenta de Google se conectó |
   | `https://www.googleapis.com/auth/calendar.events` | Crear, cambiar y borrar los eventos de las citas |
   | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Ver la lista de calendarios para elegir en cuál copiar |

5. **Público (Audience) → Publicar la app → «En producción».** Este paso es
   obligatorio, **aunque la app no esté verificada**:
   - En modo **Prueba**, Google vence el permiso de cada conexión a los 7
     días y las citas dejan de copiarse cada semana.
   - En **Producción** sin verificar, Google muestra un aviso cuando alguien
     conecta («Google no ha verificado esta aplicación»). Se sigue con
     **Configuración avanzada → Ir a Shift (no seguro)**. Admite hasta **100
     usuarios**.
6. **Clientes → Crear cliente → Aplicación web.** En **URI de
   redireccionamiento autorizados** pon exactamente:

   ```
   https://<tu-dominio>/api/integrations/google-calendar/callback
   ```

   Es `NEXT_PUBLIC_SITE_URL` (sin barra final) más
   `/api/integrations/google-calendar/callback`. Tiene que coincidir letra
   por letra con el dominio del CRM, o Google rechaza la conexión.
7. Copia el **ID de cliente** y el **secreto** a las variables
   `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` (sección 20). El secreto solo
   se ve al crearlo: guárdalo en Bitwarden.

**Verificar la app (más adelante).** Para quitar el aviso y pasar de 100
usuarios, Google pide verificación: página de política de privacidad,
dominio verificado y un video que muestre para qué se usa el permiso de
calendario. Se solicita en el **Centro de verificación** del mismo proyecto
y es un trámite aparte. Hoy no es necesario para empezar.

### 17.2 En la clínica (dueño o administrador)

1. `/agenda/configuracion` → tarjeta **Google Calendar** → **Conectar Google
   Calendar**.
2. Elige la cuenta de Google, pasa el aviso de «no verificada» y **deja todas
   las casillas de permisos marcadas**. Si desmarca alguna, la conexión
   falla con un aviso de permisos.
3. Vuelve a la configuración con «Google Calendar quedó conectado». Elige el
   **calendario general**. Si quieres, cada profesional puede tener el suyo:
   se elige al editarlo.
4. En unos minutos las citas aparecen en el calendario.

**Si deja de copiar.** La tarjeta muestra el **último problema**. Si dice
«Google dejó de dar permiso», toca **Reconectar**. Al **desconectar**, los
eventos ya creados se quedan en Google. Si la tarjeta dice que falta un paso
de Shift, faltan `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` o
`NEXT_PUBLIC_SITE_URL` en el servidor.

## 18. Telnyx paso a paso

**Qué es.** Telnyx es la empresa que pone el número de teléfono y hace y
recibe las llamadas. Se eligió por costo. El robot **no es una IA que
conversa**: es un menú fijo con voz sintética («marca 1 para...»). Shift
tiene **una** cuenta de Telnyx para toda la plataforma y compra **un número
por clínica**. Los menús de Telnyx cambian de nombre; busca el más parecido.

### 18.1 Cuenta y saldo

1. Crea la cuenta en `portal.telnyx.com` y verifica el correo y el
   teléfono. Regístrala a nombre de una persona natural: Shift no es una
   empresa registrada, así que no pongas NIT ni razón social. Si Telnyx
   exige documentos de empresa, detente y consúltalo con el contador o el
   abogado.
2. Carga **saldo** en la sección de pagos (Billing). Cada llamada y cada
   número se descuentan de ahí. Si el saldo se acaba, el robot deja de
   llamar y de contestar. Los costos están en la sección 22.

### 18.2 Número local de Colombia

1. **Numbers → Buy Numbers.** País **Colombia**, tipo **Local**, y la ciudad
   o indicativo que quiera la clínica.
2. Al comprarlo, Telnyx pide **nombre, apellido y dirección** de quien lo
   registra. Si pide más datos o documentos, súbelos: el número no funciona
   hasta que Telnyx lo apruebe.
3. Anota el número en formato E.164, por ejemplo `+57XXXXXXXXXX`. Es el
   `inbound_number` de la clínica (sección 18.6).

### 18.3 Clave de API y clave pública

- **Auth → API Keys → crear clave.** Cópiala en ese momento: solo se ve una
  vez. Es `TELNYX_API_KEY`.
- **Keys & Credentials → Public Key.** Es un texto corto en base64 (32
  bytes). Es `TELNYX_PUBLIC_KEY`. Con ella el CRM verifica la firma de los
  avisos de Telnyx.

### 18.4 Perfil de voz saliente

Para llamar, Telnyx pide un **perfil de voz saliente** (Outbound Voice
Profile). Crea uno, deja permitido **Colombia** como destino y asígnalo a la
aplicación TeXML del paso siguiente. Si no ves ese campo, el robot no podrá
llamar.

### 18.5 La aplicación TeXML

1. Primero genera el secreto que firma las direcciones de voz
   (`VOICE_WEBHOOK_SECRET`) y guárdalo en Bitwarden:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Genera el parámetro `t` de la dirección de las llamadas entrantes. Es un
   código que firma la palabra `inbound` con ese secreto, igual que lo hace
   `voiceToken("inbound")` en `src/lib/voice/tokens.ts`. Un comando de una
   línea (funciona en PowerShell y en bash):

   ```bash
   node -e "console.log(require('crypto').createHmac('sha256', process.argv[1]).update('inbound').digest('base64url'))" "<tu VOICE_WEBHOOK_SECRET>"
   ```

   Imprime un texto de unos 43 caracteres. Ese es `<token>`.
3. Genera el `t` de la dirección de **estado** de las llamadas entrantes
   (donde Telnyx avisa que la llamada terminó). Este token es **otro**: no
   firma solo la palabra `inbound`, firma también los parámetros de la
   dirección (aquí `inbound=1`), como hace
   `voiceToken("inbound", { inbound: "1" })`. Así nadie puede reusar el
   token de la URL de voz en la de estado, ni al revés. Otro comando de una
   línea (PowerShell y bash):

   ```bash
   node -e "console.log(require('crypto').createHmac('sha256', process.argv[1]).update(JSON.stringify(['inbound',[['inbound','1']]])).digest('base64url'))" "<tu VOICE_WEBHOOK_SECRET>"
   ```

   También imprime unos 43 caracteres, pero distintos a los del paso 2. Ese
   es `<token-de-estado>`.
4. **Voice → Programmable Voice → TeXML Applications → crear.**
   - **Nombre:** por ejemplo «Shift robot de voz».
   - **Método de voz (Voice Method): `POST`.**
   - **URL de voz (Voice URL):**

     ```
     https://<tu-dominio>/api/voice/telnyx/inbound?t=<token>
     ```

     Es `NEXT_PUBLIC_SITE_URL` más esa ruta y el token del paso 2.
   - **URL de estado (Status Callback URL), método `POST`:**

     ```
     https://<tu-dominio>/api/voice/telnyx/status?inbound=1&t=<token-de-estado>
     ```

     Es `NEXT_PUBLIC_SITE_URL` más esa ruta, **`inbound=1` tal cual, antes
     del `t`**, y el token del paso 3. Sin esta URL una llamada entrante
     nunca se cierra en el CRM: queda sin hora de fin ni estado final. Si
     cambias `inbound=1` o cualquier parte de la query, el token deja de
     valer (403).
   - **Perfil de voz saliente:** el de la sección 18.4.
   - Deja vacía cualquier otra URL: las llamadas salientes llevan sus
     propias direcciones (voz, estado y resultado del `<Dial>`).
5. Guarda y copia dos datos de esa aplicación: el **ID de la aplicación**
   (`TELNYX_TEXML_APP_ID`) y el **Account SID**, el identificador de la
   cuenta que usa la API de TeXML (`TELNYX_ACCOUNT_SID`). Si no ves el
   Account SID en la aplicación, búscalo en los datos de la cuenta.
6. **Asigna el número a la aplicación:** Numbers → My Numbers → el número →
   conexión de voz → la aplicación TeXML. Sin esto, las llamadas entrantes
   no llegan al robot.

**Si cambias `VOICE_WEBHOOK_SECRET`**, los dos `t` (el de la URL de voz y el
de la URL de estado) dejan de valer: genéralos de nuevo (pasos 2 y 3) y
actualiza las dos URL en Telnyx. Con un `t` inválido, la app responde 403: en
la URL de voz la llamada entrante no se atiende, y en la de estado no se
cierra.

**Pendiente de comprobar en la primera llamada real.** Cuando la llamada pasa
a un asesor (tecla 0 de una entrante, o la tecla 3 de una saliente), la app
ata el aviso del resultado del `<Dial>` a la llamada por su `CallSid`. Telnyx
no promete en su documentación que mande el `CallSid` en ese aviso. Para
verlo: marca 0 dentro del horario y **deja sin contestar** los teléfonos de
los asesores. Debe oírse «En este momento no hay asesores disponibles...» y
debe salir en la app el aviso «Llamada: pidió un asesor y nadie contestó». Si
la llamada solo se corta en silencio, sin aviso, Telnyx no está mandando el
`CallSid` en ese paso (la app descarta a propósito un aviso cuyo `CallSid` no
cuadra) y hay que avisar a quien mantiene el código. Repite la prueba
contestando con un teléfono de asesor: la llamada en `booking_calls` debe
quedar en `advisor_connected`.

### 18.6 Los números de la cuenta (solo Shift)

Un administrador de la clínica **no puede** cambiar el número entrante, el
identificador de llamada, el tope mensual ni el proveedor: una regla de la
base (un trigger) lo rechaza. Los fija Shift en el SQL Editor:

```sql
insert into public.booking_call_settings (account_id, inbound_number, caller_id, monthly_limit)
values ('<uuid-de-la-cuenta>', '+57XXXXXXXXXX', null, 300)
on conflict (account_id) do update
set inbound_number = excluded.inbound_number,
    caller_id = excluded.caller_id,
    monthly_limit = excluded.monthly_limit;
```

- `inbound_number`: el número comprado, en E.164. Es único en toda la
  plataforma: el CRM encuentra la clínica por el número al que llaman. Si ya
  lo tiene otra cuenta, la base da un error de llave duplicada.
- `caller_id`: el número que verá el paciente cuando lo llame el robot. Con
  `null` se usa `inbound_number`. Ponle uno solo si es otro número de
  Telnyx.
- `monthly_limit`: tope de **llamadas salientes** al mes (300 por defecto).
  Las entrantes no tienen tope.

## 19. Prender las llamadas en una cuenta y probar la voz

### 19.1 Antes de prender

- La 056 está aplicada (sección 14).
- Las variables de Telnyx y `VOICE_WEBHOOK_SECRET` están puestas y el código
  desplegado (sección 20).
- El número está comprado, asignado a la aplicación TeXML y registrado en la
  cuenta (secciones 18.5 y 18.6).
- Hay saldo en Telnyx.

Mientras falte algo, la tarjeta **Llamadas** dice «Pendiente de Shift» y los
interruptores no se dejan prender.

### 19.2 En el panel

`/agenda/configuracion` → tarjeta **Llamadas** (administrador). Las llamadas
vienen **apagadas**:

- **Teléfonos de asesores** (hasta 3, en E.164): suenan todos a la vez
  cuando alguien marca 0 dentro del horario de atención.
- **Horario de atención** por día. Los festivos de Colombia cuentan como
  cerrado. Fuera del horario, quien marca 0 oye el horario y no pasa a un
  asesor.
- **Horario y dirección para quien llama:** el texto que lee el robot al
  marcar 3. Escríbelo como se dice en voz alta, sin abreviaturas.
- **Llamadas de confirmación (salientes):** llaman a quien no confirmó su
  cita después del recordatorio de 24 horas. Por defecto, de 8:00 a 19:00
  hora de Bogotá, de lunes a sábado, **nunca domingo ni festivo**, hasta 2
  intentos con 90 minutos entre uno y otro, y solo si faltan más de 2 horas
  para la cita. Se ajusta en la misma tarjeta.
- **Atención de llamadas entrantes:** contesta las 24 horas con un menú.
  Marcar 1 manda un WhatsApp para agendar; 2, confirmar o cancelar la
  próxima cita; 3, oír el horario y la dirección; 0, hablar con un asesor
  (solo en horario). En una clínica, 9 es para una urgencia y va primero.
- Prende **una cosa a la vez**: primero la prueba (19.3), luego las entrantes
  y al final las salientes.

Para que el robot no llame a una persona, ponle en el CRM la etiqueta
`no-llamar` (crea la etiqueta si no existe) o `baja-envios`. En una clínica,
tampoco llama a quien revocó la autorización de datos.

### 19.3 Probar la llamada

1. En la tarjeta, **Probar llamada**: escribe tu celular en E.164. El robot
   te llama, dice «Esta es una llamada de prueba. No se va a cambiar ninguna
   cita.» y lee un menú de ejemplo. No toca ninguna cita. Es una llamada
   real y cuesta como cualquiera.
2. Para las entrantes, llama al número de la clínica desde otro celular y
   prueba cada tecla.

### 19.4 Revisar la voz con faster-whisper

Antes de prender una cuenta real, se revisa que la voz hable **español
nativo**. Regla de Shift: nunca español leído con acento inglés ni portugués.

1. Graba la llamada de prueba. Pon el celular en altavoz y graba con otro
   aparato, o usa la grabadora de llamadas del teléfono. Guarda el audio
   como `prueba.mp3`, `.wav` o `.m4a`.
2. Revísala **sin forzar el idioma** (si no tienes la herramienta,
   `pip install faster-whisper`):

   ```python
   from faster_whisper import WhisperModel

   modelo = WhisperModel("small", device="cpu", compute_type="int8")
   segmentos, info = modelo.transcribe("prueba.mp3")  # sin language=...
   print(info.language, round(info.language_probability, 2))
   print(" ".join(s.text.strip() for s in segmentos))
   ```

3. **Pasa** si el idioma es `es` (con probabilidad de 0,97 o más, el mismo
   umbral que usa Shift en sus voces en off) y el texto coincide con el
   guion que dijo el robot (está en `src/verticals/agenda/voice/scripts.ts`).
   **No pasa** si sale `en` o `pt`, o si el texto sale distinto. Una llamada
   suena con peor calidad que un audio normal: si sale `es` pero con menos
   probabilidad por el ruido, graba de nuevo en un lugar silencioso.
4. Si no pasa, cambia la voz y repite. La voz de toda la plataforma es
   `VOICE_DEFAULT_VOICE` (por defecto `Polly.Mia-Neural`, español de
   México). Una cuenta puede tener la suya:

   ```sql
   update public.booking_call_settings
   set voice = 'Polly.Mia-Neural'
   where account_id = '<uuid-de-la-cuenta>';
   ```

   Se puede probar `Azure.es-CO-SalomeNeural`, pero Telnyx no la documenta.

Whisper no juzga el acento ni la entonación. La decisión final es del oído:
que la escuche alguien que hable español nativo.

### 19.5 Apagar de urgencia

En la tarjeta, apaga los dos interruptores. Si hace falta hacerlo ya:

```sql
update public.booking_call_settings
set outbound_enabled = false, inbound_enabled = false
where account_id = '<uuid-de-la-cuenta>';
```

## 20. Variables de entorno y crons

### 20.1 Variables

Están comentadas en `.env.local.example`. Los secretos, de Bitwarden. Después
de ponerlas hay que **volver a desplegar** (en Vercel, un redeploy; en el
VPS, `deploy/vps/deploy.sh`).

| Variable | Qué es | De dónde sale |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Dirección pública del CRM, sin barra final. Ya existe en toda instalación (`.env.local.example`, `docs/despliegue-vps.md`, `docs/despliegue-vercel.md`). Google (URL de retorno) y la voz (URLs firmadas) leen **esta** y no hay que crear otra. Si por algún motivo falta, ambos aceptan `NEXT_PUBLIC_APP_URL` como respaldo | El dominio del CRM |
| `GOOGLE_CLIENT_ID` | ID del cliente OAuth | Google Cloud (17.1, paso 7) |
| `GOOGLE_CLIENT_SECRET` | Secreto del cliente OAuth | Google Cloud (17.1, paso 7) |
| `TELNYX_API_KEY` | Clave de la API de Telnyx | Telnyx, Auth → API Keys (18.3) |
| `TELNYX_ACCOUNT_SID` | Identificador de la cuenta para TeXML | Telnyx (18.5, paso 5) |
| `TELNYX_TEXML_APP_ID` | ID de la aplicación TeXML | Telnyx (18.5, paso 5) |
| `TELNYX_PUBLIC_KEY` | Clave pública para verificar firmas | Telnyx, Keys & Credentials (18.3) |
| `VOICE_WEBHOOK_SECRET` | Secreto que firma las direcciones de voz | Lo genera Shift (18.5, paso 1) |
| `VOICE_DEFAULT_VOICE` | Voz por defecto del robot. Opcional | Sin definir: `Polly.Mia-Neural` |

Sin las de Google, la tarjeta **Google Calendar** avisa que falta un paso de
Shift. Sin las de Telnyx, la tarjeta **Llamadas** deja guardar pero no
prender, y el cron de llamadas no hace nada.

### 20.2 Crons nuevos

Los tres usan el mismo secreto que el de recordatorios
(`AUTOMATION_CRON_SECRET`, en `x-cron-secret` o como Bearer) y son `GET`.

| Ruta | Cada | Qué hace |
| --- | --- | --- |
| `/api/verticals/agenda/calendar-sync/run` | 5 minutos | Copia las citas pendientes a Google Calendar |
| `/api/verticals/agenda/calls/run` | 10 minutos | Hace las llamadas de confirmación que toquen |
| `/api/verticals/clinica/followups/run` | 10 minutos | Cuidados, «¿Cómo sigues?» y calificación (solo cuentas con el interruptor de 16.5 prendido) y aviso del cierre del día (todas) |

- **Vercel:** ya están en `vercel.json`. Después de desplegar, míralos en
  Project → Settings → Cron Jobs. Necesitan `CRON_SECRET` con el mismo valor
  que `AUTOMATION_CRON_SECRET` (`docs/despliegue-vercel.md`). Un cron cada 5
  minutos requiere el plan Pro.
- **VPS:** ya están en `deploy/vps/crontab.example`. Vuelve a instalarlo con
  el último comando de la sección 6 de `docs/despliegue-vps.md`. A los 10
  minutos, `journalctl -t shift-crm-cron --since '15 min ago'` muestra
  líneas `ok` de las seis rutas.

Probar a mano, con el secreto del entorno:

```bash
curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  https://<tu-dominio>/api/verticals/agenda/calendar-sync/run
```

Cambia la ruta por `/api/verticals/agenda/calls/run` o
`/api/verticals/clinica/followups/run`. Cómo leer la respuesta:

- **calendar-sync:** `accounts` (conexiones activas), `synced`, `failed`,
  `revoked`.
- **calls:** si faltan variables, `credentialsMissing` dice cuáles y no
  llama a nadie. Si no, `called`, `failed` y `skipped` por motivo.
- **followups:** `accounts` (cuentas con `clinica`), `followupAccounts` (las
  que tienen el interruptor de 16.5 prendido; si es 0 no se siembra ni se
  envía nada), `seeded` (seguimientos creados), `sent`, `skipped`, `failed` y
  `dayCloses`.

Sin secreto en el servidor responden 503; con un secreto incorrecto, 401.

## 21. Probar las Fases 2 y 3

Con una cuenta de prueba, un celular externo y la sección 11 a mano. Los
datos de prueba se marcan y se limpian al terminar.

1. **056.** Corrió `verify-schema.sql` sin errores (sección 14).
2. **Crear, mover y cancelar con aviso.** El celular de prueba no debe haber
   escrito en las últimas 24 horas (sección 11, paso 9, explica cómo
   envejecer los mensajes). En `/agenda/calendario`, crea una cita con
   «avisar» prendido: llega `cita_agendada` (o `_clinica`). Muévela: llega
   otra con la nueva hora. Cancélala: llega `cita_cancelada` con el botón
   **Agendar otra**. Tócalo: el bot abre el flujo de reservas. Revisa el
   payload con la consulta de la sección 6: `interactive_reply_id` debe ser
   `book:again`.
3. **Sillones.** Con `chair_count` en 1, intenta una segunda cita a la misma
   hora: dice «No quedan sillones libres a esa hora».
4. **Google.** Conecta (17.2), crea una cita y en unos 5 minutos aparece.
   Cancélala: el evento se borra.
5. **Para llamar.** Una cita en las próximas 48 horas, con el recordatorio de
   24 horas enviado hace más de 3 horas y sin confirmar, aparece en
   `/agenda` → **Para llamar**.
6. **Llamadas.** Haz la prueba de la sección 19.3 y la revisión de voz de la
   19.4. Después, con una cita de prueba que cumpla las condiciones de la
   19.2, corre el cron de llamadas (sección 20.2) y contesta.
7. **Después de la cita.** Prende los seguimientos de la cuenta de prueba
   (16.5; con ellos apagados el cron no hace nada y `followupAccounts` da
   0). Marca una cita de prueba como atendida. Para no esperar al día
   siguiente, adelanta los seguimientos y corre el cron:

   ```sql
   update public.clinic_followups
   set due_at = now()
   where appointment_id = '<uuid-de-la-cita>' and status = 'pending';
   ```

   Con el celular dentro de las 24 horas llegan los mensajes libres; con la
   ventana cerrada, las plantillas. Toca **Bien**, **Tengo molestias**
   (avisa al equipo, pasa el chat a una persona y repite los signos de
   alarma), **Regular** o **Mal** (avisa al dueño para que alguien llame) y
   revisa el agradecimiento con el enlace de Google. Devuelve el chat con
   **Reanudar bot**.
8. **Cierre del día.** Después de las 20:00, una cita de hoy ya empezada que
   siga pendiente o confirmada genera el aviso «Cierre del día pendiente» y
   aparece en `/agenda` → **Sin marcar**.

## 22. Costos estimados (por confirmar)

Son los precios publicados por los proveedores cuando se hizo el diseño.
**Hay que confirmarlos en las cuentas reales** antes de prometerle un precio
a una clínica. Están en dólares.

| | Telnyx | Twilio (referencia) |
| --- | --- | --- |
| Número local de Colombia | USD 13,50 al mes | USD 17,50 al mes |
| Llamada saliente a celular | USD 0,0125 por minuto, más 0,002 de TeXML | USD 0,0377 por minuto |
| Llamada entrante | Desde USD 0,065 por minuto, más 0,002 | USD 0,0945 por minuto |
| Voz neural (Polly) | USD 0,000024 por carácter | USD 0,000032 por carácter |

Con eso, a ojo:

- Una llamada de confirmación de 45 segundos: unos **USD 0,016**.
- Una llamada entrante de 1 minuto: unos **USD 0,07**.
- Una entrante de 3 minutos pasada a un asesor: entre **USD 0,24 y 0,34**.
  Falta confirmar si Telnyx cobra USD 0,10 por cada transferencia.
- Con el tope por defecto de 300 salientes al mes: unos **USD 4,80** de
  llamadas, más el número (USD 13,50).

Lo que más pesa son las **llamadas entrantes**: no tienen tope. Revisa el
saldo de Telnyx seguido.

Otros costos:

- **Plantillas de Meta:** las de utilidad se cobran. Revisa la tarifa vigente
  para Colombia, y si Meta pasa la calificación a Marketing, cuesta más.
- **Mensajes de servicio** (texto libre dentro de las 24 horas): los primeros
  1.000 al mes por número son gratis. Pasado eso, se cobran, y sin medio de
  pago Meta deja de entregar (sección 7).
- Las llamadas de WhatsApp (API de Meta) se descartaron por ahora: no pasan
  la llamada al celular de un asesor, el número necesita un límite de al
  menos 2.000 destinatarios y casi no ahorran.

## 23. Para el abogado (Fases 2 y 3)

Nada de esto lo decide Shift. Se revisa con un abogado antes de prender la
pieza en una clínica real.

- **Llamar al paciente con voz sintética.**
  - Si hace falta una autorización específica para llamarle, además de la de
    datos.
  - Los horarios. Según el diseño, la Ley 2300 de 2023 limita los horarios
    para cobranza y mercadeo, y aquí se aplica el mismo cuidado por
    prudencia: de 8:00 a 19:00, de lunes a sábado, nunca domingo ni festivo.
    Hay que confirmar si aplica a los recordatorios de cita y cuáles horas
    son las correctas.
  - Que la llamada se identifique como «asistente virtual», como hoy.
  - El robot no graba el audio. En `booking_calls` queda el número, la tecla
    marcada y el resultado. Confirmar si eso basta.
- **Google como encargado del tratamiento.** Cada cita se copia al calendario
  de Google de la clínica. El título lleva la atención y el nombre del
  paciente (por ejemplo «Limpieza · Camila»): las plantillas de Meta nunca
  nombran el procedimiento, pero Google sí lo recibe. Si el calendario se
  comparte, lo ven los demás. El permiso de Google para eventos, además,
  permite leerlos, aunque el CRM solo escribe. Mientras la app no esté
  verificada, Google muestra un aviso al conectar.
- **Telnyx y la voz.** El nombre del paciente, la fecha de la cita y los
  teléfonos pasan por Telnyx para convertirse en voz y en llamada. La voz
  `Polly` es de Amazon. Revisar los contratos y la transferencia de datos.
- **La autorización declarada en recepción.** Si la clínica dice que pide el
  permiso en recepción, Shift deja la fecha en
  `clinic_settings.reception_consent_declared_at` (sección 16.4). Desde
  entonces, un paciente que la recepción crea desde el calendario queda con
  una autorización guardada como `recepcion`, con el texto vigente, aunque
  no la haya aceptado por WhatsApp. Hay que decidir si eso sirve como
  constancia y qué debe firmar o declarar la clínica.

Shift no es una empresa registrada: los temas legales y de impuestos se
revisan con abogado y contador, no se afirman aquí.
