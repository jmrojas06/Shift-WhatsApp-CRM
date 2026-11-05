# Despliegue en el VPS (OVH)

Guía para montar Shift WhatsApp CRM en el VPS de Shift, el mismo donde
corre n8n. Reemplaza a `despliegue-vercel.md` como camino de producción;
esa guía queda de referencia.

**Es el primer despliegue.** Al 05/11/2026 el CRM no corre en ningún lado:
no hay proyecto en Vercel ni `crm.aishiftdigital.com`. Solo existe la base de
Supabase, que ya tiene el esquema y las cuentas de prueba de Shift.

**Qué se monta:** la app (Next.js) corre en Docker en el VPS y responde en
`https://crm.aishiftdigital.com`. La base de datos y los usuarios **siguen en
Supabase**: no se mueve ningún dato. WhatsApp llega por el webhook de Meta.

```text
Cliente en WhatsApp ──► Meta ──► https://crm.aishiftdigital.com/api/whatsapp/webhook
                                        │  (HTTPS: Caddy o Traefik en el VPS)
                                        ▼
                               contenedor shift-crm (puerto 3000, solo local)
                                        │
                                        ▼
                                  Supabase (datos, login, archivos)
```

**Tiempo:** unas 2 horas la primera vez. Después, cada actualización es un
comando (§9).

**Dominio:** esta guía usa `crm.aishiftdigital.com`. Si eligen otro, cámbienlo
en `.env.local`, en el bloque de Caddy o Traefik y en Meta.

Palabras que aparecen abajo:

- **Proxy inverso:** el programa que recibe el tráfico HTTPS del dominio y se
  lo pasa al contenedor (Caddy, Traefik o nginx). También saca el certificado.
- **Webhook:** la dirección a la que Meta envía cada mensaje que llega al
  WhatsApp del negocio.
- **Cron:** una tarea que el servidor repite sola cada X minutos.
- **Healthcheck:** `GET /api/health` responde 200 si la app tiene sus
  variables y llega a Supabase; 503 si algo falla.

---

## 0. Antes de empezar

- [ ] **Equipo de confianza.** Todo esto se hace desde un equipo limpio y con
  la **llave SSH del VPS ya rotada** (ver la nota interna de rotación de
  claves).
- [ ] **Bitwarden.** Todos los secretos de esta guía se copian de ahí y se
  guardan ahí. Nunca por chat, correo, capturas ni issues. **Este repo es
  público**: nada de IP, llaves ni valores en commits, issues o PR.
- [ ] **DNS.** En Cloudflare, registro `A` `crm` → IP del VPS, en modo **DNS
  only** (nube gris) mientras se saca el certificado. Comprobar:
  `dig +short crm.aishiftdigital.com` devuelve la IP del VPS.
- [ ] **Acceso al repo** `jmrojas06/Shift-WhatsApp-CRM`. Hoy es público, así
  que se clona por HTTPS sin llave (§4.1). Si se pasa a privado, se usa una
  *deploy key* de solo lectura (también en §4.1).
- [ ] **Qué hay unido a `main`.** Revisar con José qué PR entran en este
  despliegue (lista en §11) y qué migraciones piden.

Quién hace qué:

| Paso | Quién |
| --- | --- |
| VPS, DNS, proxy, Docker, crons (§1 a §6) | Daniel |
| Copiar los secretos de producción a Bitwarden | José |
| Supabase (URL de login) y Meta (webhook), §7 | José, con Daniel en llamada |

---

## 1. Mira qué hay en el VPS (solo lectura)

Nada de esto cambia el servidor:

```bash
lsb_release -ds; nproc; free -h; df -h /
docker --version; docker compose version
sudo ss -ltnp | grep -E ':(80|443|3000)\b'
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
systemctl is-active caddy nginx 2>/dev/null
```

Con lo que salga, elige tu caso:

