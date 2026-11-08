#!/usr/bin/env bash
# Deducción de la plataforma de Docker según la arquitectura del servidor de
# destino. Lo `source` deploy/lib/deploy-registro.sh.

# platform_from_uname <salida de `uname -m`>
# Imprime la plataforma de buildx: x86_64 -> linux/amd64; aarch64|arm64 ->
# linux/arm64. Cualquier otro valor: mensaje a stderr y código 1.
platform_from_uname() {
  case "$1" in
    x86_64) echo "linux/amd64" ;;
    aarch64 | arm64) echo "linux/arm64" ;;
    *)
      echo "ERROR: arquitectura de servidor no soportada: '$1' (esperaba x86_64, aarch64 o arm64). Fuerza la plataforma con DOCKER_PLATFORM." >&2
      return 1
      ;;
  esac
}

# resolve_docker_platform <host ssh>
# Si DOCKER_PLATFORM está puesta, la respeta; si no, la deduce con
# `ssh <host> uname -m`. Se llama al principio del script (antes del gate)
# para fallar pronto si el host no responde. Imprime la plataforma.
resolve_docker_platform() {
  if [ -n "${DOCKER_PLATFORM:-}" ]; then
    echo "$DOCKER_PLATFORM"
    return 0
  fi
  local arch
  arch="$(ssh "$1" uname -m)" || {
    echo "ERROR: no se pudo consultar la arquitectura de '$1' por SSH." >&2
    return 1
  }
  platform_from_uname "$arch"
}
