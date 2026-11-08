#!/usr/bin/env bash
# Lado LOCAL del despliegue por registro de imágenes. Lo `source`a
# deploy/publicar.sh, que antes define:
#
#   DEPLOY_SERVICE   servicio de deploy/compose.yml
#   DEPLOY_CONTAINER nombre del contenedor (container_name del compose)
#   DEPLOY_ENV_VAR   variable de imagen que lee compose (`image: ${VAR:-…}`)
#   DEPLOY_IMAGE     nombre de la imagen en el registro
#   DEPLOY_CONTEXT   contexto de `docker buildx build`
#   DEPLOY_DOCKERFILE (opcional) Dockerfile, si no es `Dockerfile` en el contexto
#   DEPLOY_SECRETS_ENV  `--env-file` del server con los secretos (o vacío)
#   DEPLOY_LOG_DIR   carpeta del server donde se vuelca el log del contenedor saliente (o vacío)
#   REMOTE_DIR       directorio del servicio en el server
#   deploy_tag_for_commit <sha>   imprime la etiqueta de la imagen para ese commit
#   deploy_prepare_build          lo que va antes del build (gate, compilación,
#                                 comprobaciones…); solo corre si hay que
#                                 construir. TIENE que devolver distinto de 0 si
#                                 falla cualquier paso (ver abajo).
#   deploy_build_steps            imprime esos pasos para el ensayo en seco
#
# Modelo (detalle en deploy/README-deploy.md, «Publicar una versión nueva»):
#   - La imagen de un commit se construye UNA vez y se sube al registro
#     (`$DEPLOY_REGISTRY/<imagen>:<sha completo>`). Si ya está, el deploy no
#     repite gate ni build: despliega esa misma imagen desde cualquier máquina.
#   - Producción solo desde `main`: el HEAD tiene que estar en origin/main.
#   - El server despliega por HUELLA (`repo@sha256:…`) escrita en su `.env`, y
#     guarda historial para volver atrás (deploy/lib/remote-release.sh).
#   - Registro caído o sin credenciales: el deploy PARA antes del gate.
#
# OJO con `set -e`: dentro de una función llamada a la izquierda de `||`, en un
# `if`, tras `!` o en un `&&`, bash NO lo aplica, y la función devuelve el código
# de su ÚLTIMO comando. Por eso aquí cada paso que importa lleva su propio
# `|| return 1`, y no se fía nada a `set -e` (src/deploy-registro.test.ts tiene
# un deploy de punta a punta con el gate en rojo que lo comprueba).
#
# Ninguna función de aquí escribe en el server salvo deploy_remote (apply,
# anterior).

DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib/docker-platform.sh
source "$DEPLOY_LIB_DIR/docker-platform.sh"

SSH_HOST="${SSH_HOST:-lumbre-arm}" # alias de ~/.ssh/config (204.168.147.11)
DEPLOY_REGISTRY="${DEPLOY_REGISTRY:-git.dualhand.com/fodaveg}"
# Remoto y rama en los que tiene que estar el HEAD: producción solo sale de main.
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
# Delimitador del compose.yml dentro del script que viaja por SSH.
DEPLOY_COMPOSE_EOF="__DEPLOY_COMPOSE_FIN__"