| Quién escucha en 80/443 | Caso | Qué haces en §3 |
| --- | --- | --- |
| `caddy` del sistema (systemd) | **A** | Agregas un bloque al Caddyfile |
| Coolify (`coolify-proxy`) | **B** | Creas el recurso en Coolify |
| Nadie | **C** | Instalas Caddy y agregas el bloque |
| Un contenedor `traefik` (montaje típico de n8n en `~/n8n`) | **D** | Usas el override de Traefik |
| `nginx` del sistema | **E** | Agregas un `server` (al final de §3) |

Anota también: RAM total (si es menos de 4 GB necesitas swap, §2) y si
`docker compose version` es 2.24 o mayor (el caso D lo necesita).

---

## 2. Preparar el servidor

**Docker** (si `docker --version` falló), con el script oficial:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # cierra la sesión SSH y vuelve a entrar
```

**Swap** si hay menos de 4 GB de RAM. Construir la app (`next build`) usa
1,5–2 GB durante unos minutos y, sin swap, el sistema mata el proceso
(error 137) o tumba a n8n:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Firewall:** solo 22, 80 y 443 hacia fuera. Si `ufw` ya está activo con n8n,
no lo toques. Si no:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

> Docker se salta `ufw` con los puertos que publica. Por eso
> `deploy/vps/compose.yml` publica el 3000 **solo en 127.0.0.1**: desde
> internet no se llega al CRM sin pasar por el proxy y su HTTPS.

---

## 3. HTTPS y proxy

### Casos A y C: Caddy en el host

C (instalar Caddy, una vez):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

A y C: copia el bloque de `deploy/vps/Caddyfile.example` al final de
`/etc/caddy/Caddyfile` y recarga:

```bash
sudo mkdir -p /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

El certificado sale solo cuando el contenedor ya responde (§5).

### Caso B: Coolify

Coolify hace de proxy, saca el certificado y despliega con cada push:

1. *Projects → New → Resource → Private Repository (deploy key)* con el repo y
   la rama `main`. *Build pack:* **Dockerfile**.
2. *Domains:* `https://crm.aishiftdigital.com`. *Port:* `3000`.
3. *Environment variables:* las de §4.2. Marca como **Build variable** las
   cuatro `NEXT_PUBLIC_*`.
4. *Healthcheck:* ruta `/api/health`.
5. Deploy. En este caso **no uses** `deploy.sh` ni §5: Coolify los reemplaza.
   Los crons (§6) siguen igual, en el host.

### Caso D: Traefik en Docker (n8n)

Saca los tres valores que usa n8n:

```bash
docker inspect $(docker ps -qf name=traefik) --format '{{json .Args}}' | tr ',' '\n' | grep -E 'entrypoints|certificatesresolvers' | head
docker inspect $(docker ps -qf name=n8n) --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker inspect $(docker ps -qf name=n8n) --format '{{json .Config.Labels}}' | tr ',' '\n' | grep -E 'entrypoints|certresolver'
```

- La **red**: la que comparten Traefik y n8n (por ejemplo `n8n_default`).
- El **entrypoint HTTPS**: el que n8n usa en sus labels (por ejemplo `websecure`).
- El **certresolver**: el de n8n (por ejemplo `mytlschallenge`).

Luego, en la carpeta del repo (§4):

```bash
cp deploy/vps/compose.traefik.example.yml deploy/vps/compose.local.yml
nano deploy/vps/compose.local.yml   # reemplaza los CAMBIAR_
```

`deploy.sh` suma `compose.local.yml` solo. Necesita Docker Compose 2.24 o
mayor (por `!reset`).

### Caso E: nginx en el host

Un `server` con `proxy_pass http://127.0.0.1:3000;`, los headers
`Host`, `X-Forwarded-For` y `X-Forwarded-Proto`, y el certificado con
`sudo certbot --nginx -d crm.aishiftdigital.com`.

---

## 4. Código y variables

### 4.1 Clonar

Mientras el repo sea público:

