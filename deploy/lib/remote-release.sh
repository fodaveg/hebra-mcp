#!/usr/bin/env bash
# Lado SERVIDOR del despliegue por registro de imágenes.
#
# No se ejecuta en el Mac ni en Fedora: deploy/lib/deploy-registro.sh lo manda
# entero por SSH (`ssh <host> bash -s`) seguido, si toca, de la función
# `release_compose_content` (el deploy/compose.yml de HEAD u origin/main) y de
# una llamada a `release_main`. Por eso no depende de Node ni de nada del repo,
# solo de bash, coreutils, flock y docker (con compose ≥ 2.17, por
# `up --wait-timeout`). Los tests
# (src/deploy-registro.test.ts) lo `source`an en local con un `docker`
# falso en el PATH.
#
# No usa `set -e`: cada paso que importa comprueba su código a mano, porque
# varias funciones se llaman a la izquierda de `||` o dentro de `if`, donde
# bash no aplica `set -e`.
#
# Estado que mantiene en <dir remoto> (por defecto /srv/hebra-mcp/deploy):
#   - `compose.yml`: el deploy/compose.yml del commit, instalado solo si lee la
#     variable de imagen.
#   - `.env`: la variable de imagen con la referencia por HUELLA
#     (`repo@sha256:...`). Sin ella, compose cae a la etiqueta local de antes del
#     registro. Los SECRETOS los pasa RELEASE_SECRETS_ENV con `--env-file` (puede
#     ser este mismo `.env` o un fichero aparte; release_compose).
#   - `despliegues.log`: historial, una línea por cambio, separada por
#     tabuladores: fecha (UTC) · servicio · acción · sha · referencia nueva ·
#     referencia anterior · detalle. La vuelta atrás busca la línea cuya
#     referencia nueva es la que hay en el .env y vuelve a su anterior.
#   - `despliegues-compose.log`: salida de docker pull/compose de cada
#     despliegue (no se pierde si se corta el SSH).
#
# Variables de entorno que fija el lado local antes de llamar a release_main:
# RELEASE_SECRETS_ENV (ruta del --env-file de secretos, o vacío) y
# RELEASE_CONTAINER (nombre del contenedor, que no es el del servicio).

RELEASE_HISTORY_NAME="despliegues.log"
RELEASE_OUTPUT_NAME="despliegues-compose.log"
# Etiqueta local con la que se conserva, en el primer despliegue por registro,
# la imagen que corría antes (cargada a mano, sin registro). Es el destino de la
# primera vuelta atrás.
RELEASE_TAG_PREVIO="previo-registro"
# Espera de `compose up --wait` y segundos que tiene que aguantar el contenedor
# en marcha sin reinicios para dar el despliegue por bueno.
RELEASE_WAIT_TIMEOUT="${RELEASE_WAIT_TIMEOUT:-120}"
RELEASE_STABLE_SECS="${RELEASE_STABLE_SECS:-5}"

# release_say <mensaje>: mensaje del servidor, marcado para distinguirlo del
# lado local en la salida del deploy. Siempre devuelve 0 (con el SSH cortado,
# escribir falla y no debe cambiar el resultado).
release_say() {
  echo "   [server] $*" 2>/dev/null
  return 0
}

# release_fail <mensaje>: error del servidor a stderr; devuelve 1.
release_fail() {
  echo "   [server] ERROR: $*" >&2 2>/dev/null
  return 1
}

# release_run <dir> <comando…>: ejecuta el comando con su salida al log de
# despliegues del server, no al SSH (si la conexión se corta, docker no debe
# morir al escribir). Devuelve el código del comando.
release_run() {
  local dir="$1"
  shift
  echo "### $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$dir/$RELEASE_OUTPUT_NAME"
  "$@" >>"$dir/$RELEASE_OUTPUT_NAME" 2>&1
}

# release_show_output <dir>: últimas líneas del log de docker, para el error.
release_show_output() {
  tail -n 15 "$1/$RELEASE_OUTPUT_NAME" >&2 2>/dev/null
  return 0
}

