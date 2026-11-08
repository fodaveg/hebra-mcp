#!/usr/bin/env bash
# Publica el transporte HTTP remoto (mcp.hebra.pro) en el server de productos
# POR EL REGISTRO de imágenes del Forgejo propio, con despliegue por huella y
# vuelta atrás, como Senda y lumbre-mcp. `./deploy/publicar.sh --help` para las
# opciones.
#
#   ./deploy/publicar.sh                 despliega el HEAD
#   ./deploy/publicar.sh --anterior      vuelve a la imagen anterior
#   ./deploy/publicar.sh --version <sha> despliega la imagen de ese commit
#   ./deploy/publicar.sh --historial     historial de despliegues del server
#
# Deploy normal del HEAD (árbol limpio y HEAD dentro de origin/main):
#   - si `git.dualhand.com/fodaveg/hebra-mcp:<sha completo>` ya está en el
#     registro para la arquitectura del server, se despliega esa imagen tal cual
#     (sin gate ni build; vale desde Fedora, sin Node ni submódulos);
#   - si no: submódulos en los commits FIJADOS, gate (`npm run check`:
#     typecheck, no-hebra-code, tests y bundle), `npm run build` para dejar
#     `dist/`, `docker buildx build --push` para la arquitectura del server y
#     huella del registro. Registro caído o sin credenciales: para ANTES del gate.
#   - En el server: candado, compose.yml del commit (solo si lee
#     HEBRA_MCP_IMAGE), `.env` con la imagen por huella, `docker pull` de esa
#     huella, `docker compose up -d --wait` y una línea en el historial.
#
# La imagen lleva `dist/` (el código de Hebra empaquetado, del submódulo privado
# `vendor/hebra`, que el server no puede clonar). El registro es el propio, con
# credenciales: no es público. `docker login git.dualhand.com` con escritura en
# el Mac o en Fedora; el server, de solo lectura. Este script no las crea ni las
# pide.
#
# La mecánica común vive en deploy/lib/deploy-registro.sh (lado local) y
# deploy/lib/remote-release.sh (lado server).
#
# Variables: SSH_HOST (alias, default `lumbre-arm`), REMOTE_DIR (default
# /srv/hebra-mcp/deploy), HEBRA_MCP_ENV_FILE (secretos del server, default
# $REMOTE_DIR/.env), DEPLOY_REGISTRY, DOCKER_PLATFORM.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_SERVICE="mcp"              # servicio de deploy/compose.yml
DEPLOY_CONTAINER="hebra-mcp"      # container_name del compose
DEPLOY_ENV_VAR="HEBRA_MCP_IMAGE"  # DEBE coincidir con image: de deploy/compose.yml
DEPLOY_IMAGE="hebra-mcp"
DEPLOY_CONTEXT="."
DEPLOY_DOCKERFILE="deploy/Dockerfile"
DEPLOY_LOG_DIR=""
REMOTE_DIR="${REMOTE_DIR:-/srv/hebra-mcp/deploy}"
# El servicio vive en el `deploy/` del directorio del server: allí está el
# `deploy/.env` de siempre, con los secretos del server (HEBRA_MCP_BACKCHANNEL_SECRET,
# HEBRA_MCP_DATA_DEVICE…) y, desde ahora, la línea HEBRA_MCP_IMAGE con la huella,
# y se instala `deploy/compose.yml`, así que los comandos del runbook siguen valiendo.
# Es 0600 y solo del server; compose lo lee con --env-file.
DEPLOY_SECRETS_ENV="${HEBRA_MCP_ENV_FILE:-$REMOTE_DIR/.env}"

# Rutas del server que viajan por SSH: absolutas y sin caracteres raros.
is_canonical_remote_path() {
  local path="$1"
  [[ "$path" =~ ^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] &&
    [[ "$path" != *"/./"* && "$path" != */. && "$path" != *"/../"* && "$path" != */.. ]]
}

# Alias de `~/.ssh/config` o `usuario@host`; el primer carácter alfanumérico para
# que ssh no lo lea como opción.
is_valid_host() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]]
}