```bash
sudo mkdir -p /opt/shift-crm && sudo chown "$USER": /opt/shift-crm
git clone https://github.com/jmrojas06/Shift-WhatsApp-CRM.git /opt/shift-crm
```

`deploy.sh` hace `git fetch` del `origin` que quede, así que no hay que
configurar nada más.

**Si el repo pasa a privado** (o ya lo es cuando leas esto), con una *deploy
key* de solo lectura:

```bash
sudo mkdir -p /opt/shift-crm && sudo chown "$USER": /opt/shift-crm
ssh-keygen -t ed25519 -f ~/.ssh/shift-crm-deploy -N '' -C 'vps shift-crm (solo lectura)'
cat ~/.ssh/shift-crm-deploy.pub
```

José pega esa llave pública en GitHub → repo → *Settings → Deploy keys*, **sin**
permiso de escritura. Después:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-shift-crm
  HostName github.com
  IdentityFile ~/.ssh/shift-crm-deploy
  IdentitiesOnly yes
EOF
git clone git@github-shift-crm:jmrojas06/Shift-WhatsApp-CRM.git /opt/shift-crm
# Si ya lo clonaste por HTTPS: git -C /opt/shift-crm remote set-url origin git@github-shift-crm:jmrojas06/Shift-WhatsApp-CRM.git
```

### 4.2 `.env.local`

```bash
cd /opt/shift-crm
cp .env.local.example .env.local && chmod 600 .env.local
nano .env.local
```

Valores (los secretos, de Bitwarden):

| Variable | Valor en el VPS | Nota |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | la de producción | Se incrusta al construir |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la de producción | Se incrusta al construir |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.aishiftdigital.com` | Sin barra final |
| `NEXT_PUBLIC_APP_LOCALE` | `es` | Si falta, la app sale en inglés |
| `SUPABASE_SERVICE_ROLE_KEY` | la de producción | Nunca sale del servidor |
| `ENCRYPTION_KEY` | **la misma del `.env.local` de José** | Ver aviso abajo |
| `META_APP_SECRET` | el de la app de Meta | Si no coincide, el webhook rechaza todo (401) |
| `AUTOMATION_CRON_SECRET` | uno nuevo: `openssl rand -hex 32` | El mismo va en §6 |
| `ALLOWED_INVITE_HOSTS` | `crm.aishiftdigital.com` | Fija los links de invitación a este dominio |
| `SHIFT_STAFF_EMAILS` | correos de José y Daniel, separados por coma | Sin ella, Shift también ve la vista sencilla y entra en el reparto de leads |
| `META_APP_ID` | opcional | Solo para plantillas con imagen |
| `ALERT_WEBHOOK_URL` | opcional | Webhook tipo Slack para fallos de recordatorios |
| `CRON_SECRET` | **no se pone** | Solo existe para Vercel |

> **`ENCRYPTION_KEY` tiene que ser la misma con la que se guardaron los datos
> que ya están en Supabase**, es decir, la del `.env.local` con el que José
> probó en local. Con ella están cifrados en Supabase los tokens de WhatsApp y
> las llaves de IA de cada negocio. Con otra clave, el CRM arranca pero no puede enviar mensajes hasta
> que cada negocio vuelva a guardar su conexión. Rotarla tiene su propio
> procedimiento (`operacion-datos-y-secretos.md` §3.1).

---

## 5. Primer despliegue

```bash
cd /opt/shift-crm
bash deploy/vps/deploy.sh
```

Construye la imagen (5 a 10 minutos la primera vez), la arranca y espera a que
`/api/health` diga que está sana. Comprobar:

```bash
curl -s http://127.0.0.1:3000/api/health      # {"ok":true,...}
curl -sI https://crm.aishiftdigital.com/login  # HTTP/2 200 y certificado válido
bash deploy/vps/deploy.sh --status
```

Si el HTTPS ya responde, se puede volver a poner la nube naranja de
Cloudflare con SSL en **Full (strict)**.

---

