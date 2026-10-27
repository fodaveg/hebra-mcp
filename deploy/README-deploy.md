# Deploy del transporte HTTP remoto (`mcp.hebra.pro`, SPEC.md §12, lote C4)

C1 (secretos en fichero) y C2 (`serve-http`) conservan su transporte. El OAuth público
C3 cambia la aprobación al login y consentimiento de Lumbre (SPEC.md §12.2).
El cambio se desplegó el 28 sep 2026 con Hebra MCP `e36e72a` y broker Lumbre
`dfdc34f`. El inicio OAuth público DCR + PKCE llega al consentimiento de Lumbre;
la reconexión y QA de Claude por David siguen pendientes. Ver [RELEASE-2026-09-28.md](RELEASE-2026-09-28.md).

El soporte OAuth de Codex admite su CIMD oficial exacto
`https://chatgpt.com/oauth/codex/client.json` y DCR con los clientes fijos
`hebra-mcp-codex-127`, `hebra-mcp-codex-localhost` y `hebra-mcp-codex-loopback`.
Mistral Vibe (el CLI de Mistral) entra por DCR restringido como Claude: un registro
con `client_name` «Mistral Vibe» y callbacks nativos
`http://127.0.0.1:<puerto>/callback` (puerto por defecto 47823, nunca `localhost`)
se reduce al cliente fijo `hebra-mcp-vibe` con redirect `http://127.0.0.1/callback`
(SPEC.md §12.2). Para conectarlo: `vibe mcp add hebra --url https://mcp.hebra.pro/mcp --transport streamable-http`.
Su callback es local HTTP, host `127.0.0.1` o `localhost`, ruta `/callback` y puerto
dinámico; los demás componentes son exactos. El callback entre Lumbre y Hebra MCP
sigue siendo `https://mcp.hebra.pro/oauth/lumbre/callback`. Publicar requiere que
el validador del broker Lumbre acepte esas mismas identidades; las pruebas locales
no prueban publicación, login real ni acceso a la biblioteca en producción.

## Variables y subcomandos (confirmados)

Único sitio donde se explican. `Dockerfile`, `compose.yml` y
`mcp-hebra-pro.caddy` los usan tal cual están aquí.