# deploy_usage <comando>: ayuda de las opciones.
deploy_usage() {
  local cmd="${1:-./deploy/publicar.sh}"
  cat <<EOF
Uso: $cmd [opción]

  (sin opción)        Despliega el HEAD. Exige árbol limpio y el HEAD dentro de
                      '$DEPLOY_REMOTE/$DEPLOY_BRANCH'. Si la imagen de ese commit
                      ya está en el registro la reutiliza; si no, la construye y
                      la sube.
  --anterior          Vuelve a la imagen que corría antes de la actual (sin gate
                      ni build). Dos seguidas alternan entre las dos últimas.
  --version <sha>     Despliega la imagen de ese commit, que tiene que estar ya
                      en el registro (sin gate ni build).
  --historial         Enseña el historial de despliegues del server.
  --dry-run           Ensayo en seco: dice qué haría sin tocar el server ni el
                      registro. También con DEPLOY_DRY_RUN=1.

El compose.yml que se sube al server sale del commit, nunca del árbol de
trabajo: de HEAD en un deploy normal (que ya está en $DEPLOY_REMOTE/$DEPLOY_BRANCH), y
de $DEPLOY_REMOTE/$DEPLOY_BRANCH tras git fetch con --anterior y --version (que no
exigen árbol limpio ni HEAD en $DEPLOY_BRANCH).

Variables: SSH_HOST ($SSH_HOST), REMOTE_DIR ($REMOTE_DIR),
DEPLOY_REGISTRY ($DEPLOY_REGISTRY), DOCKER_PLATFORM, DEPLOY_REMOTE ($DEPLOY_REMOTE),
DEPLOY_BRANCH ($DEPLOY_BRANCH).
EOF
}

# deploy_flag_on <valor>: verdadero si una variable de entorno de interruptor
# está encendida: solo 1, true o yes (sin distinguir mayúsculas).
deploy_flag_on() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# deploy_parse_args <argumentos…>
# Deja en DEPLOY_MODE uno de desplegar|anterior|version|historial|ayuda, en
# DEPLOY_VERSION el sha de --version, y en DEPLOY_DRY_RUN 0 o 1 (también se
# enciende con DEPLOY_DRY_RUN=1). Opción desconocida o dos modos a la vez:
# mensaje a stderr y código 2.
deploy_parse_args() {
  DEPLOY_MODE=desplegar
  DEPLOY_VERSION=""
  local modes=0
  if deploy_flag_on "${DEPLOY_DRY_RUN:-}"; then DEPLOY_DRY_RUN=1; else DEPLOY_DRY_RUN=0; fi

  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DEPLOY_DRY_RUN=1 ;;
      --anterior)
        DEPLOY_MODE=anterior
        modes=$((modes + 1))
        ;;
      --historial)
        DEPLOY_MODE=historial
        modes=$((modes + 1))
        ;;
      --version=*)
        DEPLOY_MODE=version
        DEPLOY_VERSION="${1#--version=}"
        modes=$((modes + 1))
        ;;
      --version)
        if [ $# -lt 2 ]; then
          echo "ERROR: --version necesita un sha." >&2
          return 2
        fi
        DEPLOY_MODE=version
        DEPLOY_VERSION="$2"
        modes=$((modes + 1))
        shift
        ;;
      -h | --help) DEPLOY_MODE=ayuda ;;
      *)
        echo "ERROR: opción desconocida: '$1'." >&2
        return 2
        ;;
    esac
    shift
  done

  if [ "$modes" -gt 1 ]; then
    echo "ERROR: --anterior, --version y --historial no se combinan." >&2
    return 2
  fi
  if [ "$DEPLOY_MODE" = version ] && ! is_commit_sha "$DEPLOY_VERSION"; then
    echo "ERROR: --version espera un sha de commit (7 a 40 caracteres hexadecimales), no '$DEPLOY_VERSION'." >&2
    return 2
  fi
  return 0
}

# is_commit_sha <texto>: verdadero si es un sha de commit (7-40 hex, minúsculas).
is_commit_sha() {
  [[ "${1:-}" =~ ^[0-9a-f]{7,40}$ ]]
}

# is_digest <texto>: verdadero si es una huella `sha256:<64 hex>`.
is_digest() {
  [[ "${1:-}" =~ ^sha256:[0-9a-f]{64}$ ]]
}

# is_safe_image_ref <texto>: verdadero si la referencia de imagen solo lleva
# caracteres seguros para viajar por SSH (letras, cifras y . _ / : @ -).
is_safe_image_ref() {
  [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]
}