# file_mode <fichero>: permisos octales (GNU stat o BSD stat).
file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null
}

# env_get <fichero> <clave>
# Imprime el valor de <clave> en un fichero .env (vacío si no existe el fichero
# o la clave). Si la clave se repite gana la última, como en compose.
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# env_set <fichero> <clave> <valor>
# Deja <clave>=<valor> en el .env conservando el resto de líneas y los permisos
# del fichero (644 si es nuevo). Con valor vacío borra la clave (compose vuelve
# entonces al valor por defecto de deploy/compose.yml). Escribe en un temporal
# del mismo directorio y lo mueve, para que compose nunca lea un .env a medio
# escribir. Si no puede leer el .env (grep sale con 2), no toca nada.
env_set() {
  local file="$1" key="$2" value="$3" tmp mode=644 rc=0
  if [ -f "$file" ]; then
    mode="$(file_mode "$file")" || mode=644
  fi
  tmp="$(mktemp "${file}.XXXXXX")" || return 1
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" >"$tmp" || rc=$?
    if [ "$rc" -gt 1 ]; then
      rm -f "$tmp"
      release_fail "no se pudo leer $file."
      return 1
    fi
  fi
  if [ -n "$value" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$tmp" || {
      rm -f "$tmp"
      return 1
    }
  fi
  chmod "$mode" "$tmp" && mv "$tmp" "$file"
}

# ref_needs_pull <referencia>
# Verdadero (0) si la referencia es por huella (`repo@sha256:...`) y hay que
# bajarla del registro. Una etiqueta local (`senda:previo-registro`, o la que
# deja la vía de emergencia con `docker load`) no se baja: tiene que estar ya en
# el server.
ref_needs_pull() {
  case "$1" in
    *@sha256:*) return 0 ;;
    *) return 1 ;;
  esac
}

# release_history_append <log> <servicio> <acción> <sha> <ref> <anterior> <detalle>
# Añade una línea al historial (campos separados por tabuladores; un campo
# vacío se escribe como `-`). Devuelve distinto de 0 si no pudo escribir.
release_history_append() {
  local log="$1"
  shift
  local fields=() f
  for f in "$@"; do
    fields+=("${f:--}")
  done
  {
    printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '\t%s' "${fields[@]}"
    printf '\n'
  } >>"$log"
}

# release_last_line <log> <servicio>
# Imprime la última línea del historial de ese servicio (nada si no hay). Se
# saltan las de un despliegue fallido (`<acción>-fallido`): tras un fallo se
# restauró lo que corría, así que no cuentan como cambio.
release_last_line() {
  [ -f "$1" ] || return 0
  awk -F '\t' -v s="$2" '$2 == s && $3 !~ /-fallido$/ { l = $0 } END { if (l != "") print l }' "$1"
}

# release_previous_ref <log> <servicio> <ref actual>
# Imprime la referencia anterior (campo 6) de la ÚLTIMA línea válida del
# servicio cuya referencia nueva (campo 5) es <ref actual>, la del .env. Es el
# destino de `--anterior`; dos vueltas atrás seguidas alternan entre las dos
# últimas imágenes, como `cd -`. Devuelve 1 si ninguna línea tiene esa
# referencia (historial desincronizado con el .env).
release_previous_ref() {
  local out
  [ -f "$1" ] || return 1
  out="$(awk -F '\t' -v s="$2" -v r="$3" \
    '$2 == s && $5 == r && $3 !~ /-fallido$/ { x = $6; found = 1 } END { if (found) print x; else exit 1 }' "$1")" || return 1
  echo "$out"
}