| Nombre | Qué es | Por defecto | Fuente |
|---|---|---|---|
| `serve-http` | Subcomando que arranca el transporte HTTP | — | `src/server/main.ts` |
| `oauth-set-secret` | Comando retirado: falla con mensaje de método sustituido | — | `src/oauth/cli.ts` |
| `oauth-revoke-all` | Subcomando que revoca todos los tokens vigentes | — | `src/oauth/cli.ts` |
| `/healthz` | Ruta de liveness, sin autenticación, responde **204 sin cuerpo** | — | `src/http/app.ts` |
| `/mcp` | Ruta del transporte Streamable HTTP (`POST`; `GET`/`DELETE` dan 405) | — | `src/http/app.ts` |
| `HEBRA_MCP_DATA_DIR` | Directorio de datos: SQLite, privados, secretos, `oauth-revocations-v2.json` y `oauth-tokens.json` | ninguno (obligatorio en el contenedor) | `src/privacy/data-dir.ts` |
| `HEBRA_MCP_DATA_DEVICE` | Directorio del host, en el volumen cifrado del servidor, que se monta en `/data` (bind del volumen `hebra-mcp_data`). Vive en el `deploy/.env` del servidor, nunca en el repo | ninguno (obligatorio) | `deploy/compose.yml` |
| `HEBRA_MCP_BACKCHANNEL_SECRET` | Bearer exclusivo de Hebra MCP, compartido con el broker Lumbre; 32–512 caracteres, sin CR/LF | ninguno (obligatorio) | `src/oauth/http-auth.ts` |
| `HEBRA_MCP_SECRET_STORE` | Modo del almacén de secretos: `keychain` o `file`, selección EXPLÍCITA, nunca fallback | `keychain` (aquí se fija `file`) | `src/secrets/store-mode.ts` |
| `HEBRA_MCP_HTTP_LISTEN` | Interfaz de escucha | `127.0.0.1` (aquí se fija `0.0.0.0`, o Caddy no llegaría por la red `edge`) | `src/http/config.ts` |
| `HEBRA_MCP_HTTP_PORT` | Puerto de escucha | `8787` | `src/http/config.ts` |
| `HEBRA_MCP_PUBLIC_URL` | Origen público: issuer OAuth y base del recurso (`<origen>/mcp`) | `https://mcp.hebra.pro` | `src/http/config.ts` |
| `LUMBRE_APP_ORIGIN` | Origen de Lumbre: destino del backchannel y único origen admitido en la URL de consentimiento. Tiene que ser el mismo que Lumbre usa para construirla (`ORIGIN` o uno de `LUMBRE_PUBLIC_ORIGINS`); `https` sin ruta, query ni credenciales (`http` solo en loopback). Uno inválido impide arrancar | `https://app.lumbre.pro` | `src/oauth/backchannel.ts` |
| `HEBRA_MCP_LOGIN_PROVIDER` | Quién identifica a la persona en `/authorize` (D20, SPEC.md §12.9): `lumbre` (login y consentimiento de Lumbre, §12.2) o `sumego` (cliente OIDC propio en Sumego y consentimiento en hebra-mcp). Otro valor impide arrancar; con `sumego` y el cliente incompleto tampoco arranca, nunca vuelve en silencio a `lumbre` | `lumbre` | `src/oauth/login-config.ts` |
| `HEBRA_MCP_OIDC_ISSUER` | Issuer de Sumego; su discovery (`/.well-known/openid-configuration`) da los endpoints y el JWKS. Solo admite, escrito exactamente así, `https://id.lumbre.pro` o `https://id.sumego.es` (transición de §13.6 de la SPEC de Sumego); otro valor, también con barra final, mayúsculas, puerto o ruta, impide arrancar. El servidor acepta solo el configurado y no sigue redirecciones; las URI de callback y de logout no cambian con él | `https://id.lumbre.pro` | `src/oauth/login-config.ts` |
| `HEBRA_MCP_OIDC_CLIENT_ID` | Cliente confidencial de hebra-mcp en Sumego | `hebra-mcp` | `src/oauth/login-config.ts` |
| `HEBRA_MCP_OIDC_CLIENT_SECRET` | Secreto de ese cliente (`client_secret_basic`); 32–512 caracteres, sin CR/LF. Vive SOLO en el `deploy/.env` del servidor. Obligatorio con `sumego`; con `lumbre`, si está, monta el back-channel logout | ninguno | `src/oauth/login-config.ts` |

No existe una variable `PORT` genérica ni un subcomando
`oauth-set-owner-secret`: eran nombres de trabajo del primer borrador de este
runbook, sustituidos ahora por los reales.

## Cómo va a estar montado

| Pieza | Dónde | Qué |
|---|---|---|
| Servicio | un directorio propio en el VPS de Lumbre (mismo servidor que `lumbre-app` y `lumbre-mcp`) | copia de `dist/`, `package.json`, `package-lock.json` y `deploy/`, subida por `rsync` |
| Contenedor | `hebra-mcp` | `node dist/cli.mjs serve-http`, escucha en 8787, usuario sin root |
| Borde | `mcp-hebra-pro.caddy` en el `conf.d` del Caddy compartido (`/srv/edge` del VPS, el mismo borde que ya sirve Lumbre, Vega, fodaveg y las demos) | Caddy termina TLS y hace proxy, sin exponer `/healthz` |
| Estado | volumen `hebra-mcp_data` en bind a `HEBRA_MCP_DATA_DEVICE`, en el volumen cifrado del servidor | SQLite, `config.json` de privados, secretos de fichero (C1) y store OAuth (C3), todo en el mismo directorio |

El contenedor **no publica puertos al host**: Caddy lo alcanza por el DNS de
la red Docker externa `edge` (`hebra-mcp:8787`), igual que `lumbre-app` y
`lumbre-mcp`. El único camino de entrada es HTTPS por el borde.

