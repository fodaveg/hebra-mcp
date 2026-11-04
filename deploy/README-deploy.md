# Deploy del transporte HTTP remoto (`mcp.hebra.pro`, SPEC.md §12, lote C4)

C1 (secretos en fichero) y C2 (`serve-http`) conservan su transporte. El OAuth público
C3 cambia la aprobación al login y consentimiento de Lumbre (SPEC.md §12.2).
El cambio se desplegó el 28 sep 2026 con Hebra MCP `e36e72a` y broker Lumbre
`dfdc34f`. El inicio OAuth público DCR + PKCE llega al consentimiento de Lumbre;
la reconexión y QA de Claude por David siguen pendientes. Ver [RELEASE-2026-09-28.md](RELEASE-2026-09-28.md).

D21 convierte el conector en multiusuario: Sumego identifica a la persona, Lumbre comprueba la
propiedad del dispositivo y la bóveda, y cada cuenta abre su propio contexto. Este runbook describe
la operación del conector. D21 se desplegó el 3 nov 2026 con código `4e33b17`: se verificaron
la continuidad de la conexión existente de David, su biblioteca personal y `dualhand`.
La prueba con la cuenta real de Mikel sigue pendiente; las pruebas sintéticas no la sustituyen.

El soporte OAuth de Codex admite su CIMD oficial exacto
`https://chatgpt.com/oauth/codex/client.json` y DCR con los clientes fijos
`hebra-mcp-codex-127`, `hebra-mcp-codex-localhost` y `hebra-mcp-codex-loopback`.
Mistral Vibe (el CLI de Mistral) entra por DCR restringido como Claude: un registro
con `client_name` «Mistral Vibe» y callbacks nativos
`http://127.0.0.1:<puerto>/callback` (puerto por defecto 47823, nunca `localhost`)
se reduce al cliente fijo `hebra-mcp-vibe` con redirect `http://127.0.0.1/callback`
(SPEC.md §12.2). Para conectarlo: `vibe mcp add hebra --url https://mcp.hebra.pro/mcp --transport streamable-http`.
Le Chat (la web de Mistral) entra también por DCR restringido: un registro con `client_name`
`mistral-mcp-client` y el callback exacto
`https://callback.mistral.ai/v1/integrations_auth/oauth2_callback` se reduce al cliente fijo
`hebra-mcp-lechat` (consentimiento "Le Chat", SPEC.md §12.2). Para conectarlo: Ajustes >
Conectores > Añadir conector personalizado, URL `https://mcp.hebra.pro/mcp`. El alta de
`hebra-mcp-lechat` en Lumbre debe estar desplegada antes.
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
| `control-secrets-rollback` | Copia los secretos globales de vuelta a `secrets.json` sin borrar `control/secrets.json`, con el servicio parado. Ver «Secretos globales en `control/secrets.json`» | — | `src/accounts/control-secrets.ts` |
| `/healthz` | Ruta de liveness, sin autenticación, responde **204 sin cuerpo** | — | `src/http/app.ts` |
| `/mcp` | Ruta del transporte Streamable HTTP (`POST`; `GET`/`DELETE` dan 405) | — | `src/http/app.ts` |
| `HEBRA_MCP_DATA_DIR` | Directorio de datos: SQLite, privados, secretos, `oauth-revocations-v2.json` y `oauth-tokens.json` | ninguno (obligatorio en el contenedor) | `src/privacy/data-dir.ts` |
| `HEBRA_MCP_DATA_DEVICE` | Directorio del host, en el volumen cifrado del servidor, que se monta en `/data` (bind del volumen `hebra-mcp_data`). Vive en el `deploy/.env` del servidor, nunca en el repo | ninguno (obligatorio) | `deploy/compose.yml` |
| `HEBRA_MCP_BACKCHANNEL_SECRET` | Bearer exclusivo de Hebra MCP, compartido con el broker Lumbre; 32–512 caracteres, sin CR/LF | ninguno (obligatorio) | `src/oauth/http-auth.ts` |
| `HEBRA_MCP_SECRET_STORE` | Modo del almacén de secretos: `keychain` o `file`, selección EXPLÍCITA, nunca fallback | `keychain` (aquí se fija `file`) | `src/secrets/store-mode.ts` |
| `HEBRA_MCP_HTTP_LISTEN` | Interfaz de escucha | `127.0.0.1` (aquí se fija `0.0.0.0`, o Caddy no llegaría por la red `edge`) | `src/http/config.ts` |
| `HEBRA_MCP_HTTP_PORT` | Puerto de escucha | `8787` | `src/http/config.ts` |
| `HEBRA_MCP_PUBLIC_URL` | Origen público: issuer OAuth y base del recurso (`<origen>/mcp`) | `https://mcp.hebra.pro` | `src/http/config.ts` |
| `HEBRA_MCP_CONTEXT_IDLE_MS` | Tiempo sin peticiones en curso tras el que se cierra una biblioteca o un espacio abiertos (D22, SPEC.md §12.10). Un valor inválido impide arrancar | `120000` | `src/accounts/capacity.ts` |
| `HEBRA_MCP_OPEN_WAIT_MS` | Cuánto espera una apertura, en orden de llegada, por memoria o por un `writer.lock` ajeno antes del 503 con `Retry-After`. Un valor inválido impide arrancar | `20000` | `src/accounts/capacity.ts` |
| `HEBRA_MCP_MEMORY_HIGH_WATER` | Memoria en uso del contenedor por encima de la cual se cierra antes lo que no tiene peticiones en curso y las aperturas esperan: `0.8`, `80%` o bytes. Un valor inválido impide arrancar | `80%` del límite del contenedor | `src/accounts/capacity.ts` |
| `LUMBRE_APP_ORIGIN` | Origen de Lumbre: destino del backchannel y único origen admitido en la URL de consentimiento. Tiene que ser el mismo que Lumbre usa para construirla (`ORIGIN` o uno de `LUMBRE_PUBLIC_ORIGINS`); `https` sin ruta, query ni credenciales (`http` solo en loopback). Uno inválido impide arrancar | `https://app.lumbre.pro` | `src/oauth/backchannel.ts` |
| `HEBRA_MCP_LOGIN_PROVIDER` | Quién identifica a la persona en `/authorize` (D20/D21, SPEC.md §§12.9–12.10): `sumego` es el modo de producción multiusuario; `lumbre` conserva la compatibilidad anterior. Otro valor impide arrancar; con `sumego` y el cliente incompleto tampoco arranca, nunca vuelve en silencio a `lumbre` | `lumbre` en código; producción fija `sumego` | `src/oauth/login-config.ts` |
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
| Estado | volumen `hebra-mcp_data` en bind a `HEBRA_MCP_DATA_DEVICE`, en el volumen cifrado del servidor | Control OAuth y registro multiusuario en la raíz; biblioteca heredada de David en `legacy-root`; cuentas nuevas en directorios aislados con SQLite, blobs, privados, secretos, escritor, sync y espacios propios |

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

   La imagen `previous` sirve para diagnóstico, no garantiza una vuelta atrás.
   En cuanto D21 haya creado o retirado una cuenta, una versión monousuario no
   puede interpretar de forma segura el registro, los diarios ni las
   revocaciones nuevos. En ese caso se cierra el conector y se corrige hacia
   delante; no se arranca `previous` contra el volumen actual.

   Antes de este paso, provisionar `HEBRA_MCP_BACKCHANNEL_SECRET` en
   `deploy/.env` privado con el mismo valor que el broker Lumbre. También se
   puede ejecutar desde `deploy/` con `--env-file .env`. `compose.yml` exige
   su presencia; el valor no se copia al repositorio. El emparejado histórico
   de David se conserva en su raíz original; cada cuenta nueva se incorpora
   desde el conector con el procedimiento D21 de este runbook. Si falta
   configuración, `serve-http` sale cerrado.

   Login con Sumego (D20-D21, SPEC.md §§12.9-12.10): el despliegue multiusuario
   usa `sumego`. Añadir al `deploy/.env` privado
   `HEBRA_MCP_LOGIN_PROVIDER=sumego` y `HEBRA_MCP_OIDC_CLIENT_SECRET=<secreto
   del cliente hebra-mcp en Sumego>` (y `HEBRA_MCP_OIDC_ISSUER` o
   `HEBRA_MCP_OIDC_CLIENT_ID` solo si no son los de por defecto), con `sudo tee
   -a` como el resto del fichero, y recrear el contenedor. Las dos piezas de
   Lumbre (`identityProvider` en
   `/requests` y `sumego/exchange`) tienen que estar desplegadas antes de pasar
   a `sumego`. Con cliente configurado, el primer arranque crea en
   `control/secrets.json` (dentro de `/data`, con
   `HEBRA_MCP_SECRET_STORE=file`) la clave `hebra-mcp-sumego-refresh-key`, con
   la que se cifran los refresh de Sumego de `oauth-tokens.json`. Si se pierde,
   las familias de Sumego se cortan en su siguiente renovación horaria y hay
   que volver a conectar.

   Antes de la primera migración D21, crear una copia cifrada consistente del
   estado monousuario y ensayar su restauración en un entorno aislado. Después
   del primer arranque D21, comprobar que el volumen ya contiene el registro de
   cuentas y las generaciones o tumbas de revocación. Un reinicio debe completar
   o limpiar cada diario de alta incompleto sin publicar una cuenta activa. Una
   copia o imagen antigua no puede sobrescribir escrituras ni revocaciones
   posteriores.

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