# release_sha_for_ref <log> <servicio> <ref>
# Imprime el sha con el que se desplegó <ref> la última vez (o `-` si el
# historial no lo sabe, p. ej. la imagen previa al registro).
release_sha_for_ref() {
  local sha=""
  if [ -f "$1" ]; then
    sha="$(awk -F '\t' -v s="$2" -v r="$3" '$2 == s && $5 == r && $3 !~ /-fallido$/ { x = $4 } END { print x }' "$1")"
  fi
  echo "${sha:--}"
}

# release_lock <dir>
# Un solo despliegue a la vez en el server (dos máquinas desplegando a la vez
# pisarían el .env). flock sobre <dir>/.despliegue.lock; espera hasta 5 min.
# El descriptor 9 queda abierto hasta que acaba el proceso. Sin flock (los
# tests en macOS) no hay candado.
release_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"$1/.despliegue.lock" || return 1
  flock -w 300 9 || release_fail "otro despliegue tiene el candado ($1/.despliegue.lock) desde hace más de 5 min."
}

# Variables de imagen que TIENE que leer el compose.yml que se instala.
# La fija release_main con la variable que recibe el subcomando.
RELEASE_COMPOSE_VARS=""

# release_install_compose <dir>
# Si el lado local mandó el compose.yml (función release_compose_content, el
# deploy/compose.yml de HEAD u origin/main), lo escribe en compose.yml.nuevo,
# comprueba que lee las dos variables de imagen y SOLO entonces lo deja en
# <dir>/compose.yml con un mv. Si no las lee, lo borra y no toca el que había.
# Se llama con el candado cogido.
release_install_compose() {
  local nuevo="$1/compose.yml.nuevo" v
  declare -F release_compose_content >/dev/null 2>&1 || return 0
  release_compose_content >"$nuevo" || {
    rm -f "$nuevo"
    release_fail "no se pudo escribir $nuevo."
    return 1
  }
  for v in $RELEASE_COMPOSE_VARS; do
    grep -q "\${${v}" "$nuevo" || {
      rm -f "$nuevo"
      release_fail "el compose.yml recibido no lee \${${v}}: no se instala ni se despliega."
      return 1
    }
  done
  mv -f "$nuevo" "$1/compose.yml"
}

# release_require_compose_wait: falla si el `docker compose` del server no
# acepta `up --wait-timeout` (release_up lo necesita para saber si el
# contenedor arrancó). Se comprueba antes de tocar nada.
release_require_compose_wait() {
  docker compose up --help 2>/dev/null | grep -q -- --wait-timeout || {
    release_fail "este docker compose no acepta 'up --wait-timeout' (hace falta compose v2.17 o posterior). No se ha tocado nada."
    return 1
  }
}

# release_require_secrets: con RELEASE_SECRETS_ENV, el fichero de secretos tiene
# que existir, ser legible y tener modo 0600 (sin él compose abortaría a medias
# o, peor, arrancaría con un secreto legible por otros). No toca nada.
release_require_secrets() {
  [ -n "${RELEASE_SECRETS_ENV:-}" ] || return 0
  [ -r "$RELEASE_SECRETS_ENV" ] || {
    release_fail "falta $RELEASE_SECRETS_ENV legible. No se ha tocado nada."
    return 1
  }
  [ "$(file_mode "$RELEASE_SECRETS_ENV")" = 600 ] || {
    release_fail "$RELEASE_SECRETS_ENV tiene que tener permisos 0600. No se ha tocado nada."
    return 1
  }
}

# release_trim_output <dir>: deja el log de docker en sus últimas 5000 líneas.
release_trim_output() {
  local f="$1/$RELEASE_OUTPUT_NAME"
  [ -f "$f" ] || return 0
  tail -n 5000 "$f" >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f"
  return 0
}