`vendor/hebra` es un submódulo **privado** (`git@github.com:fodaveg/hebra.git`):
el servidor no lo puede clonar con la clave de despliegue que tenga (si
tuviera alguna), así que el flujo de publicación nunca hace `git clone` ni
`git pull` de este repo en el servidor — sube `dist/` ya compilado. Por el
mismo motivo, la imagen no se publica en ningún registro: lleva código de
Hebra empaquetado dentro de `dist/`.

### `trust proxy` y la IP real del cliente (auditoría de seguridad, 26 sep 2026)

`src/http/app.ts` hace `app.set('trust proxy', 'loopback, uniquelocal')`: solo
confía en `X-Forwarded-For` cuando el salto inmediato (el peer TCP visto por
Node) es loopback o de red privada. Verificado con una consulta de solo
lectura al servidor:

```
$ ssh lumbre 'docker network inspect edge --format "{{json .IPAM.Config}}"'
[{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]
```

`172.19.0.0/16` cae dentro de `172.16.0.0/12` (RFC 1918): el preset
`uniquelocal` de Express la reconoce como privada, así que el único salto que
`trust proxy` va a aceptar es el propio Caddy del borde compartido — no un
tercero que se cuele en la red `edge`.

Lo que **no** se pudo reverificar en esta pasada (el sandbox denegó tanto un
`ssh lumbre 'cat /srv/edge/Caddyfile'` como una consulta DNS pública, las dos
como "Production Reads", después de que la consulta de arriba sí se hubiera
permitido) es si el bloque global `/srv/edge/Caddyfile` define
`trusted_proxies` y si hay algo delante de Caddy (Cloudflare u otro CDN) que
pudiera inyectar su propio `X-Forwarded-For`. Lo que sí hay evidencia pública
de este mismo VPS (SPEC.md §12.5: `mcp.hebra.pro` "ya resuelve a
135.181.157.147", la IP del servidor, directamente; el README de `lumbre-mcp`,
público, documenta el mismo borde sin mencionar ningún CDN ni
`trusted_proxies`) apunta a que Caddy es el único salto y que, sin
`trusted_proxies` configurado, sobrescribe cualquier `X-Forwarded-For`
entrante con la IP real de quien conecta — el comportamiento por defecto de
Caddy 2.5+.

Por si ese default cambiara o algún día se añadiera `trusted_proxies` al
bloque global sin pensar en este sitio, `deploy/mcp-hebra-pro.caddy` fija de
forma EXPLÍCITA `header_up X-Forwarded-For {remote_host}` en el
`reverse_proxy`, para no depender de un comportamiento implícito. **Pendiente
de reverificar** con acceso de lectura al Caddyfile global antes de dar esto
por cerrado del todo.

## Cómo se entra al servidor (privado, no hardcodear aquí)

Este repo es **público**. El alias SSH real, el usuario y la ruta exacta de
`/srv/...` en el VPS **no van en este fichero**: quien despliegue los conoce
por su propio `~/.ssh/config` o los recibe fuera de este repo. Los comandos de
abajo usan variables genéricas:

```bash
# Ejemplo de valores (sustituir por los reales del operador):
HEBRA_MCP_HOST=usuario@servidor   # o un alias de ~/.ssh/config
HEBRA_MCP_DEST=/srv/hebra-mcp     # destino en el VPS, mismo patrón que lumbre-mcp
EDGE_CONFD=/srv/edge/conf.d       # conf.d del Caddy compartido
```

## Publicar una versión nueva

1. Compilar en el Mac (donde SÍ está el submódulo `vendor/hebra`; desde D18, también
   `vendor/jdex-manager`, público: `git submodule update --init` los trae los dos, y el
   motor JD queda dentro de `dist/` igual que el código de Hebra):

   ```bash
   npm run build
   npm run check:bundle   # falla si dist/ no coincide con lo commiteado en src/
   ```