Las peticiones de cada cuenta a `LUMBRE_APP_ORIGIN` (`/exchange`, relé, espacios) llevan además `X-Hebra-Mcp-Backchannel` (este secreto) y `X-Hebra-Mcp-Subject` (su `sub` en minúsculas) para que Lumbre limite por persona; solo a ese origen exacto, con `redirect: 'error'`, nunca en `stdio` ni sin `sub` conocido (`src/oauth/lumbre-identity.ts`).

Para una emergencia global que corte todas las familias locales, ejecutar
sobre el volumen activo:

```bash
ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
  docker compose --env-file deploy/.env -f deploy/compose.yml exec -T mcp \
  node dist/cli.mjs oauth-revoke-all"
```

`oauth-revoke-all` no retira una cuenta individual: mueve
`oauth-revocations-v2.json` y corta los access/refresh locales de todo el
servicio. La revocación de concesiones concretas se gestiona en
`https://app.lumbre.pro/integrations/hebra-mcp`; un `active: false` corta su
familia local en el siguiente acceso. Revocar el emparejado o el dispositivo
Blob V2 también impide abrir notas cacheadas. No borra claves ni SQLite.

Son operaciones distintas:

- cerrar sesión revoca la familia OAuth de ese cliente, no la biblioteca;
- retirar membresía o un grant corta solo el recurso compartido correspondiente;
- retirar una cuenta bloquea entradas nuevas, drena las operaciones en curso,
  revoca el emparejado remoto y solo entonces elimina su estado personal. Para
  David se conserva la raíz y todo estado de control global identificado; se
  eliminan únicamente sus datos personales inventariados: SQLite, blobs,
  secretos de emparejado, privados, espacios, planes, idempotencia, cachés,
  temporales, contenido personal de `jd-plans.sqlite`, diarios y sus entradas
  en almacenes compartidos. Un elemento sin clasificar detiene el borrado.