# image_json_has_platform <json de `imagetools inspect --format '{{json .Image}}'`> <plataforma>
# Verdadero si la imagen sirve para <plataforma> (p. ej. linux/arm64). Con un
# índice el JSON es un mapa por plataforma ("linux/arm64": {…}); con un
# manifiesto simple es la configuración, con "os" y "architecture". Un JSON
# vacío no sirve para nada.
image_json_has_platform() {
  local json="$1" platform="$2" flat
  local os="${platform%%/*}" arch="${platform#*/}"
  flat="$(printf '%s' "$json" | tr -d ' \t\r\n')"
  [ -n "$flat" ] || return 1
  case "$flat" in
    *"\"$platform\":{"*) return 0 ;;
  esac
  case "$flat" in
    \{\"linux/* | \{\"unknown/*) return 1 ;; # índice sin esa plataforma
  esac
  case "$flat" in
    *"\"architecture\":\"$arch\""*) ;;
    *) return 1 ;;
  esac
  case "$flat" in
    *"\"os\":\"$os\""*) return 0 ;;
    *) return 1 ;;
  esac
}

# inspect_error_is_not_found <stderr de imagetools inspect>
# Verdadero si el error dice que la etiqueta no existe (hay que construir).
# Cualquier otro (credenciales, red, registro caído) NO es «no existe»: el
# deploy para en vez de lanzar un gate y un build que acabarían sin poder subir.
inspect_error_is_not_found() {
  printf '%s' "$1" | grep -qiE ': not found|manifest unknown|name unknown|status: 404|404 not found'
}

# digest_from_metadata <fichero de buildx --metadata-file>
# Imprime la huella que el registro dio a la imagen subida
# (`containerimage.digest`; medido el 8 nov 2026 con el driver docker: coincide
# con la de `imagetools inspect`). Código 1 si no está o no es una huella.
digest_from_metadata() {
  local d
  [ -f "$1" ] || return 1
  d="$(tr -d '\n' <"$1" | sed -n 's/.*"containerimage\.digest"[[:space:]]*:[[:space:]]*"\(sha256:[0-9a-f]*\)".*/\1/p')"
  is_digest "$d" || return 1
  echo "$d"
}

# registry_lookup <ref con etiqueta o huella> <plataforma>
# Pregunta al registro por la imagen. Códigos: 0 existe para esa plataforma
# (imprime su huella), 3 no existe, 4 existe pero para otra plataforma, 1 no se
# pudo consultar o no se pudo comprobar la plataforma (mensaje a stderr; NO se
# reutiliza). Solo lee del registro.
registry_lookup() {
  local ref="$1" platform="$2" errf digest json msg
  errf="$(mktemp)" || return 1
  if ! digest="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>"$errf")"; then
    msg="$(cat "$errf")"
    rm -f "$errf"
    if inspect_error_is_not_found "$msg"; then
      return 3
    fi
    echo "ERROR: no se pudo consultar el registro por $ref:" >&2
    echo "$msg" | tail -n 3 >&2
    echo "       ¿Falta 'docker login ${ref%%/*}' (con permiso de escritura)? Si el registro está caído, no hay deploy: se para antes del gate." >&2
    return 1
  fi
  rm -f "$errf"
  if ! is_digest "$digest"; then
    echo "ERROR: el registro devolvió una huella rara para $ref: '$digest'." >&2
    return 1
  fi
  json="$(docker buildx imagetools inspect --format '{{json .Image}}' "$ref" 2>/dev/null)" || {
    echo "ERROR: no se pudo leer la configuración de $ref para comprobar su plataforma; no se reutiliza." >&2
    return 1
  }
  if [ -z "$json" ]; then
    echo "ERROR: el registro no devolvió la configuración de $ref; no se puede comprobar que sea para $platform." >&2
    return 1
  fi
  if ! image_json_has_platform "$json" "$platform"; then
    echo "ERROR: $ref está en el registro pero no es para $platform." >&2
    return 4
  fi
  echo "$digest"
}

