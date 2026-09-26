# Imagen del transporte HTTP remoto de hebra-mcp (mcp.hebra.pro, SPEC.md §12.5,
# lote C4). `dist/` NO viaja en el repo (está en `.gitignore`, a diferencia de
# lumbre-mcp): esta imagen NO compila TypeScript, solo instala dependencias de
# producción y copia el `dist/` que se sube por `rsync` desde el Mac (el
# servidor no puede clonar `vendor/hebra`, el submódulo privado). Si `dist/` no
# trae `cli.mjs` con el subcomando `serve-http` (C2, `src/server/main.ts`),
# recompílalo (`npm run build`) y súbelo ANTES de reconstruir la imagen — ver
# `deploy/README-deploy.md`.
#
# Nombres de subcomandos y variables: confirmados contra `src/server/main.ts`,
# `src/http/config.ts` y `src/oauth/cli.ts` (rama `c2-c3-serve-http-oauth`,
# integrada en C4 el 26 sep 2026).
#
# Digest fijado (índice multi-arch, `docker buildx imagetools inspect
# node:24-alpine`, medido el 26 sep 2026):
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Solo dependencias de producción. `@napi-rs/keyring` queda instalado (está en
# `dependencies`, no hay un `--omit` selectivo por paquete) pero en modo
# fichero (§12.3, C1) el código no lo carga: aquí no hay Secret Service ni
# sentido en tenerlo activo.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# Usuario sin root: el `node` de la imagen base de Alpine (uid/gid 1000). El
# volumen de datos se prepara con ese ownership en el runbook
# (`chown -R 1000:1000` sobre el volumen) ANTES del primer arranque; si el
# volumen queda con otro dueño, el contenedor no podrá escribir la SQLite ni
# los secretos de fichero y se verá como un fallo de healthcheck, no como un
# permiso denegado explícito en `docker logs`.
RUN chown -R node:node /app
USER node

# `HEBRA_MCP_HTTP_LISTEN` por defecto es `127.0.0.1` (`src/http/config.ts`,
# pensado para tests y desarrollo local): en ESTE contenedor tiene que ser
# `0.0.0.0`, o Caddy no podría alcanzarlo por la red `edge` (127.0.0.1 dentro
# de un contenedor es su propio netns, inalcanzable desde otro contenedor
# aunque estén en la misma red Docker). Repetido en `compose.yml` de forma
# explícita; se fija también aquí para que la imagen nunca arranque con el
# valor por defecto equivocado si alguna vez se ejecuta sin ese `environment:`.
ENV HEBRA_MCP_HTTP_LISTEN=0.0.0.0
ENV HEBRA_MCP_HTTP_PORT=8787
EXPOSE 8787

# `/healthz` responde 204 sin cuerpo y sin autenticación (`src/http/app.ts`).
# `wget --spider` da como bueno cualquier 2xx, así que un 204 basta. `wget` es
# el applet de BusyBox que ya trae la imagen base (no hace falta instalar
# nada), igual que en lumbre-mcp.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget --quiet --spider "http://127.0.0.1:${HEBRA_MCP_HTTP_PORT}/healthz" || exit 1

# Subcomando confirmado por SPEC.md §12.1/§12.8: `serve-http`. Sin flags de
# Node peligrosos (sin `--inspect`, sin `--experimental-*`).
CMD ["node", "dist/cli.mjs", "serve-http"]
