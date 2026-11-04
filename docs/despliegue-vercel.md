# Despliegue en Vercel — Shift WhatsApp CRM

Guía para operar Shift WhatsApp CRM en producción con **Vercel Pro**:
una sola instancia sirve a varios negocios con agenda (multi-cliente por
`account`, con RLS por `account_id`).

> **Plan requerido: Vercel Pro.** El plan Hobby no permite uso
> comercial, limita las funciones a 60 s (los broadcasts masivos usan
> hasta 300 s) y no admite crons más frecuentes que una vez al día.

## 0. Antes de empezar

| Pieza | Qué necesitas |
| --- | --- |
| Repo | `jmrojas06/Shift-WhatsApp-CRM` en GitHub (`main` desplegable). |
| Vercel | Cuenta con plan Pro. |
| Supabase | Proyecto de producción con las migraciones aplicadas (ver §4). |
| Meta | App de WhatsApp Cloud API + número del negocio. |
| Dominio | Dominio o subdominio (ej. `crm.tu-dominio.com`) con acceso a DNS. |

## 1. Importar el proyecto

1. Vercel → **Add New… → Project** → importa el repo.
2. Framework preset: **Next.js** (automático). No cambies Root
   Directory ni Build Command.
3. Región de funciones: elige la más cercana a tu proyecto Supabase
   (Project → Settings → Functions → Region) para bajar latencia.

`vercel.json` ya viene en el repo con el cron de recordatorios (§5).

## 2. Variables de entorno

Project → Settings → Environment Variables. Marca **Production** en
todas; en **Preview** solo si aceptas que un preview escriba contra el
mismo Supabase (§8). La lista completa y comentada está en
`.env.local.example`.

### Build-time (se inlinean en el bundle; cambiarlas exige redeploy)

| Variable | Valor |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SITE_URL` | `https://tu-dominio` (sin barra final) |
| `NEXT_PUBLIC_APP_LOCALE` | `es` |

### Runtime (secretos; nunca llegan al cliente)

| Variable | Requerida | Qué es |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Bypassa RLS; solo rutas server. |
| `ENCRYPTION_KEY` | Sí | 64 hex (AES-256-GCM) para los tokens de WhatsApp. **Distinta por entorno**; rotarla invalida tokens guardados (`docs/operacion-datos-y-secretos.md`). |
| `META_APP_SECRET` | Sí | Firma HMAC de cada webhook entrante. |
| `AUTOMATION_CRON_SECRET` | Para el cron | Secreto del runner de recordatorios. |
| `CRON_SECRET` | Para el cron | **El mismo valor** que `AUTOMATION_CRON_SECRET` (Vercel lo manda como Bearer). |
| `SHIFT_STAFF_EMAILS` | Sí | Correos del equipo de Shift, separados por comas. Ven todo y pueden alternar «Ver como el negocio»; cualquier otro usuario ve la vista sencilla del local (sin IA, flujos, automatizaciones, difusiones, plantillas, WhatsApp ni API). Sin definir, todos ven la vista sencilla. |
| `ALERT_WEBHOOK_URL` | Opcional | Webhook Slack-compatible para alertas de fallos del runner. |
| `META_APP_ID` | Opcional | Solo para plantillas con header de imagen. |

## 3. Dominio

1. Project → Settings → **Domains** → agrega el dominio.
2. En tu DNS, crea el registro que Vercel te indique (CNAME/A).
3. El certificado TLS se emite solo; verifica `https://tu-dominio`.

## 4. Migraciones en producción

El workflow CI «Migrations» **no** toca la nube: replica todas las
migraciones desde cero en un Postgres limpio y valida el esquema. En
producción se aplican a mano **una sola vez**, en orden, desde
Supabase → SQL Editor (o la Management API): `supabase/migrations/*.sql`.

Las migraciones del repo son aditivas e idempotentes por diseño
(`IF NOT EXISTS` / `DROP IF EXISTS`). Antes de aplicar una nueva,
exporta un backup (`docs/operacion-datos-y-secretos.md`).

## 5. Cron de recordatorios

`vercel.json` ya lo declara:

```json
{
  "crons": [
    {
      "path": "/api/verticals/agenda/reminders/run",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

- Requiere plan Pro y las envs `AUTOMATION_CRON_SECRET` + `CRON_SECRET`
  (§2). Sin ellas el endpoint responde 503/401 y el cron no sirve.
- Verificación: Project → **Cron Jobs** (cada corrida con su log), o
  manual:

```bash
curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
  https://<tu-dominio>/api/verticals/agenda/reminders/run
