# Despliegue de la Fase 1 (agenda armable) — runbook

Pasos, en orden, para sacar a producción la agenda armable: la barbería
pasa a ser una agenda para cualquier negocio, con tipo de negocio,
palabras, piezas y preguntas extra. Incluye dos migraciones (**051** y
**052**) y un cambio manual en Meta.

> **Importante:** `.env.local` apunta a la base de **producción**.
> Cualquier prueba local que escriba datos escribe en producción. No hay
> staging. Nunca uses `supabase db push`: las migraciones se aplican a
> mano, una por una, en el SQL Editor.

## Resumen del orden

| # | Qué | Dónde | Quién |
| --- | --- | --- | --- |
| a | PR revisado y CI verde | GitHub | Equipo |
| b | Aplicar **051** (aditiva) | Supabase → SQL Editor | Usuario |
| c | Desplegar el código | Merge del PR a `main` → Vercel | Usuario |
| d | Volver a correr **051** (idempotente) | SQL Editor | Usuario |
| e | Aplicar **052** (cambia la clave del vertical) | SQL Editor | Usuario |
| f | Correr `supabase/ci/verify-schema.sql` | SQL Editor | Usuario |
| g | Probar con la cuenta smoke | `/agenda/configuracion` | Usuario |
| h | Mover los crons externos a la URL nueva | Pinger / host | Usuario |
| i | Plantilla de Meta (solo negocios nuevos que no son barbería) | WhatsApp Manager | Usuario |

El orden importa porque el código **viejo** solo entiende la clave
`barberia` y el código **nuevo** entiende `agenda` **y** `barberia`:
primero se agrega lo nuevo sin tocar nada (051), luego sube el código, y
solo al final se reescribe la clave (052).

## a) Antes de empezar

- [ ] El PR está revisado y el CI está **verde** (typecheck, lint,
      tests, build y el workflow «Migrations», que replica todas las
      migraciones desde cero en un Postgres limpio).
- [ ] Hay un backup reciente de la base (`docs/operacion-datos-y-secretos.md`).
- [ ] Tienes a mano el SQL Editor del proyecto de **producción** en
      Supabase.
- [ ] Hora tranquila: evita el horario en que el cron de recordatorios
      corre muy cargado. No es obligatorio, solo cómodo.

## b) Aplicar 051 antes del código

`supabase/migrations/051_agenda_armable.sql` es **aditiva**: agrega
columnas a `booking_settings` y `booking_appointments`, y crea la tabla
`booking_questions`. No borra ni cambia nada existente, así que es
**segura con el código viejo en producción** (el código viejo no lee las
columnas nuevas).

1. Supabase → **SQL Editor** → nueva consulta.
2. Pega esto, con el contenido de la 051 en medio:

   ```sql
   BEGIN;

   -- (aquí va todo el contenido de 051_agenda_armable.sql)

   COMMIT;
   ```

   La transacción es necesaria: la migración trae un
   `SET LOCAL lock_timeout = '5s'` que solo funciona dentro de una.
3. Ejecuta.

**Si sale un error de timeout (`lock timeout` / `canceling statement due
to lock timeout`):** una consulta larga está sosteniendo el candado de
una tabla. No pasó nada malo (la transacción se deshizo). Espera uno o
dos minutos y **reintenta**.

**Verificación rápida:**

```sql
select count(*) from booking_questions;                -- 0, sin error
select preset_key, labels from booking_settings limit 5; -- columnas nuevas
```

## c) Desplegar el código

Merge del PR a `main` (nunca push directo a `main`): Vercel construye y
despliega solo. Espera a que el deploy quede en **Ready** y revisa
`https://<dominio>/api/health` → `ok: true`.

Qué cambia en la práctica:

- `/barberia` y `/barberia/configuracion` redirigen a `/agenda` y
  `/agenda/configuracion`. La redirección es **temporal** (307, no
  permanente) a propósito: el navegador no la guarda para siempre, así
  que un rollback del código sigue siendo posible. Se pasará a
  permanente cuando ya no haga falta volver atrás.
- El código acepta cuentas con `vertical_key = 'barberia'` y `'agenda'`:
  **ninguna cuenta se rompe** aunque 052 todavía no esté aplicada.

## d) Volver a correr 051

Ejecuta **otra vez** el mismo bloque `BEGIN; … COMMIT;` de la 051. Es
idempotente (no duplica nada).

**Para qué:** entre la 051 (paso b) y la 052 (paso e) puede haberse
creado alguna barbería con la clave vieja desde el código viejo, sin
palabras ni punto de partida. La segunda corrida le rellena las palabras
(barbero / barberos) y el punto de partida `barberia`.

## e) Aplicar 052

`supabase/migrations/052_agenda_vertical_key.sql` hace un solo cambio:
`UPDATE accounts SET vertical_key = 'agenda' WHERE vertical_key = 'barberia'`.

1. **Antes**, guarda la lista de cuentas que se van a migrar (sirve para
   volver atrás):

   ```sql
   select id, name from accounts where vertical_key = 'barberia';
   ```

   Copia el resultado (por ejemplo, en una nota) antes de seguir.