# release_compose <dir> <argumentos de docker compose…>
# `docker compose` con el `--env-file` de secretos (RELEASE_SECRETS_ENV, si lo
# hay) y la imagen del `.env` de <dir> INYECTADA como variable de entorno. No
# basta con dejarla en el `.env`: un `--env-file` explícito sustituye al `.env`
# del directorio, y el entorno gana sobre cualquier fichero, así que esto
# funciona con cualquier versión de compose. La variable es la que lee
# `image: ${VAR:-…}` del compose.yml (RELEASE_IMAGE_VAR, que fija release_main).
release_compose() {
  local dir="$1" imagen args=()
  shift
  if [ -n "${RELEASE_SECRETS_ENV:-}" ]; then
    args=(--env-file "$RELEASE_SECRETS_ENV")
  fi
  imagen="$(env_get "$dir/.env" "${RELEASE_IMAGE_VAR:-}")"
  if [ -n "$imagen" ]; then
    env "$RELEASE_IMAGE_VAR=$imagen" docker compose ${args[@]+"${args[@]}"} "$@"
  else
    docker compose ${args[@]+"${args[@]}"} "$@"
  fi
}

# release_container_ok <contenedor>
# Verdadero si, tras RELEASE_STABLE_SECS segundos, el contenedor sigue en marcha
# y sin reinicios (un arranque que se cae en bucle no cuenta como desplegado).
release_container_ok() {
  local state
  sleep "$RELEASE_STABLE_SECS"
  state="$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$1" 2>/dev/null)" || return 1
  [ "$state" = "true 0" ] || {
    release_fail "$1 no se queda en marcha (Running/RestartCount: ${state:-?})."
    return 1
  }
}

# release_up <dir> <servicio>
# `docker compose up -d --wait` solo de ese servicio y comprobación de que se
# queda en marcha. Salida al log del server.
release_up() {
  release_run "$1" release_compose "$1" up -d --wait --wait-timeout "$RELEASE_WAIT_TIMEOUT" "$2" || return 1
  release_container_ok "${RELEASE_CONTAINER:-$2}"
}