2. Subir por `rsync` solo lo que hace falta — nunca `src/`, nunca
   `vendor/hebra`, nunca `node_modules/`:

   ```bash
   rsync -az --delete --exclude=.env \
     dist deploy package.json package-lock.json \
     "$HEBRA_MCP_HOST:$HEBRA_MCP_DEST/"
   ```

   `dist` y `deploy` van SIN barra final: con `dist/`, `rsync` copia el
   contenido suelto en la raíz del destino y el `COPY dist/` del Dockerfile no
   lo encuentra (visto al preparar el primer despliegue, 26 sep 2026).

   El `--delete` es intencional: si un despliegue anterior dejó un fichero de
   `dist/` que ya no existe, no debe seguir sirviéndose. `--exclude=.env`
   protege `deploy/.env`, provisionado solo en el servidor, tanto de la copia
   como de la eliminación. No aplicar `--delete` sobre nada que no sea el
   árbol que gestiona este `rsync`.

3. Preparar el directorio de datos la PRIMERA vez. El estado vive en un volumen
   cifrado del servidor, no en el volumen sin cifrar de Docker. Con ese volumen
   cifrado YA montado, crear el directorio con dueño 1000:1000 (el contenedor
   corre con `USER node`; sin esto, el arranque falla al intentar escribir la
   SQLite o los secretos de fichero, y eso se ve como un healthcheck en rojo,
   no como un permiso denegado explícito) y modo 0700, y apuntarlo en
   `deploy/.env`. `HEBRA_MCP_DATA_DEVICE` es la ruta de ese directorio en el
   servidor (no se versiona):

   ```bash
   # En el servidor, con HEBRA_MCP_DATA_DEVICE=<directorio dentro del volumen cifrado>
   # chown numérico: `install -o 1000` falla si el host no tiene un usuario 1000 (medido el 19 oct 2026)
   sudo mkdir -m 0700 "$HEBRA_MCP_DATA_DEVICE" && sudo chown 1000:1000 "$HEBRA_MCP_DATA_DEVICE"
   # deploy/.env es de root y 0600: `>>` sin sudo no puede escribirlo
   echo "HEBRA_MCP_DATA_DEVICE=$HEBRA_MCP_DATA_DEVICE" | sudo tee -a "$HEBRA_MCP_DEST/deploy/.env" >/dev/null
   ```

   Si el volumen cifrado no está montado al arrancar (crypttab con `nofail`),
   el directorio no existe y Docker no puede hacer el bind: el contenedor NO
   arranca. Es lo buscado, porque arrancar sobre un directorio vacío crearía
   una biblioteca nueva sin emparejado. Por eso NUNCA se crea ese directorio
   a mano sin el volumen montado: se montaría el cifrado encima después y los
   datos quedarían ocultos en el disco sin cifrar.

