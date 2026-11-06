#!/usr/bin/env bash
# Llama una ruta de cron del CRM con el secreto compartido. Lo ejecuta root
# desde /etc/cron.d/shift-crm (deploy/vps/crontab.example), instalado en
# /usr/local/bin/shift-crm-cron para que nadie sin sudo pueda cambiarlo.
#
# Uso: shift-crm-cron /api/verticals/agenda/reminders/run
#
# Lee CRM_URL y AUTOMATION_CRON_SECRET de /etc/shift-crm/cron.env (root, 600).
# Nunca imprime el secreto. Deja una línea en el journal por corrida:
#   journalctl -t shift-crm-cron --since today
set -uo pipefail

CONF=/etc/shift-crm/cron.env
path="${1:?falta la ruta, por ejemplo /api/flows/cron}"

# Mismo cuidado que infra/vps-health.sh: solo se lee si es de root y nadie más puede escribirlo.
if [ ! -f "$CONF" ] || [ "$(stat -c '%u' "$CONF")" != 0 ] || [ -n "$(find "$CONF" -perm /077)" ]; then
  logger -t shift-crm-cron "FALLO $path: $CONF no existe o no es de root con permisos 600"
  exit 1
fi
# shellcheck source=/dev/null
. "$CONF"

# Si la corrida anterior de esta misma ruta sigue viva, esta se salta.
lock="/run/lock/shift-crm-cron$(printf '%s' "$path" | tr -c 'a-zA-Z0-9' '_').lock"
exec 9>"$lock"
flock -n 9 || { logger -t shift-crm-cron "salto $path: la corrida anterior sigue"; exit 0; }

body=$(mktemp)
trap 'rm -f "$body"' EXIT
# 000 = no hubo respuesta (DNS, TLS, tiempo agotado o el contenedor caído).
code=$(curl -s -o "$body" -w '%{http_code}' --max-time 170 \
  -H "x-cron-secret: ${AUTOMATION_CRON_SECRET}" "${CRM_URL%/}${path}") || code=000

if [ "$code" = 200 ]; then
  logger -t shift-crm-cron "ok $path"
else
  # Solo los primeros 300 caracteres de la respuesta: es JSON del propio CRM.
  logger -t shift-crm-cron "FALLO $path: HTTP $code $(head -c 300 "$body" | tr '\n' ' ')"
  exit 1
fi