2. Aplícala dentro de una transacción:

   ```sql
   BEGIN;

   -- (aquí va todo el contenido de 052_agenda_vertical_key.sql)

   COMMIT;
   ```

3. Si hay `lock timeout`, reintenta más tarde (igual que en el paso b).

Es idempotente: si la repites, no hay cuentas `barberia` y no hace nada.
Corre como `postgres` en el SQL Editor, por eso no la frena el trigger de
la migración 050 que protege `vertical_key` de los usuarios de la app.

## f) Verificar el esquema

Corre `supabase/ci/verify-schema.sql` completo contra producción
(SQL Editor). Debe terminar sin errores.

La verificación «no queda ninguna cuenta con `vertical_key = 'barberia'`»
**solo tiene sentido después de la 052.** Si la corres antes del paso e,
va a fallar a propósito.

## g) Probar con la cuenta smoke

La cuenta de pruebas es la de la barbería de demostración (ver las notas
del proyecto). Recuerda que **producción es la base real**.

1. Entra a `/agenda/configuracion` y revisa las pestañas nuevas:
   **Tipo de negocio**, **Piezas** y **Preguntas**.
2. Verifica que el punto de partida actual dice «Barbería» y las
   palabras son barbero / barberos.
3. Haz una reserva completa por WhatsApp con **datos de prueba
   marcados** (nombre «PRUEBA …»). Si agregas una pregunta extra para la
   prueba, bórrala (desactívala) después.
4. Confirma que la cita aparece en `/agenda` con sus respuestas.
5. **Limpia** lo que creaste: cancela o borra la cita de prueba, el
   contacto y cualquier pregunta extra de prueba. No dejes datos
   inventados mezclados con los reales.

## h) Crons externos

La URL vieja `/api/verticals/barberia/reminders/run` **sigue
funcionando como alias** de la nueva, así que nada se rompe si no la
cambias hoy. Cuando puedas:

1. Cambia el pinger externo (cron-job.org u otro) o el cron del host a
   `https://<dominio>/api/verticals/agenda/reminders/run`, con el mismo
   header `x-cron-secret`.
2. El cron nativo de Vercel (`vercel.json`) ya apunta a la URL nueva.
3. Cuando ya nadie use la URL vieja, borra el alias
   (`src/app/api/verticals/barberia/reminders/run/route.ts`) en un PR
   aparte.

## i) Plantilla de Meta (paso manual del usuario)

**No edites la plantilla `recordatorio_cita` que ya está aprobada.** Una
edición en revisión puede bloquear los envíos por plantilla mientras
Meta la revisa.

- Las **WABA de barberías que ya existen** conservan su plantilla
  aprobada tal cual. El 💈 está bien para una barbería. No hay nada que
  hacer en este paso para ellas.
- Un **negocio nuevo que no es barbería** crea su propia plantilla
  `recordatorio_cita` al hacer el onboarding, con el cuerpo genérico
  (📌, mismas 5 variables y mismos 3 botones). El texto exacto y los
  pasos están en `docs/agenda-recordatorios.md` → «Plantilla de Meta».

Este paso no bloquea el despliegue.

## j) Cómo volver atrás si algo falla

**La 051 no se revierte.** Es aditiva: solo agrega columnas y una tabla
que el código viejo ignora. Dejarla puesta no hace daño.

Según dónde estés:

- **Falló algo antes de la 052 (pasos b a d):** basta con volver a
  desplegar el commit anterior (Vercel → Deployments → **Instant
  Rollback**). El código viejo sigue funcionando con la base tal como
  está, porque ninguna cuenta cambió de clave.
- **Falló algo después de la 052 y el problema es del código nuevo:**
  el código nuevo acepta `barberia` y `agenda`, así que **no hace falta
  tocar la base**. Arregla hacia adelante, o haz Instant Rollback **solo
  si antes devuelves las cuentas a la clave vieja** (siguiente punto).
- **Quieres volver al código viejo después de la 052:** el código viejo
  no conoce la clave `agenda`; las cuentas migradas perderían el módulo.
  Primero devuélvelas a la clave vieja, usando la lista que guardaste en
  el paso e:

  ```sql
  BEGIN;
  UPDATE accounts
  SET vertical_key = 'barberia'
  WHERE vertical_key = 'agenda'
    AND id IN ('<uuid-1>', '<uuid-2>');   -- solo las cuentas migradas
  COMMIT;
  ```

  Pon solo los ids que estaban en esa lista: una cuenta de otro tipo de
  negocio creada ya como `agenda` no debe volver a `barberia`. Después
  haz el Instant Rollback del código.
- **Redirección `/barberia`:** es temporal (307) a propósito, para que
  un rollback del código no choque con una redirección guardada en los
  navegadores. Se pasará a permanente cuando ya no haga falta volver
  atrás.
- **Plantilla de Meta:** como no se edita la plantilla aprobada, un
  rollback no la afecta.

## Temas a revisar y decisiones

Están en `docs/agenda-notas.md` (Ley 1581 y datos sensibles, visibilidad
de las respuestas, concurrencia del bot, moneda COP, trabajo pendiente de
otra sesión). Léelo antes de abrir la agenda a clientes de salud.