4. Construir y levantar. En el servidor se guardan como mucho dos imágenes: la
   actual (`hebra-mcp:latest`) y una para volver atrás (`hebra-mcp:previous`).
   El disco del sistema del VPS es pequeño y no se puede ampliar (19 oct 2026):
   antes de construir, la imagen en uso pasa a `previous`; después se borran
   las imágenes de este proyecto que se quedaron sin etiqueta (la `previous`
   anterior y las de builds intermedias). El filtro por la etiqueta de compose
   deja fuera las imágenes de los demás servicios:

   ```bash
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     { ! docker image inspect hebra-mcp:latest >/dev/null 2>&1 || \
       docker tag hebra-mcp:latest hebra-mcp:previous; } && \
     docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build && \
     docker image prune -f --filter label=com.docker.compose.project=hebra-mcp"
   ```

   Volver atrás: `docker tag hebra-mcp:previous hebra-mcp:latest` y
   `docker compose --env-file deploy/.env -f deploy/compose.yml up -d --no-build`.
   Solo sirve si la versión anterior lee el estado que dejó la nueva (SQLite y
   ficheros de planes); no se guardan imágenes más viejas porque volver
   semanas atrás sobre datos de hoy no es una vuelta atrás segura.

   Antes de este paso, provisionar `HEBRA_MCP_BACKCHANNEL_SECRET` en
   `deploy/.env` privado con el mismo valor que el broker Lumbre. También se
   puede ejecutar desde `deploy/` con `--env-file .env`. `compose.yml` exige
   su presencia; el valor no se copia al repositorio. El dispositivo remoto ya
   debe estar emparejado mediante el procedimiento C5. Si falta configuración,
   `serve-http` sale cerrado.

   Login con Sumego (D20, SPEC.md §12.9): el interruptor va en `lumbre` por
   defecto, así que este código se puede publicar antes de que exista el
   cliente en Sumego. Para pasar a `sumego`, añadir al `deploy/.env` privado
   `HEBRA_MCP_LOGIN_PROVIDER=sumego` y `HEBRA_MCP_OIDC_CLIENT_SECRET=<secreto
   del cliente hebra-mcp en Sumego>` (y `HEBRA_MCP_OIDC_ISSUER` o
   `HEBRA_MCP_OIDC_CLIENT_ID` solo si no son los de por defecto), con `sudo tee
   -a` como el resto del fichero, y recrear el contenedor. Volver a `lumbre` es
   quitar o cambiar esa línea. Las dos piezas de Lumbre (`identityProvider` en
   `/requests` y `sumego/exchange`) tienen que estar desplegadas antes de pasar
   a `sumego`. Con cliente configurado, el primer arranque crea en el almacén
   de secretos (`HEBRA_MCP_SECRET_STORE=file`, dentro de `/data`) la clave
   `hebra-mcp-sumego-refresh-key`, con la que se cifran los refresh de Sumego
   de `oauth-tokens.json`. Si se pierde, las familias de Sumego se cortan en su
   siguiente renovación horaria y hay que volver a conectar.

   `oauth-tokens.json` pasa a v3 con esta versión (lee un v2 y escribe v3). Una
   versión anterior no lee un v3: volver a la imagen `previous` después de
   arrancar esta corta todas las familias OAuth y Claude y Codex tienen que
   volver a conectar (las notas, el emparejado y la clave no se tocan).

5. Comprobar salud y el recorrido de consentimiento y revocación real antes de
   dar la publicación por buena.

**No hay `git pull` en el servidor**, por el submódulo privado (ver arriba). Si
algún día se decide clonar el árbol público sin `vendor/hebra` y compilar en el
propio VPS, este paso cambiaría; hoy no es el caso.

## Migración al volumen cifrado (19 oct 2026)

Para pasar un despliegue existente del volumen Docker sin cifrar al directorio
del volumen cifrado. Con el volumen cifrado montado y `HEBRA_MCP_DATA_DEVICE`
ya creado como en el paso 3 de arriba (dueño 1000:1000, modo 0700):

1. Parar el contenedor. El apagado ordenado vuelca el WAL al cerrar la SQLite;
   no copiar nunca con el contenedor en marcha:

   ```bash
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     docker compose --env-file deploy/.env -f deploy/compose.yml stop"
   ```

2. Copiar el contenido del volumen viejo conservando dueño y modos, y
   comparar las sumas sha256 de los dos lados (la lista debe ser idéntica):

   ```bash
   OLD=$(ssh "$HEBRA_MCP_HOST" "docker volume inspect hebra-mcp_data --format '{{.Mountpoint}}'")
   ssh "$HEBRA_MCP_HOST" "sudo cp -a '$OLD'/. \"$HEBRA_MCP_DATA_DEVICE\"/"
   ssh "$HEBRA_MCP_HOST" "cd '$OLD' && sudo find . -type f -exec sha256sum {} + | sort -k2" > /tmp/viejo.sha
   ssh "$HEBRA_MCP_HOST" "cd \"$HEBRA_MCP_DATA_DEVICE\" && sudo find . -type f -exec sha256sum {} + | sort -k2" > /tmp/nuevo.sha
   diff /tmp/viejo.sha /tmp/nuevo.sha && echo IGUAL
   ```