```

- La URL vieja `/api/verticals/barberia/reminders/run` sigue
  funcionando como alias para crons externos que aún la usen; apúntalos
  a la nueva cuando puedas.
- **Alternativa/respaldo:** pinger externo (cron-job.org u otro) cada
  10–15 min con el header `x-cron-secret`; avisa por correo si la
  ejecución falla, lo que también vigila al cron nativo.
- **Alertas de fallos** (corrida lanzada o `failed > 0`): con
  `ALERT_WEBHOOK_URL` definida el runner avisa por ese webhook.
  Detalle en `docs/agenda-recordatorios.md`.
- Si usas automatizaciones con esperas o flujos (`/api/automations/cron`,
  `/api/flows/cron`): agrégalos a un pinger externo con `x-cron-secret`
  (no están en `vercel.json`).

## 6. Healthcheck y monitoreo

- `GET /api/health` → `{ ok, checks: { env, db }, time }`. 200 = sano;
  503 = algo falla. Sin auth y **sin detalles sensibles**.
- Monitor externo (UptimeRobot u otro) cada 2–5 min sobre
  `/api/health`, con alerta por correo o Slack.
- Logs: Project → **Logs** (runtime). Busca `[agenda reminders]`,
  `[ops alert]`, `Error processing webhook`. El resumen del runner
  (incluye `errors`) también queda en el log de la función del cron.
- Webhook rechazando con 401: firma HMAC — normalmente
  `META_APP_SECRET` equivocado (`docs/multi-waba.md`).

## 7. Verificación post-despliegue (smoke)

1. `https://<tu-dominio>/api/health` → `ok: true`.
2. Login del owner y alta del negocio → `docs/onboarding-cliente.md`.
3. Conectar WhatsApp (Settings → WhatsApp) y usar **Verificar con Meta**.
4. Callback del webhook en Meta: `https://<tu-dominio>/api/whatsapp/webhook`;
   envía un mensaje de prueba y míralo en la Bandeja de entrada.
5. Runner manual: el `curl` del §5 devuelve el JSON de resumen.
6. Cron Jobs: espera una corrida con estado OK.

## 8. Actualizaciones y rollback

- Flujo normal: merge a `main` → Vercel construye y despliega.
- Rollback: Project → Deployments → **Instant Rollback** al anterior.
- Si el deploy trae migración, aplícala antes o después según
  compatibilidad; el diseño aditivo lo permite. El cambio de la agenda
  armable (migraciones 051 y 052) tiene un orden fijo: ver
  `docs/agenda-despliegue-fase1.md`.
- **Preview Deployments:** si comparten el Supabase de producción pueden
  escribir datos reales. Recomendado: proyecto Supabase de staging para
  previews (`docs/operacion-datos-y-secretos.md`) o deshabilitarlos.

## 9. Multi-cliente en una instancia

Cada negocio es una `account` (login propio, RLS por `account_id`). El
runner recorre todas las cuentas con el módulo de la agenda en una sola
corrida: `agenda` en `accounts.modules` (migración 053) o, si `modules`
está vacío, `vertical_key = 'agenda'` (o `'barberia'` mientras no se
aplique la migración 052). El webhook enruta por número. Alta de un
negocio nuevo: `docs/onboarding-cliente.md` (el operador fija
`vertical_key = 'agenda'` y `agenda` en `modules`, y el dueño elige el
tipo de negocio con el asistente de `/agenda`).

## Apéndice: VPS con Docker (alternativa)

El repo trae `Dockerfile` (standalone) + `docker-compose.yml`; el
detalle del contenedor está en `docs/docker.md`.

1. En el VPS: clona el repo, copia `.env.local.example` a `.env.local`
   y completa las envs del §2 (`HOST_PORT` publica el puerto).
2. `docker compose --env-file .env.local up --build -d`
3. TLS: reverse proxy delante (Caddy emite HTTPS solo):

   ```caddyfile
   crm.tu-dominio.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

4. Cron del host (el crontab no expande variables: pon el valor o un
   script que lea el secreto):

   ```cron
   */10 * * * * curl -fsS -H "x-cron-secret: EL_SECRETO" https://crm.tu-dominio.com/api/verticals/agenda/reminders/run
   ```

5. Logs: `docker compose logs -f app`. El healthcheck del contenedor ya
   consulta `/api/health`.