No se usa `oauth-revoke-all` como sustituto de esa retirada individual.

## Emparejado remoto multiusuario (D21, SPEC.md §12.10)

El alta se hace desde el propio conector; no se crea un dispositivo temporal
en el Mac ni se copian secretos por `scp` o `rsync`:

1. El conector detecta que el `sub` autenticado con Sumego aún no tiene cuenta
   y abre el alta. Lumbre recibe el origen exacto
   `https://mcp.hebra.pro` (sin barra final) y construye el retorno
   `/lumbre/connect#code`; la página elimina el fragmento y envía el código por
   `POST /lumbre/connect` al mismo origen.
2. La persona aprueba en su Hebra el dispositivo y la custodia remota de la
   clave. El servidor valida que la biblioteca pertenece al mismo `sub` antes
   de mostrar títulos, asociar la cuenta o publicarla como activa.
3. Tras validar la propiedad, el conector puede mostrar como máximo tres
   títulos de esa biblioteca para confirmar que es la correcta. La
   confirmación termina el alta y las conexiones siguientes reutilizan la
   cuenta aislada.

La página usa `POST /lumbre/pairing/poll`, `/confirm` o `/cancel`; si la
identidad caduca durante la aprobación, la reautenticación vuelve por
`GET /lumbre/pairing/resume` y debe conservar el mismo `sub`. Son rutas del
flujo web, no comandos de administración ni flags nuevos de la CLI.

