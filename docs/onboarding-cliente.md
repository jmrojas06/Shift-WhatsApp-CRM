# Onboarding de una barbería nueva — checklist

Alta de una barbería en la instancia existente (multi-cliente: cada
barbería es una `account` con su propio login y datos aislados por RLS).

Requisitos previos: instancia desplegada y sana
(`docs/despliegue-vercel.md`), email del dueño y número de WhatsApp del
negocio. Tiempo estimado: 45–60 min, más lo que tarde Meta en aprobar la
plantilla de recordatorio.

## 1. Crear la cuenta

1. Abre `https://<dominio>/signup` y crea la cuenta con el email del
   dueño (queda como owner de su `account`).
2. El dueño inicia sesión en `https://<dominio>/login` y cambia la
   contraseña.
3. (Opcional) Invitar al equipo: Settings → **Members**.

**Verificación:** el usuario entra y ve el panel general.

## 2. Activar el vertical y la moneda (COP)

Hoy no hay UI para elegir vertical: se activa en la base, una sola vez
por cuenta. Desde la migración 050, `vertical_key` (y `owner_user_id`)
**no se pueden cambiar desde la app** ni con la sesión de un admin: se
hace en Supabase → SQL Editor, que corre como `postgres`.

> **Zona horaria:** el vertical asume `America/Bogota` para todas las
> cuentas (ver `docs/barberia-configuracion.md`). No lo actives para un
> negocio en otra zona horaria hasta que exista soporte multi-zona.

En Supabase → SQL Editor:

```sql
update public.accounts
set vertical_key = 'agenda',
    default_currency = 'COP'
where id = '<uuid-de-la-cuenta>';
```

El tipo de negocio y su vocabulario se eligen después, en /agenda/configuracion.

Para encontrar el id:

```sql
select id, name, created_at
from public.accounts
order by created_at desc
limit 5;
```

**Verificación:** al recargar, el menú muestra **Barbería**.

## 3. Instalar la plantilla del vertical

`/barberia` → botón **Instalar plantilla**. Deja lista la estructura de
trabajo: servicios base, barbero de ejemplo, horario, etiquetas,
pipeline, respuestas rápidas, base de conocimiento y prompt del agente.

Es **idempotente**: repetirlo no duplica ni pisa datos del dueño.

**Verificación:** aparecen servicios y etiquetas en la UI.

## 4. Cargar la configuración real

Todo desde `/barberia` → **Configuración** (guía completa:
`docs/barberia-configuracion.md`):

- [ ] **Negocio:** nombre, dirección, moneda COP.
- [ ] **Servicios:** reales (nombre, duración, precio); desactivar los
      de ejemplo.
- [ ] **Barberos:** reales + qué servicios atiende cada uno.
- [ ] **Horarios:** días y franjas reales del local.
- [ ] **Bloqueos:** almuerzos, festivos, ausencias.
- [ ] **Bot y recordatorios:** textos del bot (saludo/despedida) y
      decisión sobre la segunda señal de 2 h.

**Verificación:** la agenda muestra las franjas correctas.

## 5. Conectar WhatsApp Cloud API

Settings → pestaña **WhatsApp** (`/settings?tab=whatsapp`):

1. Número: Phone Number ID, WABA ID, token (System User de Meta) y
   verify token (inventa uno largo).
2. Botón **Verificar con Meta** (comprueba credenciales contra la API).
3. PIN de doble paso si Meta lo pide.

Errores comunes: `docs/whatsapp-connection-troubleshooting.md`. Varios
WABA/números: `docs/multi-waba.md`.

## 6. Verificar el webhook en Meta

En Meta → App → WhatsApp → Configuration:

1. Callback URL: `https://<dominio>/api/whatsapp/webhook`
2. Verify token: **el mismo** que pusiste en el paso 5.
3. Suscribe el campo `messages`.
4. Desde otro celular, envía un mensaje de prueba al número del negocio:
   debe aparecer en la **Bandeja de entrada** en segundos.

Si el webhook rechaza con 401: `META_APP_SECRET` equivocado
(`docs/multi-waba.md`).

## 7. Crear la plantilla de recordatorio en Meta

Sigue la receta exacta de `docs/barberia-recordatorios.md` → *Plantilla
de Meta (`recordatorio_cita`)*: nombre, categoría Utilidad, idioma `es`,
cuerpo con 5 variables y los tres quick replies
(Confirmar / Reprogramar / Cancelar).

Sin esta plantilla, los recordatorios fuera de la ventana de 24 h no se
pueden enviar (dentro de la ventana salen igual, como mensaje libre).

**Verificación:** la plantilla queda **Aprobada** en WhatsApp Manager
(minutos a ~1 día).

## 8. Probar el flujo completo

1. Desde un celular externo, escribe al número («Hola, quiero una
   cita») y agenda una cita completa con el bot.
2. La cita aparece en `/barberia` → **Agenda** y la conversación en la
   Bandeja de entrada.
3. Dispara el recordatorio sin esperar
   (`docs/barberia-recordatorios.md` → «Probar sin esperar a la hora
   real»): el cliente recibe el mensaje y la cita aparece en
   «Enviados».
4. El cliente toca **Confirmar**: la cita queda confirmada.
5. Si la segunda señal de 2 h está activa, repite la corrida y revisa
   que no se duplique nada.

## 9. Confirmar cron y alertas

- [ ] `AUTOMATION_CRON_SECRET` y `CRON_SECRET` definidos en el entorno;
      el cron corre (Vercel → **Cron Jobs**, o pinger externo).
- [ ] `/api/health` monitoreado desde afuera
      (`docs/despliegue-vercel.md` §6).
- [ ] (Opcional) `ALERT_WEBHOOK_URL` para avisos de fallos del runner.

## 10. Entrega al cliente

- Acceso del dueño (contraseña temporal ya cambiada).
- Resumen de uso: agenda, bandeja y recordatorios
  (`docs/barberia-configuracion.md`, `docs/barberia-recordatorios.md`).
- Operación, respaldos y secretos: `docs/operacion-datos-y-secretos.md`.

## Resumen: paso → verificación → si falla

| Paso | Verificación | Si falla |
| --- | --- | --- |
| 1. Cuenta | Login OK | revisar `/signup` y el correo |
| 2. Vertical | menú **Barbería** visible | SQL aplicado sobre la cuenta correcta |
| 3. Plantilla | servicios visibles | reintentar setup (es idempotente) |
| 4. Configuración | agenda con horarios reales | `docs/barberia-configuracion.md` |
| 5. WhatsApp | «Verificar con Meta» OK | `docs/whatsapp-connection-troubleshooting.md` |
| 6. Webhook | mensaje en la Bandeja | verify token / firma; `docs/multi-waba.md` |
| 7. Plantilla Meta | aprobada | nombre/idioma exactos `recordatorio_cita` / `es` |
| 8. Flujo | cita + recordatorio + Confirmar | `docs/barberia-recordatorios.md` |
| 9. Cron | corrida OK en Cron Jobs | pinger externo de respaldo |