# deploy_require_clean_tree: falla si hay cambios sin commitear o ficheros sin
# seguimiento (entrarían en el build y la etiqueta, el sha, no los describiría).
deploy_require_clean_tree() {
  local st
  st="$(git status --porcelain)" || {
    echo "ERROR: git status ha fallado." >&2
    return 1
  }
  if [ -n "$st" ]; then
    echo "ERROR: el árbol tiene cambios sin commitear o ficheros sin seguimiento; la imagen no correspondería al commit:" >&2
    echo "$st" | head -n 20 >&2
    return 1
  fi
}

# deploy_require_head_on_main <remoto> <rama>
# Falla si el HEAD no está contenido en <remoto>/<rama> (tras `git fetch`):
# producción solo sale de main. Un fetch fallido también para el deploy.
deploy_require_head_on_main() {
  local remote="$1" branch="$2" sha
  sha="$(git rev-parse HEAD)" || return 1
  if ! git fetch --quiet "$remote" 2>/dev/null; then
    echo "ERROR: no se pudo hacer git fetch $remote para comprobar que el HEAD está en $remote/$branch." >&2
    return 1
  fi
  if ! git rev-parse --verify --quiet "refs/remotes/$remote/$branch" >/dev/null; then
    echo "ERROR: no existe $remote/$branch en este repo." >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "$sha" "refs/remotes/$remote/$branch"; then
    echo "ERROR: el HEAD ${sha:0:12} no está en $remote/$branch. Producción solo sale de $branch: integra y empuja antes de desplegar." >&2
    return 1
  fi
}

# deploy_require_node: falla con un mensaje claro si no hay npm para construir.
deploy_require_node() {
  command -v npm >/dev/null 2>&1 && return 0
  echo "ERROR: hay que construir la imagen y en esta máquina no hay Node/npm. Despliega desde una máquina con Node, o sube antes la imagen de este commit desde el Mac." >&2
  return 1
}

# deploy_main_rev: imprime la referencia de la rama de producción
# (refs/remotes/origin/main) tras un `git fetch`. Si el fetch falla, avisa y
# usa la que ya hay en local: volver atrás tiene que poder hacerse con el
# remoto caído. Código 1 si esa rama no existe en local.
deploy_main_rev() {
  local rev="refs/remotes/$DEPLOY_REMOTE/$DEPLOY_BRANCH"
  git fetch --quiet "$DEPLOY_REMOTE" 2>/dev/null ||
    echo "AVISO: no se pudo hacer git fetch $DEPLOY_REMOTE; el compose.yml sale de la $DEPLOY_REMOTE/$DEPLOY_BRANCH que ya hay en local." >&2
  git rev-parse --verify --quiet "$rev" >/dev/null || {
    echo "ERROR: no existe $DEPLOY_REMOTE/$DEPLOY_BRANCH en este repo." >&2
    return 1
  }
  echo "$rev"
}

# deploy_remote_script <revisión del compose, o vacío> <subcomando> <argumentos…>
# Imprime el script que se manda al server: deploy/lib/remote-release.sh,
# si toca la función release_compose_content con el deploy/compose.yml de esa
# revisión (nunca el del árbol de trabajo), y la llamada a release_main con
# los argumentos citados (stdin a /dev/null para que docker no se coma el
# script).
deploy_remote_script() {
  local rev="$1" compose
  shift
  cat "$DEPLOY_LIB_DIR/remote-release.sh" || return 1
  if [ -n "$rev" ]; then
    compose="$(git show "$rev:deploy/compose.yml")" || {
      echo "ERROR: no se pudo leer deploy/compose.yml de $rev." >&2
      return 1
    }
    case "$compose" in
      *"$DEPLOY_COMPOSE_EOF"*)
        echo "ERROR: deploy/compose.yml contiene $DEPLOY_COMPOSE_EOF." >&2
        return 1
        ;;
    esac
    printf "release_compose_content() {\n  cat <<'%s'\n%s\n%s\n}\n" "$DEPLOY_COMPOSE_EOF" "$compose" "$DEPLOY_COMPOSE_EOF"
  fi
  # Variables de entorno de la parte del server (no son argumentos de release_main).
  printf 'RELEASE_SECRETS_ENV=%q\n' "${DEPLOY_SECRETS_ENV:-}"
  printf 'RELEASE_CONTAINER=%q\n' "${DEPLOY_CONTAINER:-}"
  printf 'RELEASE_LOG_DIR=%q\n' "${DEPLOY_LOG_DIR:-}"
  printf 'release_main'
  printf ' %q' "$@"
  printf ' </dev/null\n'
}