## 6. Crons

En Vercel solo corría el de recordatorios. En el VPS van tres
(`deploy/vps/crontab.example`): recordatorios cada 10 minutos, y
automatizaciones y flujos cada 5. El de flujos no es opcional: sin él, quien
abandona un flujo a medias no vuelve a entrar a ninguno, y la plantilla de
inmobiliarias es un flujo.

```bash
sudo install -m 755 -o root -g root deploy/vps/cron-ping.sh /usr/local/bin/shift-crm-cron
sudo mkdir -p /etc/shift-crm
sudo install -m 600 -o root -g root /dev/null /etc/shift-crm/cron.env
sudo nano /etc/shift-crm/cron.env
```

Contenido de `cron.env` (el secreto es el mismo `AUTOMATION_CRON_SECRET` del
`.env.local`):

```bash
CRM_URL=https://crm.aishiftdigital.com
AUTOMATION_CRON_SECRET=pega-aqui-el-secreto
```

Probar a mano y activar:

```bash
sudo /usr/local/bin/shift-crm-cron /api/flows/cron && journalctl -t shift-crm-cron -n 5
sudo install -m 644 -o root -g root deploy/vps/crontab.example /etc/cron.d/shift-crm
```

A los 10 minutos, `journalctl -t shift-crm-cron --since '15 min ago'` muestra
líneas `ok` de las tres rutas. Si cambias el script, repite el primer
`install`.

---

## 7. Conectar Supabase y Meta al VPS (José + Daniel, en llamada)

1. **Supabase → Authentication → URL Configuration:**
   *Site URL* `https://crm.aishiftdigital.com` y, en *Redirect URLs*,
   `https://crm.aishiftdigital.com/**` (sin borrar `http://localhost:3000/**`).
   Sin esto, los correos de confirmación y de cambio de contraseña llevan a
   `localhost` (`auth-emails.md`).
2. **Meta → la app → WhatsApp → Configuration → Webhook:** *Callback URL*
   `https://crm.aishiftdigital.com/api/whatsapp/webhook` y el mismo *Verify
   token* que ya tiene guardado el CRM. Meta lo comprueba en el momento: si
   falla, revisa `META_APP_SECRET` y el token (`multi-waba.md`).
3. **Vercel:** no hay nada que apagar, porque el CRM nunca se publicó ahí
   (revisado el 04/11). Si aparece un proyecto del CRM en Vercel, desactivar
   su cron (Project → Settings → Cron Jobs) y quitarle el dominio, para que no
   queden dos copias atendiendo.
4. **Prueba de humo** (`despliegue-vercel.md` §7, con el dominio nuevo):
   login, mensaje de prueba que aparece en la Bandeja, una cita de prueba con
   la cuenta Barbería Élite y su recordatorio. Los datos de prueba se marcan y
   se borran después.

---

## 8. Monitoreo y logs

- **UptimeRobot** (gratis): monitor HTTP cada 5 minutos a
  `https://crm.aishiftdigital.com/api/health`, con alerta al correo de los dos.
- **Salud del VPS:** agregar `crm.aishiftdigital.com` a `DOMAINS` en
  `/etc/vps-health.conf` (`shift-digital-web/infra/vps-health.sh`).
- **Logs de la app:** `docker compose -f deploy/vps/compose.yml --env-file .env.local logs -f --tail 200 app`.
  Buscar `Error processing webhook`, `[agenda reminders]`, `[ops alert]`.
- **Logs de los crons:** `journalctl -t shift-crm-cron --since today`.
- **Disco:** las imágenes viejas se borran solas (quedan la actual y la
  anterior) y los logs rotan a 5 × 10 MB.

---

## 9. Actualizar y volver atrás

Flujo normal: se une el PR a `main` en GitHub y en el VPS:

```bash
cd /opt/shift-crm && bash deploy/vps/deploy.sh
```