# shellcheck source=deploy/lib/deploy-registro.sh
source "$(dirname "$0")/lib/deploy-registro.sh"

is_valid_host "$SSH_HOST" || {
  echo "ERROR: SSH_HOST debe ser un alias o usuario@host válido." >&2
  exit 1
}
for p in "$REMOTE_DIR" "$DEPLOY_SECRETS_ENV"; do
  is_canonical_remote_path "$p" || {
    echo "ERROR: '$p' debe ser una ruta absoluta canónica simple." >&2
    exit 1
  }
done

# La etiqueta es el sha COMPLETO del commit.
deploy_tag_for_commit() {
  echo "$1"
}

# deploy_require_pinned_submodules: los submódulos tienen que estar inicializados
# y en el commit que fija este repo. `git submodule status` marca con `-` los sin
# inicializar, `+` los que están en otro commit y `U` los con conflicto; el
# árbol limpio ya cubre los cambios locales DENTRO de ellos.
deploy_require_pinned_submodules() {
  local st bad
  st="$(git submodule status --recursive)" || {
    echo "ERROR: git submodule status ha fallado." >&2
    return 1
  }
  bad="$(printf '%s\n' "$st" | grep -E '^[-+U]' || true)"
  if [ -n "$bad" ]; then
    echo "ERROR: los submódulos no están en los commits fijados por este repo:" >&2
    printf '%s\n' "$bad" >&2
    echo "       Ejecuta: git submodule update --init --recursive" >&2
    return 1
  fi
  [ -n "$st" ] || {
    echo "ERROR: este repo no tiene submódulos (¿checkout sin vendor/?): no se puede construir dist/." >&2
    return 1
  }
}

deploy_build_steps() {
  echo "    1/3 submódulos (vendor/hebra, vendor/jdex-manager) en los commits fijados"
  echo "    2/3 npm run check (typecheck, no-hebra-code, tests y bundle)"
  echo "    3/3 npm run build y comprobar dist/cli.mjs (la imagen copia dist/ tal cual)"
}

# Solo corre si hay que construir la imagen (no está en el registro). Se llama
# como `deploy_prepare_build || return 1`, y ahí bash NO aplica `set -e`: cada
# paso lleva su `|| return 1`.
deploy_prepare_build() {
  deploy_require_node || return 1
  [ -d node_modules ] || {
    echo "ERROR: falta node_modules (npm ci) para pasar el gate y compilar." >&2
    return 1
  }

  # `dist/` NO está en el repo: sale de compilar `src/` con los submódulos. Un
  # submódulo en otro commit produciría una imagen que el sha no describe.
  echo "==> 1/3 Submódulos en los commits fijados…"
  deploy_require_pinned_submodules || return 1

  echo "==> 2/3 Gate (npm run check: typecheck, no-hebra-code, tests y bundle)…"
  npm run check || {
    echo "ERROR: gate en rojo: no se construye ni se despliega." >&2
    return 1
  }

  # Se recompila explícitamente aunque `check:bundle` ya compile: lo que entra
  # en la imagen es lo último que se construyó, sin depender de qué hace el gate.
  echo "==> 3/3 Compilando dist/…"
  npm run build || return 1
  [ -f dist/cli.mjs ] || {
    echo "ERROR: el build no dejó dist/cli.mjs." >&2
    return 1
  }
}

deploy_main "./deploy/publicar.sh" "$@" || exit $?

if [ "$DEPLOY_DRY_RUN" = 0 ] && [ "$DEPLOY_MODE" != ayuda ] && [ "$DEPLOY_MODE" != historial ]; then
  echo
  echo "Comprueba el conector (salud y un recorrido real) antes de darlo por bueno."
  echo "Para volver a la versión anterior:  ./deploy/publicar.sh --anterior"
fi