3. Apartar la copia vieja y recrear el volumen. El `docker volume rm` borra el
   contenido del volumen viejo, así que antes se aparta una copia (a un
   directorio privado, modo 0700, fuera del volumen cifrado: es la única copia
   sin cifrar y se borra en el paso 5). Compose no cambia las opciones de un
   volumen ya creado, por eso hay que eliminar el viejo para que se recree en
   bind:

   ```bash
   ssh "$HEBRA_MCP_HOST" "sudo install -d -m 0700 \"$HEBRA_MCP_DEST.viejo\" && \
     sudo cp -a '$OLD'/. \"$HEBRA_MCP_DEST.viejo\"/"
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     docker compose --env-file deploy/.env -f deploy/compose.yml rm -f && \
     docker volume rm hebra-mcp_data"
   ```

4. Levantar y comprobar:

   ```bash
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     docker compose --env-file deploy/.env -f deploy/compose.yml up -d"
   ssh "$HEBRA_MCP_HOST" "docker volume inspect hebra-mcp_data"
   # → Options con type none, o bind y device = HEBRA_MCP_DATA_DEVICE
   ssh "$HEBRA_MCP_HOST" "docker inspect --format '{{.State.Health.Status}}' hebra-mcp"
   # → healthy
   ```

   Comprobar también que un cliente OAuth existente sigue entrando sin
   reautorizar (los tokens y el emparejado viajaron en el directorio).

5. Solo después de esa comprobación, borrar la copia vieja sin cifrar
   (`$HEBRA_MCP_DEST.viejo`).

## Configurar el broker y revocar acceso

Provisionar el mismo `HEBRA_MCP_BACKCHANNEL_SECRET` exclusivo en Lumbre y en el
entorno privado desde el que se ejecuta `docker compose`; 32–512 caracteres,
sin saltos de línea. Se transmite solo por TLS en `Authorization: Bearer`.
`LUMBRE_MCP_BACKCHANNEL_SECRET` es otra credencial y no sirve aquí. No registrar
el valor en este runbook, en Compose ni en los logs. El proceso debe conservar
su emparejado existente: el login no sustituye la clave de biblioteca.

Al revocar todas las familias locales, ejecutar sobre el volumen activo:

```bash
ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
  docker compose --env-file deploy/.env -f deploy/compose.yml exec -T mcp \
  node dist/cli.mjs oauth-revoke-all"
```

Esto mueve `oauth-revocations-v2.json` y corta los access/refresh locales.
La revocación de concesiones concretas se gestiona en
`https://app.lumbre.pro/integrations/hebra-mcp`; un `active: false` corta su
familia local en el siguiente acceso. Revocar el emparejado o el dispositivo
Blob V2 también impide abrir notas cacheadas. No borra claves ni SQLite.

## Emparejado remoto (C5, SPEC.md §12.4)

El listener OAuth de emparejado de Hebra necesita `127.0.0.1` de la máquina
del navegador (§7 de la SPEC), así que el contenedor **no se empareja
directamente**. El procedimiento es en el Mac:

1. Emparejar como dispositivo **nuevo**, con un directorio de datos temporal y
   almacén de secretos en fichero (para poder copiarlo, ya que el llavero del
   Mac no es portable):

   ```bash
   HEBRA_MCP_DATA_DIR=/tmp/hebra-mcp-pair-remoto \
     HEBRA_MCP_SECRET_STORE=file \
     hebra-mcp pair --label "Claude remoto"
   ```

   David aprueba el emparejado en Hebra > Ajustes > Sincronización, igual que
   con cualquier otro dispositivo nuevo.

2. Copiar el directorio resultante al volumen del contenedor (**nunca** la
   identidad del llavero del Mac: serían dos motores compartiendo el mismo
   `opaqueDeviceId`, algo que la SPEC prohíbe explícitamente en §12.4):

   ```bash
   rsync -az /tmp/hebra-mcp-pair-remoto/ "$HEBRA_MCP_HOST:/tmp/hebra-mcp-import/"
   ssh "$HEBRA_MCP_HOST" "docker run --rm \
     -v hebra-mcp_data:/data -v /tmp/hebra-mcp-import:/import:ro \
     alpine sh -c 'cp -a /import/. /data/ && chown -R 1000:1000 /data'"
   ssh "$HEBRA_MCP_HOST" "rm -rf /tmp/hebra-mcp-import"
   ```