La preparación usa un directorio aislado en modo `0700`, ficheros `0600` y un
diario durable con TTL. Si el proceso cae en la frontera entre el efecto remoto
y la persistencia local, el arranque siguiente reanuda la revocación o limpia
el alta; nunca publica una asociación o cuenta activa antes de validar la
propiedad. Puede conservar solo los secretos mínimos necesarios para revocar el
alta abandonada.

La cuenta histórica de David sigue en `legacy-root`: no se mueve a un
subdirectorio ni se borra la raíz, porque allí convive estado de control global.
Las cuentas nuevas usan directorios propios.

Para que una cuenta vea espacios u organizaciones (H-L7) deben estar
desplegados el catálogo y los grants del relay. Además hacen falta, a la vez,
la membresía vigente, el grant del recurso y el permiso del agente de esa
persona. Pertenecer a una organización no abre bibliotecas personales. Si la
ruta compartida está cerrada, la biblioteca personal puede seguir operativa.

## Capacidad, cierres y pendientes (D22, SPEC.md §12.10)

- `mem_limit` de `compose.yml` es la barrera de la máquina compartida, no un cupo de personas. Su
  valor sale de la medición de aceptación con bibliotecas de tamaño real; para más capacidad se sube
  o se añade máquina. `HEBRA_MCP_MEMORY_HIGH_WATER` se mide contra ese límite. Un 503 de `/mcp` lleva
  `Retry-After` y su motivo en el log (`mcp.unavailable`): `capacity_wait_timeout`, `open_failed` o
  `lock_held`.
- `control/server.lock` lo toma el servicio y lo ve cualquier proceso, también de otro contenedor
  sobre el mismo volumen. Un segundo `serve-http` no arranca. Es un fichero vacío que no se borra.
- `control/pending-uploads-v1.json` es la lista de subidas que quedaron al cerrar una biblioteca.
  Se conserva con el volumen y no hay que tocarla: el barrido (cada 60 s) la vacía solo. Se mira el
  log solo si algo falla:

| Evento | Qué hacer |
|---|---|
| `pending_sweep.round` | Nada. Resume lo que hizo una pasada con trabajo; en reposo no sale |
| `pending_sweep.element`, `pending_uploads.write` | Si se repiten, mirar el disco y el relé: se reintenta solo, con espera de 2 a 30 min por elemento |
| `pending_uploads.read` | El fichero era ilegible y se trató como vacío. Lo escrito sigue en cada SQLite y sube al volver a abrirla |
| `sync.close_round` | Nada. La ronda final al cerrar; `pending: true` deja la biblioteca en la lista |
| `contexts.close_failed`, `contexts.close_recovered` | Un cierre falló y se reintenta (1 s, doblando hasta 30 s). Mientras, esa cuenta o espacio recibe 503 `open_failed` |
| `contexts.close_stuck` | El cierre lleva 10 intentos o más. Quitar la causa (disco lleno o de solo lectura, directorio desmontado); el siguiente reintento lo recoge. Reiniciar solo si no se arregla desde dentro |

- El apagado cabe en `stop_grace_period: 50s`: 12 s de drenaje, 5 s de ronda final y hasta 30 s de
  cierre del sync (47 s). No hace falta subir ese valor sin cambiar esos tiempos.
- La vuelta atrás de los secretos globales (`control-secrets-rollback`) está en la sección siguiente.

## Secretos globales en `control/secrets.json` (D22, SPEC.md §12.10)

Los bearers de Lumbre de todas las cuentas, sus pendientes y la clave de refresh
de Sumego (`hebra-mcp-oauth-grants`, `hebra-mcp-oauth-pending`,
`hebra-mcp-sumego-refresh-key`) viven en `control/secrets.json` (0600, directorio
0700). El `secrets.json` de la raíz conserva solo el emparejado de `legacy-root`.
Retirar a esa persona borra sus claves de ese fichero y nunca toca `control/`.