- **Si el PR trae migración:** primero respaldo (`operacion-datos-y-secretos.md`
  §2) y la migración en Supabase → SQL Editor, después el despliegue. Las
  migraciones del repo son aditivas, así que la versión vieja sigue
  funcionando con la base nueva.
- **Si la versión nueva no queda sana**, `deploy.sh` vuelve sola a la
  anterior y avisa.
- **Volver atrás a mano:** `bash deploy/vps/deploy.sh --rollback`.
- **Desplegar otra rama para probar:** `bash deploy/vps/deploy.sh feat/x`.
  Ojo: escribe en la base de producción, igual que `main`.

---

## 10. Respaldos y costos

| Qué | Dónde | Costo |
| --- | --- | --- |
| App | VPS de OVH (ya pagado) | 0 extra |
| Datos, login, adjuntos | Supabase | Plan Free hoy |
| Mensajes de WhatsApp | Meta, lo paga cada negocio | Según volumen |
| IA | Llave propia de cada negocio | Según uso |

- **Supabase Free no guarda respaldos descargables** y pausa los proyectos sin
  actividad. Con el primer cliente que pague, pasar a **Pro** (USD 25 al mes; confirmar el
  precio al contratar): respaldos diarios. Decisión pendiente de José y Daniel.
- Hasta entonces: `pg_dump` manual antes de cada migración y una vez al mes,
  guardado cifrado (`operacion-datos-y-secretos.md` §2).
- **Meta cobra los mensajes de servicio** desde el 01/10/2026 pasados 1.000 al
  mes por número, y sin medio de pago deja de entregarlos. Cada número de
  cliente necesita su medio de pago en Meta antes de salir en vivo.

---

## 11. Estado de `main` al 05/11/2026

Unidos el 04/11, todavía **sin desplegar en ningún lado**: PR #7 (vista
sencilla), #8 (filtro antes de la IA), #9 (plantilla de inmobiliarias), #10
(botones del recordatorio), #12 (esta guía) y #13 (Shift fuera del reparto de
leads y guía de alta para los tres negocios). Con eso, `main` ya tiene lo que
muestran las tres demos. Este despliegue no pide migraciones nuevas.

El CRM sale **solo con WhatsApp**: Instagram y Messenger no están construidos
(decisión del 04/11).

| Pendiente | Qué falta | Quién |
| --- | --- | --- |
| `SHIFT_STAFF_EMAILS` | Va en el `.env.local` del VPS (§4.2) | José se la pasa a Daniel |
| PR #11 (clínicas, fase 1) | Fuera de este despliegue. Antes de unirlo: `SHOW server_version;` da 15 o más y aplicar `055_clinica_base.sql` en el SQL Editor | José |
| Plantilla de inmobiliarias | Revisar sus textos y montos de ejemplo antes de activarla en un cliente (descripción del PR #9) | José |
| Prueba real de WhatsApp | Con un número de prueba de Meta, después del §7 | José + Daniel |

---

## 12. Problemas comunes

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| `next build` muere con 137 | Falta RAM | Swap (§2) |
| 502 en el dominio | El contenedor no corre o no está sano | `deploy.sh --status` y los logs (§8) |
| Meta: "callback URL couldn't be validated" | HTTPS aún sin certificado o token distinto | `curl -sI https://...`, revisar el token |
| Webhook responde 401 en los logs | `META_APP_SECRET` equivocado | Corregir y `deploy.sh` (o `docker compose ... up -d`) |
| Correos de login llevan a `localhost` | Falta el paso 1 de §7 | Configurar las URL en Supabase |
| La app sale en inglés | Falta `NEXT_PUBLIC_APP_LOCALE=es` al construir | Agregarla y volver a desplegar |
| No salen recordatorios | Cron sin secreto, plantilla sin aprobar o número sin medio de pago | `journalctl -t shift-crm-cron`, Meta |
| El bot dejó de contestar sin error | Meta sin medio de pago y más de 1.000 mensajes en el mes | Revisar Billing en Meta (§10) |