3. Reiniciar el contenedor para que recoja el directorio importado y **borrar
   el directorio temporal del Mac**:

   ```bash
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     docker compose --env-file deploy/.env -f deploy/compose.yml restart mcp"
   rm -rf /tmp/hebra-mcp-pair-remoto
   ```

4. Verificar con `hebra_status` desde claude.ai: `linked: true` y un
   `opaqueDeviceId` **distinto** del dispositivo del Mac (criterio de cierre de
   C5).

`config.json` de privados (§6.3) vive también en ese directorio: si se edita
tras la copia, hay que reiniciar el contenedor para que se recargue (se lee
solo al arrancar, SPEC.md §12.5).

## Cambiar el fragmento de Caddy

`deploy/mcp-hebra-pro.caddy` es la copia versionada del fragmento que va en el
`conf.d` del Caddy compartido. **Validar ANTES de recargar**: el `reload` de
Caddy es en caliente y no corta conexiones vivas, pero una config inválida deja
el borde ENTERO (Lumbre, Vega, fodaveg, Senda y las demos) sirviendo la config
anterior sin decir por qué — es un recurso compartido con otros sitios que no
tienen nada que ver con hebra-mcp.

```bash
scp deploy/mcp-hebra-pro.caddy "$HEBRA_MCP_HOST:$EDGE_CONFD/"
ssh "$HEBRA_MCP_HOST" 'cd /srv/edge && docker compose --env-file .env exec -T caddy \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh "$HEBRA_MCP_HOST" 'cd /srv/edge && docker compose --env-file .env exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile'
```

Si `validate` falla, NO se ejecuta el `reload`: se corrige el fragmento y se
repite desde el `scp`.

### La pieza que NO está en este repo

Igual que con `mcp.lumbre.pro` (ver el README de `lumbre-mcp`), el silencio del
log de este host necesita DOS piezas, y la segunda vive en
`/srv/edge/Caddyfile` (el bloque global del borde, que no es de este repo ni
está en git en ninguna parte):

```
{
	email {$ACME_EMAIL}

	log mcp_hebra_errores {
		output discard
		include http.log.error.mcp_hebra
	}
}

import conf.d/*.caddy
```

Un `log { output discard }` puesto solo en el fragmento del sitio SOLO tapa
`http.log.access.mcp_hebra`; lo que vuelca la URI completa en un 502 o timeout
es `http.log.error.mcp_hebra`, y el `include` que lo atrapa no se admite dentro
del bloque `log` de un sitio, solo en el global. Ver la nota "PENDIENTE DE
MEDIR" dentro de `mcp-hebra-pro.caddy`: esto no se ha comprobado todavía contra
el servidor real; el despliegue del 28 sep 2026 no incluyó esa prueba. Queda
repetir, en una ventana de diagnóstico autorizada, la prueba que `lumbre-mcp`
documenta (parar el contenedor, pedir una URL con datos falsos y revisar el log
del borde).

## Verificar la aceptación de C4

Criterio de cierre de C4 (SPEC.md §12.8): contenedor sano, `/mcp` sin token da
401, metadata PRM/AS accesible, ningún puerto en el host.

```bash
# 1. Contenedor sano (Docker ya corre el healthcheck; esto lo confirma desde fuera)
ssh "$HEBRA_MCP_HOST" "docker inspect --format '{{.State.Health.Status}}' hebra-mcp"
# → healthy

# 2. /mcp sin token: 401 con WWW-Authenticate que incluya resource_metadata
curl -si https://mcp.hebra.pro/mcp | grep -i '^\(HTTP\|WWW-Authenticate\)'
# → HTTP/2 401
# → www-authenticate: Bearer resource_metadata="https://mcp.hebra.pro/.well-known/oauth-protected-resource..."

# 3. Metadata PRM/AS accesible
curl -s https://mcp.hebra.pro/.well-known/oauth-protected-resource | head -c 200; echo
curl -s https://mcp.hebra.pro/.well-known/oauth-authorization-server | head -c 200; echo
# → JSON en los dos, no 404 ni 502

# 4. Ningún puerto publicado en el host
ssh "$HEBRA_MCP_HOST" "docker port hebra-mcp; ss -ltnp | grep 8787"
# → docker port: sin salida. ss: sin coincidencias (o solo dentro del netns del contenedor)
```