**Hacia delante no hay nada que hacer.** `serve-http` migra al arrancar, antes
de atender tráfico y con el bloqueo de control tomado. Copia los campos con
escritura atómica, comprueba lo escrito, lo lleva a disco y solo entonces los
retira de `secrets.json`. No cambia ningún valor, así que nadie vuelve a emparejar
y los refresh ya emitidos siguen descifrándose. Una caída en cualquier punto se
reanuda en el arranque siguiente; repetirla sin nada que mover no escribe. El log
registra `control_secrets.migrated` con el número de campos, nunca sus valores.
Solo se migra `HEBRA_MCP_SECRET_STORE=file`; con el llavero (uso local) estos
secretos siguen en sus entradas.

**Si no arranca**, sale con 1 y escribe en stderr un JSON con el `code`. En los
tres casos no ha retirado nada:

| `code` | Qué significa | Qué hacer |
|---|---|---|
| `control_secrets_conflict` | `secrets.json` y `control/secrets.json` tienen un valor distinto para el mismo campo. Lo normal es que se arrancara una imagen anterior sin la orden de abajo, que crea concesiones vacías y otra clave de refresh | No elegir fuente sin revisar. Con copia de los dos ficheros, comprobar cuál conserva las familias de `oauth-tokens.json` y quitar los campos sobrantes de `secrets.json`. Sin ese análisis, el conector sigue cerrado |
| `control_secrets_corrupt` | `control/secrets.json` no se puede interpretar. No se trata como vacío porque eso cortaría a todas las personas | Corregir el fichero; la imagen no regenera nada mientras siga así |
| `control_secrets_source_corrupt` | `secrets.json` no se puede interpretar y podía ser la única copia (aún sin migrar o tras una vuelta atrás) | Corregir el fichero antes de arrancar |

Las escrituras atómicas no producen estos estados por sí solas: apuntan a una
intervención externa o a un fallo de disco. Ninguno se resuelve restaurando una
instantánea por encima de escrituras o revocaciones posteriores (§12.10).

### Volver a una imagen anterior a esta migración

Una imagen anterior lee estos campos de `secrets.json`. Si arranca sin ellos, no
encuentra los bearers y genera otra clave de refresh: las personas conectadas
pierden la sesión aunque `control/secrets.json` siga intacto. Por eso **la orden
va antes de arrancarla**, y se lanza con la imagen nueva, que es la que la
conoce:

```bash
# Desde $HEBRA_MCP_DEST, en el servidor. Primero parar y comprobar que está parado:
docker compose --env-file deploy/.env -f deploy/compose.yml stop mcp
docker compose --env-file deploy/.env -f deploy/compose.yml ps --status running

docker compose --env-file deploy/.env -f deploy/compose.yml run --rm --no-deps mcp \
  node dist/cli.mjs control-secrets-rollback
```

Imprime `{"restored":[...]}` con los nombres de los campos, sin valores. No borra
`control/secrets.json` y deja en él una marca que dice que `secrets.json` vuelve a
ser la fuente vigente. Se puede repetir: no pisa lo que ya haya en `secrets.json`
tras esa marca. Después se arranca la imagen anterior siguiendo la advertencia de
«Publicar una versión nueva»: solo una versión que entienda el registro
multiusuario puede volver a servir tráfico.

La orden toma `control/server.lock`, el mismo bloqueo que el servicio, y se niega
con `control_secrets_busy` si otro proceso lo tiene. Es un bloqueo del kernel
sobre el fichero (no de PID), así que lo ve también un servicio que corra en otro
contenedor sobre el mismo volumen, y lo suelta la muerte del proceso sea como
sea. Aun así, el paso de parar y comprobar sigue siendo el procedimiento: el
bloqueo es la red, no el plan.

Mientras la imagen anterior atienda, `secrets.json` es la fuente vigente y
`control/secrets.json` queda atrasado, con los bearers revocados desde entonces
todavía dentro. Conservarlo cifrado en el mismo volumen, sin copiarlo aparte ni
restaurarlo a mano. Al volver a publicar la imagen nueva no hay que lanzar nada:
la migración ve la marca, gana lo que escribió la imagen anterior, también sus
revocaciones, y retira otra vez los campos de `secrets.json`.

Esta orden solo cubre estos tres campos. Antes de volver atrás, comprobar en las
notas del candidato si cambió también el formato de otro estado del volumen.

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
del bloque `log` de un sitio, solo en el global. El 3 nov 2026 se añadió y
validó este descarte global en el servidor. Durante la migración D21 se paró
el contenedor y una petición con marcador ficticio recibió 502; el marcador
no apareció en dos lecturas del log del borde separadas tres segundos.
Repetir esa comprobación si cambia la configuración del proxy. La anotación
histórica del fragmento sobre la medición pendiente corresponde al despliegue
del 28 sep 2026, que no incluyó esa prueba.