# deploy_remote [--con-compose <revisión>] <subcomando> <argumentos…>
# Ejecuta release_main en el server. El script se arma ENTERO antes de abrir
# el SSH, para no mandar uno a medias si falla `git show`.
deploy_remote() {
  local rev="" script
  if [ "${1:-}" = --con-compose ]; then
    rev="$2"
    shift 2
  fi
  script="$(deploy_remote_script "$rev" "$@")" || return 1
  printf '%s\n' "$script" | ssh "$SSH_HOST" bash -s
}

# deploy_build_push <repo> <etiqueta completa> <plataforma> <sha>
# Construye la imagen para la plataforma del server, la sube al registro e
# imprime su huella, leída de `buildx --metadata-file` y comprobada contra el
# registro (que existe para esa plataforma).
deploy_build_push() {
  local repo="$1" tag="$2" platform="$3" sha="$4" meta digest
  meta="$(mktemp)" || return 1
  docker buildx build --platform "$platform" \
    --label "org.opencontainers.image.revision=$sha" \
    --metadata-file "$meta" \
    ${DEPLOY_DOCKERFILE:+-f "$DEPLOY_DOCKERFILE"} \
    -t "$tag" --push "$DEPLOY_CONTEXT" >&2 || {
    rm -f "$meta"
    return 1
  }
  digest="$(digest_from_metadata "$meta")" || {
    rm -f "$meta"
    echo "ERROR: buildx no dejó la huella de $tag en --metadata-file." >&2
    return 1
  }
  rm -f "$meta"
  registry_lookup "$repo@$digest" "$platform" >/dev/null || {
    echo "ERROR: el registro no tiene $repo@$digest para $platform tras el push." >&2
    return 1
  }
  echo "$digest"
}

# deploy_read_state: lee (sin cambiar nada) el estado del servicio en el
# server y lo deja en DEPLOY_STATE (líneas clave=valor de release_state).
# Código 1 si el server no responde.
deploy_read_state() {
  DEPLOY_STATE="$(deploy_remote estado "$REMOTE_DIR" "$DEPLOY_SERVICE" "$DEPLOY_ENV_VAR" 2>/dev/null)"
}

# deploy_state_field <clave>: valor de una clave de DEPLOY_STATE.
deploy_state_field() {
  printf '%s\n' "$DEPLOY_STATE" | sed -n "s/^$1=//p"
}

# deploy_print_remote_state: ensayo en seco; imprime el estado del servicio en
# el server y qué quedaría como anterior. Si el server no responde, lo dice.
deploy_print_remote_state() {
  local actual contenedor ultima
  if ! deploy_read_state; then
    echo "    server: no se pudo leer el estado de $SSH_HOST."
    return 0
  fi
  actual="$(deploy_state_field actual)"
  contenedor="$(deploy_state_field contenedor)"
  ultima="$(deploy_state_field ultima)"
  echo "    contenedor que corre: ${contenedor:-ninguno}"
  if [ -n "$actual" ]; then
    echo "    ${DEPLOY_ENV_VAR} actual en el .env: $actual (quedaría como anterior)"
  else
    echo "    ${DEPLOY_ENV_VAR} aún no está en el .env: primer despliegue por registro."
    echo "    La imagen que corre se etiquetaría ${DEPLOY_SERVICE}:previo-registro y quedaría como anterior;"
    echo "    después se retira la etiqueta ${DEPLOY_SERVICE}:latest del server."
  fi
  echo "    última línea del historial: ${ultima:-(sin historial todavía)}"
  return 0
}