Este runbook **no sustituye** la suite stdio (`npm test`, que tiene que seguir
en verde, SPEC.md §12.7 punto 5) ni el test de cebos en stderr de C2. Tampoco
prueba el flujo OAuth completo (código, refresh, revoke): eso es C3/C6 con el
cliente real del SDK y, al final, QA de David desde claude.ai web, móvil y una
sesión en la nube (§12.7, C6).

## Actualizar y retirar

- **Actualizar**: repetir "Publicar una versión nueva" desde el paso 1. El
  `up -d --build` con la misma imagen reconstruida sustituye el contenedor sin
  tocar el volumen `hebra-mcp_data`.
- **Retirar** (por ejemplo, para desmontar el conector remoto por completo):

  ```bash
  ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
    docker compose --env-file deploy/.env -f deploy/compose.yml down"
  # el volumen NO se borra con `down` a secas. Con el bind al volumen cifrado,
  # `docker volume rm hebra-mcp_data` solo borra la definición del volumen: los
  # datos siguen en el directorio `HEBRA_MCP_DATA_DEVICE`. Para borrar TODO el estado (indistinguible de
  # perder los secretos del emparejado remoto y todos los grants OAuth) hay que
  # borrar además ese directorio, a mano y a propósito.
  ```

  Retirar también el fragmento de Caddy (`rm` en `$EDGE_CONFD` + `validate` +
  `reload`, mismos pasos que para publicarlo) para que `mcp.hebra.pro` deje de
  resolver a un contenedor que ya no está.

## Copias de seguridad

**Medido el 26 sep 2026** contra `scripts/backup-db.sh` y
`scripts/backup-blobs.sh` del repo `lumbre` (los dos jobs de backup que ya
corren en ese VPS por `systemd` timer):

- `backup-db.sh` hace `pg_dump` del Postgres de **Lumbre** — no toca volúmenes
  Docker de otros contenedores.
- `backup-blobs.sh` hace `mc mirror` del bucket **MinIO** de Lumbre — tampoco
  toca volúmenes Docker arbitrarios.

Ninguno de los dos copiaría el volumen `hebra-mcp_data`. Esto **no es un hueco
nuevo de este lote**: es el mismo hueco que ya tiene hoy el volumen `state` de
`lumbre-mcp` (que guarda un secreto equivalente en gravedad — `oauth.key` +
`oauth-store.json` — y su propio README lo señala como "unidad de backup" sin
que exista ningún job que la copie). Perder el volumen `hebra-mcp_data` sin
backup significa: rehacer el emparejado remoto completo (C5) y que todos los
clientes OAuth (claude.ai) tengan que reautorizar.

Desde el 19 oct 2026 el directorio de datos está en el volumen cifrado del
servidor (`HEBRA_MCP_DATA_DEVICE`), así que cualquier copia que se haga de él
debe salir cifrada también.

Pendiente, fuera del alcance de C4: decidir si se quiere un backup cifrado
propio (mismo patrón `age` que los otros dos scripts) para `hebra-mcp_data`, o
si se acepta el mismo riesgo que ya se acepta hoy para `lumbre-mcp_state`.

## Evidencia histórica y verificación actual

Las pruebas locales de Docker del 26 sep 2026 acreditaron el método antiguo
de secreto del dueño; sus salidas están en el historial de Git y no acreditan
este cambio de login. Para otra publicación, ejecutar `npm run check`,
`docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet`
y el recorrido real de SPEC.md §12.7. Registrar por separado build, despliegue,
servicio servido y QA con Claude. Ninguno se infiere de un checkout local.
