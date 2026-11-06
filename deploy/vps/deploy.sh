#!/usr/bin/env bash
# Despliega el CRM en el VPS y vuelve solo a la versión anterior si la nueva
# no queda sana. Se corre desde cualquier carpeta, como el usuario que tiene
# el repo (no root), que debe estar en el grupo docker.
#
#   deploy/vps/deploy.sh               # despliega origin/main
#   deploy/vps/deploy.sh <rama|commit> # despliega otra referencia
#   deploy/vps/deploy.sh --rollback    # vuelve a la versión anterior
#   deploy/vps/deploy.sh --status      # qué versión corre y cómo está
#
# Guarda la versión actual y la anterior en .deploy/ (fuera de git). Las
# imágenes se etiquetan con el commit: shift-whatsapp-crm:<sha corto>.
set -euo pipefail

cd "$(dirname "$0")/../.."
STATE=.deploy
mkdir -p "$STATE"

[ -f .env.local ] || { echo "Falta .env.local en $(pwd) (docs/despliegue-vps.md §4)." >&2; exit 1; }

COMPOSE=(docker compose -f deploy/vps/compose.yml)
# Caso D (Traefik en Docker): el override local se suma solo.
[ -f deploy/vps/compose.local.yml ] && COMPOSE+=(-f deploy/vps/compose.local.yml)
COMPOSE+=(--env-file .env.local)

current() { cat "$STATE/current" 2>/dev/null || true; }
previous() { cat "$STATE/previous" 2>/dev/null || true; }

container_health() {
  local id
  id=$("${COMPOSE[@]}" ps -q app 2>/dev/null || true)
  [ -n "$id" ] || { echo "sin-contenedor"; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

# Espera hasta 2 min a que el healthcheck (/api/health: envs + ping a Supabase) dé "healthy".
wait_healthy() {
  local status
  for _ in $(seq 1 24); do
    status=$(container_health)
    [ "$status" = healthy ] && return 0
    sleep 5
  done
  echo "El contenedor no quedó sano (estado: $status)." >&2
  return 1
}

start_tag() {
  CRM_TAG="$1" "${COMPOSE[@]}" up -d --no-build --remove-orphans
}

case "${1:-}" in
  --status)
    echo "Versión actual:   $(current)"
    echo "Versión anterior: $(previous)"
    echo "Contenedor:       $(container_health)"
    exit 0
    ;;
  --rollback)
    prev=$(previous)
    [ -n "$prev" ] || { echo "No hay versión anterior guardada." >&2; exit 1; }
    echo "Volviendo a $prev…"
    start_tag "$prev"
    wait_healthy
    cur=$(current)
    echo "$prev" > "$STATE/current"
    echo "$cur" > "$STATE/previous"
    echo "Listo: corre $prev."
    exit 0
    ;;
esac

ref="${1:-origin/main}"

# El checkout del VPS no se edita a mano: si hay cambios, se para aquí.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Hay cambios sin guardar en el repo del VPS; no se despliega:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

git fetch --prune origin
git checkout --quiet --detach "$ref"
tag=$(git rev-parse --short=12 HEAD)
echo "Construyendo $tag ($(git log -1 --format='%s'))…"

CRM_TAG="$tag" "${COMPOSE[@]}" build app
old=$(current)
start_tag "$tag"

if wait_healthy; then
  if [ "$old" != "$tag" ]; then
    echo "$old" > "$STATE/previous"
    echo "$tag" > "$STATE/current"
  fi
  # Se conservan solo la versión actual y la anterior.
  keep="$tag $(previous)"
  docker image ls shift-whatsapp-crm --format '{{.Tag}}' | while read -r t; do
    case " $keep " in *" $t "*) ;; *) docker image rm "shift-whatsapp-crm:$t" >/dev/null 2>&1 || true ;; esac
  done
  echo "Listo: corre $tag. Comprueba https://crm.aishiftdigital.com/api/health"
else
  if [ -n "$old" ]; then
    echo "Volviendo a $old…" >&2
    start_tag "$old"
    wait_healthy || true
    git checkout --quiet --detach "$old" 2>/dev/null || true
  fi
  echo "El despliegue de $tag falló. Revisa: ${COMPOSE[*]} logs --tail 200 app" >&2
  exit 1
fi