# deploy_print_apply_plan <ref> <sha> <acción> [revisión del compose]: ensayo
# en seco de lo que se escribiría en el server.
deploy_print_apply_plan() {
  echo "==> En el server ($SSH_HOST:$REMOTE_DIR) haría, con el candado cogido:"
  echo "    comprobar que docker compose acepta up --wait-timeout"
  echo "    compose.yml <- git show ${4:-HEAD}:deploy/compose.yml (si lee \${$DEPLOY_ENV_VAR})"
  echo "    docker pull (si es por huella)"
  echo "    en $REMOTE_DIR/.env: ${DEPLOY_ENV_VAR}=$1"
  echo "    docker compose up -d --wait $DEPLOY_SERVICE (solo ese servicio) y comprobar que se queda en marcha"
  echo "    historial ($REMOTE_DIR/despliegues.log): <fecha> $DEPLOY_SERVICE $3 $2 $1 <anterior>"
  deploy_print_remote_state
}

# deploy_rollback: --anterior.
deploy_rollback() {
  local anterior actual
  echo "==> Vuelta atrás de $DEPLOY_SERVICE en $SSH_HOST (sin gate ni build)…"
  if [ "$DEPLOY_DRY_RUN" = 1 ]; then
    echo "==> ENSAYO EN SECO: no se toca nada."
    if ! deploy_read_state; then
      echo "    server: no se pudo leer el estado de $SSH_HOST."
      return 0
    fi
    anterior="$(deploy_state_field anterior)"
    actual="$(deploy_state_field actual)"
    echo "    ${DEPLOY_ENV_VAR} actual: ${actual:-(sin valor: compose usa la imagen por defecto de deploy/compose.yml)}"
    case "$anterior" in
      "" | "-") echo "    El real FALLARÍA: el historial no tiene imagen anterior de $DEPLOY_SERVICE." ;;
      "<desincronizado>") echo "    El real FALLARÍA: historial desincronizado con el .env." ;;
      *) echo "    Volvería a: $anterior (en $REMOTE_DIR/.env: ${DEPLOY_ENV_VAR}=$anterior)" ;;
    esac
    return 0
  fi
  local rev
  rev="$(deploy_main_rev)" || return 1
  deploy_remote --con-compose "$rev" anterior "$REMOTE_DIR" "$DEPLOY_SERVICE" "$DEPLOY_ENV_VAR" || return 1
}

# deploy_version: --version <sha>; la imagen tiene que estar en el registro.
deploy_version() {
  local sha platform tagname tag digest rc=0 ref rev
  sha="$(git rev-parse --verify --quiet "${DEPLOY_VERSION}^{commit}")" || {
    echo "ERROR: no conozco el commit '$DEPLOY_VERSION' en este repo (¿git fetch?)." >&2
    return 1
  }
  platform="$(resolve_docker_platform "$SSH_HOST")" || return 1
  tagname="$(deploy_tag_for_commit "$sha")" || return 1
  tag="$DEPLOY_REGISTRY/$DEPLOY_IMAGE:$tagname"
  echo "==> $DEPLOY_SERVICE en la versión ${sha:0:12} ($tag, $platform)…"
  digest="$(registry_lookup "$tag" "$platform")" || rc=$?
  if [ "$rc" = 3 ]; then
    echo "ERROR: $tag no está en el registro. --version solo despliega imágenes ya construidas; para construirla, despliega desde un checkout de ese commit." >&2
    return 1
  elif [ "$rc" != 0 ]; then
    return 1
  fi
  ref="$DEPLOY_REGISTRY/$DEPLOY_IMAGE@$digest"
  rev="$(deploy_main_rev)" || return 1
  if [ "$DEPLOY_DRY_RUN" = 1 ]; then
    echo "==> ENSAYO EN SECO: no se toca nada."
    deploy_print_apply_plan "$ref" "$sha" version "$DEPLOY_REMOTE/$DEPLOY_BRANCH"
    return 0
  fi
  deploy_remote --con-compose "$rev" apply "$REMOTE_DIR" "$DEPLOY_SERVICE" "$DEPLOY_ENV_VAR" "$ref" "$sha" version || return 1
}