## Verificar la aceptación de C4

Criterio de cierre de C4 (SPEC.md §12.8): contenedor sano, `POST /mcp` sin token
da 401, metadata PRM/AS accesible, ningún puerto en el host.

```bash
# 1. Contenedor sano (Docker ya corre el healthcheck; esto lo confirma desde fuera)
ssh "$HEBRA_MCP_HOST" "docker inspect --format '{{.State.Health.Status}}' hebra-mcp"
# → healthy

# 2. POST /mcp sin token: 401 con WWW-Authenticate que incluya resource_metadata
# GET /mcp da 405: no sirve para comprobar el rechazo de autenticación.
curl -si -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://mcp.hebra.pro/mcp | grep -i '^\(HTTP\|WWW-Authenticate\)'
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
- **Retirar una cuenta**: seguir la secuencia individual anterior sin borrar
  `HEBRA_MCP_DATA_DEVICE`; para `legacy-root`, la raíz contiene además estado
  global y tampoco es el objetivo de borrado. El operador identifica la entrada
  correcta del registro de cuentas y ejecuta `node dist/cli.mjs account-remove
  <account-id>` dentro del contenedor, con su usuario y volumen habituales. El
  ID es opaco (la entrada histórica usa `legacy`), nunca un email ni un `sub`.
  Con el daemon activo, la orden usa `control/accounts.sock` (0600) y mantiene
  operativas las otras cuentas. Sin daemon, adquiere el bloqueo global y no abre
  listener. Un error o timeout no acredita que la retirada haya terminado:
  comprobar el estado y reintentar la misma cuenta; nunca borrar datos a mano
  para forzar el cierre. En una emergencia se puede cerrar todo el conector.
  Si devuelve `account_writer_busy`, la cuenta queda bloqueada y conserva los
  datos necesarios para reintentar: cerrar el escritor que aún utiliza esa
  biblioteca o sus espacios antes de repetir la orden. Antes de retirar una
  cuenta, actualizar o detener también cualquier lector stdio/workdir antiguo
  que comparta esos datos; las versiones anteriores no consultan la marca
  durable de retirada al abrir una caché o guardar claves. La actualización del
  contenedor cierra sus procesos antiguos, pero no los de otros contenedores o
  procesos externos que usen el mismo volumen.
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
backup significa perder el registro y el aislamiento de todas las cuentas,
sus bibliotecas remotas, diarios y revocaciones, y obliga a que todos los
clientes OAuth reautoricen.

Desde el 19 oct 2026 el directorio de datos está en el volumen cifrado del
servidor (`HEBRA_MCP_DATA_DEVICE`), así que cualquier copia que se haga de él
debe salir cifrada también.

Una copia consistente de D21 incluye el registro global, los directorios por
cuenta, `legacy-root`, los diarios de alta y retirada, y las generaciones o
tumbas de revocación. Restaurarla no autoriza a sobrescribir escrituras ni
revocaciones más recientes. Tras crear o retirar cuentas, una imagen
monousuario es incompatible con ese estado: se conserva para diagnóstico, no
para arrancarla contra la copia restaurada.

D21 exige una copia cifrada consistente y un ensayo de recuperación antes de
la primera migración. Sigue pendiente el job periódico que mantenga esa copia
después del despliegue; aceptar el riesgo histórico de `lumbre-mcp_state` no
sustituye ese prerrequisito de D21.

## Evidencia histórica y verificación actual

Las pruebas locales de Docker del 26 sep 2026 acreditaron el método antiguo
de secreto del dueño; sus salidas están en el historial de Git y no acreditan
el login ni el aislamiento de D21. Para otra publicación, ejecutar `npm run check`,
`docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet`
y el recorrido real de SPEC.md §§12.7 y 12.10 sobre el mismo candidato.
Registrar por separado build, despliegue, servicio servido y QA con Claude.
La aceptación incluye David y Mikel, bibliotecas personales aisladas, espacio
compartido y organización autorizada; nunca una personal ajena. Ninguna de
esas pruebas se infiere de un checkout local ni de un `/healthz` verde.