# release_stop_and_dump <contenedor> <etiqueta>
# Solo con RELEASE_LOG_DIR: para el contenedor (apagado ordenado) y vuelca su
# log comprimido a RELEASE_LOG_DIR (los 30 más recientes). Docker borra el log
# json-file al recrear el contenedor, y parándolo ANTES el volcado lleva
# también las líneas del apagado. Sin contenedor no hace nada.
release_stop_and_dump() {
  local ctr="$1" label="$2" rev file old
  [ -n "${RELEASE_LOG_DIR:-}" ] || return 0
  docker inspect "$ctr" >/dev/null 2>&1 || return 0
  docker stop -t 15 "$ctr" >/dev/null 2>&1 || release_say "AVISO: docker stop del contenedor $label falló."
  rev="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ctr" 2>/dev/null)"
  [[ "$rev" =~ ^[0-9a-f]{40}$ ]] || rev=""
  install -d -m 0700 "$RELEASE_LOG_DIR" || return 0
  file="$RELEASE_LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$label${rev:+-${rev:0:12}}.log.gz"
  if docker logs --timestamps "$ctr" 2>&1 | gzip >"$file"; then
    chmod 0600 "$file"
    release_say "log del contenedor $label: $file"
  else
    release_say "AVISO: no se pudo volcar el log del contenedor $label."
  fi
  { ls -1t "$RELEASE_LOG_DIR"/*.log.gz 2>/dev/null || true; } | tail -n +31 |
    while IFS= read -r old; do rm -f -- "$old"; done
  return 0
}

# release_retire_latest <servicio>
# Transición desde el deploy viejo (docker load de `<servicio>:latest`): tras
# un despliegue por registro que ha salido bien, quita la etiqueta `:latest`
# del server. La imagen sigue viva como `<servicio>:previo-registro` (si no
# existía esa etiqueta, se crea antes). Así un `npm run deploy` viejo desde
# otro checkout falla al no encontrar la imagen de un servicio, en vez de
# recrearlo con la antigua. Si `:previo-registro` apunta a otra imagen, no
# toca nada (alguien ha cargado una `:latest` nueva) y avisa.
release_retire_latest() {
  local latest="$1:latest" previo="$1:$RELEASE_TAG_PREVIO" id idp
  id="$(docker image inspect --format '{{.Id}}' "$latest" 2>/dev/null)" || return 0
  [ -n "$id" ] || return 0
  if idp="$(docker image inspect --format '{{.Id}}' "$previo" 2>/dev/null)"; then
    if [ "$idp" != "$id" ]; then
      release_say "AVISO: $latest ($id) no es la imagen de $previo ($idp); no se retira."
      return 0
    fi
  else
    docker tag "$id" "$previo" || return 1
  fi
  docker image rm "$latest" >/dev/null 2>&1 || return 1
  release_say "Retirada la etiqueta $latest del server (la imagen sigue como $previo)."
  return 0
}

# release_apply <dir> <servicio> <variable> <ref> <sha> <acción>
# Despliega <ref> como imagen de <servicio>. Se llama con el candado cogido
# (release_main):
#   1. Si la variable aún no existe en el .env (primer despliegue por registro),
#      etiqueta la imagen del contenedor que corre como
#      `<servicio>:previo-registro` y la apunta como anterior, con su
#      `.Config.Image`, el id de la imagen y el del contenedor.
#   2. Baja la imagen (si es por huella) ANTES de tocar el .env: si el registro
#      falla, no ha cambiado nada.
#   3. Escribe el .env, `compose up -d --wait <servicio>` y comprueba que se
#      queda en marcha; si no, restaura el valor anterior, lo vuelve a levantar
#      y apunta `<acción>-fallido`.
#   4. Apunta el cambio en el historial y retira la etiqueta `:latest` vieja.
# Si el .env ya apunta a <ref> (repetición, o un despliegue anterior cortado
# entre el .env y el historial), solo asegura que corre y, si el historial no
# lo refleja, escribe una línea `reconciliar`.
release_apply() {
  local dir="$1" servicio="$2" var="$3" ref="$4" sha="$5" accion="$6"
  local envf="$dir/.env" log="$dir/$RELEASE_HISTORY_NAME"
  local actual anterior detalle info cfg img cid tag last ctr="${RELEASE_CONTAINER:-$servicio}"

  cd "$dir" || {
    release_fail "no existe $dir"
    return 1
  }
  docker network inspect edge >/dev/null 2>&1 || {
    release_fail "no existe la red externa 'edge' (la crea fodaveg/edge-infra)."
    return 1
  }
  # Un compose.yml viejo (con `image: senda:latest` fijo) ignoraría el .env y
  # el deploy «saldría bien» sin cambiar de imagen.
  grep -q "\${${var}" "$dir/compose.yml" 2>/dev/null || {
    release_fail "$dir/compose.yml no lee \${${var}}: sube el deploy/compose.yml actual."
    return 1
  }

  actual="$(env_get "$envf" "$var")"
  if [ "$actual" = "$ref" ]; then
    release_say "El .env ya apunta $servicio a $ref: se asegura que corre, sin cambiar nada."
    last="$(release_last_line "$log" "$servicio" | awk -F '\t' '{ print $5 }')"
    if [ "$last" != "$ref" ]; then
      anterior="$last"
      if [ -z "$anterior" ] && docker image inspect "${ctr}:${RELEASE_TAG_PREVIO}" >/dev/null 2>&1; then
        anterior="${ctr}:${RELEASE_TAG_PREVIO}"
      fi
      release_history_append "$log" "$servicio" reconciliar "$sha" "$ref" "$anterior" \
        "el .env ya tenía esta imagen y el historial no" || {
        release_fail "no se pudo escribir el historial ($log)."
        return 1
      }
      release_say "Historial reconciliado: ${anterior:--} -> $ref."
    fi
    release_up "$dir" "$servicio" || {
      release_show_output "$dir"
      return 1
    }
    release_retire_latest "$ctr" || release_say "AVISO: no se pudo retirar ${ctr}:latest."
    return 0
  fi

  if [ -n "$actual" ]; then
    anterior="$actual"
    detalle="-"
  elif info="$(docker inspect --format '{{.Config.Image}} {{.Image}} {{.Id}}' "$ctr" 2>/dev/null)"; then
    # Primer despliegue por registro: lo que corre hoy (cargado a mano) queda
    # como vuelta atrás con una etiqueta propia, por si alguien retoca
    # `<contenedor>:latest` después.
    read -r cfg img cid <<<"$info"
    tag="${ctr}:${RELEASE_TAG_PREVIO}"
    docker tag "$img" "$tag" || {
      release_fail "no se pudo etiquetar la imagen actual ($img) como $tag."
      return 1
    }
    anterior="$tag"
    detalle="previo=$cfg imagen=$img contenedor=${cid:0:12}"
    release_say "Primer despliegue por registro: la imagen actual ($cfg, $img) queda como $tag para volver atrás."
  else
    anterior="-"
    detalle="sin contenedor previo"
  fi

  if ref_needs_pull "$ref"; then
    release_say "Bajando $ref…"
    if ! release_run "$dir" docker pull "$ref"; then
      # Sin registro (caído) todavía vale si la imagen sigue en el server,
      # p. ej. al volver atrás a una huella ya desplegada antes.
      if docker image inspect "$ref" >/dev/null 2>&1; then
        release_say "El registro no responde, pero $ref ya está en el server: se usa esa."
      else
        release_show_output "$dir"
        release_fail "no se pudo bajar $ref y no está en el server. No se ha tocado nada."
        return 1
      fi
    fi
  elif ! docker image inspect "$ref" >/dev/null 2>&1; then
    release_fail "la imagen $ref ya no está en el server. No se ha tocado nada."
    return 1
  fi

  env_set "$envf" "$var" "$ref" || {
    release_fail "no se pudo escribir $envf. No se ha tocado nada más."
    return 1
  }
  release_stop_and_dump "$ctr" saliente
  if ! release_up "$dir" "$servicio"; then
    release_show_output "$dir"
    release_stop_and_dump "$ctr" fallido
    release_say "El despliegue ha fallado: se restaura ${var}=${actual:-<sin valor>} y se vuelve a levantar."
    env_set "$envf" "$var" "$actual" || release_fail "¡no se pudo restaurar $envf! Revísalo a mano."
    release_up "$dir" "$servicio" || release_fail "$servicio tampoco arranca con la imagen anterior: revísalo a mano."
    release_history_append "$log" "$servicio" "${accion}-fallido" "$sha" "$ref" "$anterior" "$detalle" ||
      release_fail "no se pudo escribir el historial ($log)."
    return 1
  fi
  release_history_append "$log" "$servicio" "$accion" "$sha" "$ref" "$anterior" "$detalle" || {
    release_fail "$servicio corre $ref pero no se pudo escribir el historial ($log): --anterior no lo verá. Repite el deploy para reconciliar."
    return 1
  }
  release_retire_latest "$ctr" || release_say "AVISO: no se pudo retirar ${ctr}:latest."
  release_say "$servicio: ${anterior} -> ${ref}"
  release_compose "$dir" ps "$servicio" 2>/dev/null
  return 0
}

# release_rollback <dir> <servicio> <variable>
# Vuelve a la imagen que corría antes de la que hay en el .env, según el
# historial, sin registro ni build si ya está en el server. Falla sin tocar
# nada si el .env no tiene imagen, si el historial no sabe de dónde salió
# (desincronizado), o si la anterior era la previa al registro y alguien la ha
# borrado. Se llama con el candado cogido.
release_rollback() {
  local dir="$1" servicio="$2" var="$3"
  local log="$dir/$RELEASE_HISTORY_NAME" actual anterior sha

  actual="$(env_get "$dir/.env" "$var")"
  if [ -z "$actual" ]; then
    release_fail "$dir/.env no tiene $var: $servicio aún no se ha desplegado por registro, no hay a dónde volver."
    return 1
  fi
  anterior="$(release_previous_ref "$log" "$servicio" "$actual")" || {
    release_fail "historial desincronizado: ninguna línea de $servicio en $log tiene como imagen nueva la del .env ($actual). Vuelve a un commit concreto con --version <sha>."
    return 1
  }
  if [ -z "$anterior" ] || [ "$anterior" = "-" ]; then
    release_fail "el historial ($log) no tiene una imagen anterior a $actual para $servicio."
    return 1
  fi
  if ! ref_needs_pull "$anterior" && ! docker image inspect "$anterior" >/dev/null 2>&1; then
    release_fail "la imagen anterior de $servicio ($anterior) ya no está en el server, y como no viene del registro no se puede bajar. Vuelve a un commit concreto con --version <sha> (tiene que estar en el registro)."
    return 1
  fi
  sha="$(release_sha_for_ref "$log" "$servicio" "$anterior")"
  release_apply "$dir" "$servicio" "$var" "$anterior" "$sha" anterior
}

# release_state <dir> <servicio> <variable>
# Solo lectura (ensayo en seco): imprime líneas clave=valor con la referencia
# actual del .env, la del contenedor que corre, el destino de --anterior y la
# última línea del historial.
release_state() {
  local dir="$1" servicio="$2" var="$3" log="$1/$RELEASE_HISTORY_NAME" actual anterior ctr="${RELEASE_CONTAINER:-$2}"
  actual="$(env_get "$dir/.env" "$var")"
  echo "actual=$actual"
  echo "contenedor=$(docker inspect --format '{{.Config.Image}} {{.Image}} {{.Id}}' "$ctr" 2>/dev/null)"
  if [ -n "$actual" ] && anterior="$(release_previous_ref "$log" "$servicio" "$actual")"; then
    echo "anterior=$anterior"
  elif [ -n "$actual" ]; then
    echo "anterior=<desincronizado>"
  else
    echo "anterior="
  fi
  echo "ultima=$(release_last_line "$log" "$servicio")"
}

# release_history <dir> <servicio> [n]
# Imprime las últimas <n> (20) líneas del historial de ese servicio.
release_history() {
  local log="$1/$RELEASE_HISTORY_NAME"
  if [ ! -f "$log" ]; then
    release_say "aún no hay historial ($log)."
    return 0
  fi
  awk -F '\t' -v s="$2" '$2 == s' "$log" | tail -n "${3:-20}"
}

# release_main <subcomando> <argumentos…>
# Punto de entrada que llama deploy-registro.sh por SSH:
#   apply     <dir> <servicio> <variable> <ref> <sha> <acción>
#   anterior  <dir> <servicio> <variable>
#   estado    <dir> <servicio> <variable>
#   historial <dir> <servicio>
# Para apply y anterior: ignora HUP, PIPE e INT (si se corta el SSH, la parte
# crítica termina igual), coge el candado ANTES de leer nada, comprueba que
# compose acepta --wait-timeout, instala el compose.yml recibido dentro de la
# sección con candado y, al acabar, recorta el log de docker.
release_main() {
  local sub="$1" rc
  shift
  case "$sub" in
    apply | anterior)
      # Los tres argumentos comunes son <dir> <servicio> <variable>.
      RELEASE_IMAGE_VAR="$3"
      RELEASE_COMPOSE_VARS="$3"
      trap '' HUP PIPE INT
      mkdir -p "$1" || {
        release_fail "no se pudo crear $1"
        return 1
      }
      release_lock "$1" || return 1
      release_require_compose_wait || return 1
      release_require_secrets || return 1
      release_install_compose "$1" || return 1
      if [ "$sub" = apply ]; then
        release_apply "$@"
      else
        release_rollback "$@"
      fi
      rc=$?
      release_trim_output "$1"
      return "$rc"
      ;;
    estado) release_state "$@" ;;
    historial) release_history "$@" ;;
    *)
      release_fail "subcomando desconocido: '$sub'"
      return 1
      ;;
  esac
}