# deploy_head: deploy normal del HEAD.
deploy_head() {
  local sha platform tagname tag digest rc=0 ref blocked=0
  local repo="$DEPLOY_REGISTRY/$DEPLOY_IMAGE"
  sha="$(git rev-parse HEAD)" || return 1

  platform="$(resolve_docker_platform "$SSH_HOST")" || return 1
  tagname="$(deploy_tag_for_commit "$sha")" || return 1
  tag="$repo:$tagname"
  echo "==> $DEPLOY_SERVICE: commit ${sha:0:12}, imagen $tag, plataforma $platform ($SSH_HOST)"
  if [ "$DEPLOY_DRY_RUN" = 1 ]; then echo "==> ENSAYO EN SECO: no se toca el server ni el registro."; fi

  if ! deploy_require_clean_tree; then
    [ "$DEPLOY_DRY_RUN" = 1 ] || return 1
    blocked=1
  fi
  if ! deploy_require_head_on_main "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"; then
    [ "$DEPLOY_DRY_RUN" = 1 ] || return 1
    blocked=1
  fi
  if [ "$blocked" = 1 ]; then
    echo "==> El deploy real PARARÍA aquí (ver los ERROR de arriba). Sigue el ensayo para enseñar el resto."
  fi

  digest="$(registry_lookup "$tag" "$platform")" || rc=$?
  case "$rc" in
    0)
      echo "==> La imagen ya está en el registro ($digest): se REUTILIZA, sin gate ni build."
      ref="$repo@$digest"
      ;;
    3)
      echo "==> La imagen no está en el registro: se CONSTRUYE y se sube."
      if [ "$DEPLOY_DRY_RUN" = 1 ]; then
        deploy_build_steps
        echo "    docker buildx build --platform $platform -t $tag --metadata-file <tmp> --push $DEPLOY_CONTEXT"
        echo "    huella de --metadata-file, comprobada en el registro"
        ref="$repo@<huella que devuelva el registro tras el push>"
      else
        deploy_prepare_build || return 1
        digest="$(deploy_build_push "$repo" "$tag" "$platform" "$sha")" || return 1
        echo "==> Subida: $tag -> $digest"
        ref="$repo@$digest"
      fi
      ;;
    *)
      if [ "$DEPLOY_DRY_RUN" = 1 ]; then
        echo "==> El deploy real PARARÍA aquí: no se pudo consultar el registro (ver arriba)."
        ref="$repo@<desconocida>"
      else
        return 1
      fi
      ;;
  esac

  if [ "$DEPLOY_DRY_RUN" = 1 ]; then
    deploy_print_apply_plan "$ref" "$sha" desplegar
    return 0
  fi
  is_safe_image_ref "$ref" || {
    echo "ERROR: referencia de imagen no válida: '$ref'." >&2
    return 1
  }
  deploy_remote --con-compose HEAD apply "$REMOTE_DIR" "$DEPLOY_SERVICE" "$DEPLOY_ENV_VAR" "$ref" "$sha" desplegar || return 1
}

# deploy_main <comando> <argumentos…>: punto de entrada de publicar.sh.
deploy_main() {
  local cmd="$1"
  shift
  deploy_parse_args "$@" || {
    deploy_usage "$cmd" >&2
    return 2
  }
  case "$DEPLOY_MODE" in
    ayuda) deploy_usage "$cmd" ;;
    historial) deploy_remote historial "$REMOTE_DIR" "$DEPLOY_SERVICE" || return 1 ;;
    anterior) deploy_rollback || return 1 ;;
    version) deploy_version || return 1 ;;
    desplegar) deploy_head || return 1 ;;
  esac
}
