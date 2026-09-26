# Deploy del transporte HTTP remoto (`mcp.hebra.pro`, SPEC.md §12, lote C4)

Este runbook prepara el despliegue de C4. **No se ejecuta todavía**: depende de
C1 (secretos en fichero), C2 (`serve-http`) y C3 (OAuth de un dueño), que se
están implementando en paralelo. Nada de lo de aquí toca el servidor; es la
guía para cuando C1-C3 estén integrados.

## Variables y nombres por confirmar (C1/C2/C3)

Único sitio donde se explican estos marcadores. `Dockerfile`, `compose.yml` y
`mcp-hebra-pro.caddy` los usan tal cual están aquí; al integrar cada lote,
ajustar en los CUATRO sitios a la vez (los tres ficheros de `deploy/` + este
punto) si el nombre real difiere.

| Marcador usado en `deploy/` | Qué es | Lote | Estado |
|---|---|---|---|
| `serve-http` | Subcomando del binario que arranca el transporte HTTP | C2 | **Confirmado**, SPEC.md §12.1/§12.8 |
| `/healthz` | Ruta de liveness | C2 | **Confirmado**, SPEC.md §12.8 |
| `/mcp` | Ruta del transporte Streamable HTTP | C2 | **Confirmado**, SPEC.md §12.1 |
| `oauth-revoke-all` | Subcomando que revoca todos los tokens OAuth | C3 | **Confirmado**, SPEC.md §12.2/§12.8 |
| `HEBRA_MCP_DATA_DIR` | Directorio de datos (SQLite, `config.json`, secretos, store OAuth) | ya existe | **Confirmado**, `src/privacy/data-dir.ts` |
| `HEBRA_MCP_SECRET_STORE=file` | Variable de modo que elige `FileSecretStore` en vez del llavero del SO | C1 | Nombre **sin confirmar**; la SPEC solo dice "una variable de modo explícita, nunca como fallback" (§12.3) |
| `HEBRA_MCP_PUBLIC_URL` | URL pública (`https://mcp.hebra.pro`) para construir el issuer, la metadata PRM/AS y, si aplica, `allowedHosts` | C2/C3 | Nombre **sin confirmar**; el valor sí lo fija SPEC.md §12.5 |
| `PORT` | Puerto de escucha interno (`8787` aquí, arbitrario) | C2 | Sin confirmar si `serve-http` usa esta variable o un flag |
| `hebra-mcp oauth-set-owner-secret` | Subcomando para fijar el secreto del dueño **por stdin**, mencionado en el encargo de C4 | C3 | **Nombre inventado para este runbook**: SPEC.md §12.2 dice que "la página de autorización pide el secreto del dueño... el servidor guarda su hash", pero no nombra un subcomando de gestión. Ajustar el nombre real al integrar C3; la mecánica descrita más abajo (stdin, nunca argumento de proceso, `compose exec`) no debería cambiar. |

## Cómo va a estar montado

| Pieza | Dónde | Qué |
|---|---|---|
| Servicio | un directorio propio en el VPS de Lumbre (mismo servidor que `lumbre-app` y `lumbre-mcp`) | copia de `dist/`, `package.json`, `package-lock.json` y `deploy/`, subida por `rsync` |
| Contenedor | `hebra-mcp` | `node dist/cli.mjs serve-http`, escucha en 8787, usuario sin root |
| Borde | `mcp-hebra-pro.caddy` en el `conf.d` del Caddy compartido (`/srv/edge` del VPS, el mismo borde que ya sirve Lumbre, Vega, fodaveg y las demos) | Caddy termina TLS y hace proxy, sin exponer `/healthz` |
| Estado | volumen con nombre `hebra-mcp_data` | SQLite, `config.json` de privados, secretos de fichero (C1) y store OAuth (C3), todo en el mismo volumen |

El contenedor **no publica puertos al host**: Caddy lo alcanza por el DNS de
la red Docker externa `edge` (`hebra-mcp:8787`), igual que `lumbre-app` y
`lumbre-mcp`. El único camino de entrada es HTTPS por el borde.

`vendor/hebra` es un submódulo **privado** (`git@github.com:fodaveg/hebra.git`):
el servidor no lo puede clonar con la clave de despliegue que tenga (si
tuviera alguna), así que el flujo de publicación nunca hace `git clone` ni
`git pull` de este repo en el servidor — sube `dist/` ya compilado. Por el
mismo motivo, la imagen no se publica en ningún registro: lleva código de
Hebra empaquetado dentro de `dist/`.

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

1. Compilar en el Mac (donde SÍ está el submódulo `vendor/hebra`):

   ```bash
   npm run build
   npm run check:bundle   # falla si dist/ no coincide con lo commiteado en src/
   ```

2. Subir por `rsync` solo lo que hace falta — nunca `src/`, nunca
   `vendor/hebra`, nunca `node_modules/`:

   ```bash
   rsync -az --delete \
     dist/ package.json package-lock.json deploy/ \
     "$HEBRA_MCP_HOST:$HEBRA_MCP_DEST/"
   ```

   El `--delete` es intencional: si un despliegue anterior dejó un fichero de
   `dist/` que ya no existe, no debe seguir sirviéndose. No aplicar `--delete`
   sobre nada que no sea el árbol que gestiona este `rsync`.

3. Preparar el volumen la PRIMERA vez (el contenedor corre con `USER node`,
   uid/gid 1000; sin este paso, el arranque falla al intentar escribir la
   SQLite o los secretos de fichero, y eso se ve como un healthcheck en rojo,
   no como un permiso denegado explícito):

   ```bash
   ssh "$HEBRA_MCP_HOST" "docker volume create hebra-mcp_data && \
     docker run --rm -v hebra-mcp_data:/data alpine chown -R 1000:1000 /data"
   ```

4. Construir y levantar:

   ```bash
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && \
     docker compose -f deploy/compose.yml up -d --build"
   ```

5. Comprobar salud (ver "Verificar la aceptación de C4" más abajo) antes de
   dar la publicación por buena.

**No hay `git pull` en el servidor**, por el submódulo privado (ver arriba). Si
algún día se decide clonar el árbol público sin `vendor/hebra` y compilar en el
propio VPS, este paso cambiaría; hoy no es el caso.

## Configurar el secreto del dueño

El flujo OAuth de un solo dueño (C3, SPEC.md §12.2) necesita el secreto del
dueño ya fijado ANTES de que `serve-http` acepte el primer `/authorize`. Se
fija **por stdin**, nunca como argumento de proceso (aparecería en `ps` de
cualquiera con acceso al host) ni como variable de entorno en `compose.yml`
(quedaría en texto plano en un fichero versionable y en `docker inspect`):

```bash
ssh "$HEBRA_MCP_HOST" \
  "cd $HEBRA_MCP_DEST && docker compose exec -T mcp \
    node dist/cli.mjs oauth-set-owner-secret"
# … y se escribe el secreto por stdin cuando el proceso lo pida.
```

**Siempre `compose exec`, nunca `compose run`.** `run` crearía un SEGUNDO
contenedor sobre el mismo volumen; `writer-lock.ts` (SPEC.md §8) identifica al
escritor por PID, y dentro de un contenedor el PID se reutiliza desde 1: un
segundo contenedor tomaría el bloqueo del primero por huérfano y los dos
escribirían el mismo estado a la vez. `exec` entra en el proceso YA corriendo,
sin ese riesgo.

## Revocar acceso

```bash
ssh "$HEBRA_MCP_HOST" \
  "cd $HEBRA_MCP_DEST && docker compose exec -T mcp \
    node dist/cli.mjs oauth-revoke-all"
```

Revoca todos los tokens emitidos (access y refresh); claude.ai tendría que
volver a pasar por `/authorize` y el secreto del dueño. El corte inmediato y
sin depender de que el proceso reaccione es parar el contenedor:

```bash
ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && docker compose stop mcp"
```

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

   (El nombre exacto de `HEBRA_MCP_SECRET_STORE` está sin confirmar — ver la
   tabla de arriba.) David aprueba el emparejado en Hebra > Ajustes >
   Sincronización, igual que con cualquier otro dispositivo nuevo.

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
   ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && docker compose restart mcp"
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
el servidor real (no hay nada desplegado aún), y hay que repetir la prueba que
`lumbre-mcp` documenta (parar el contenedor, pedir una URL con datos falsos,
`grep` el log del borde) en cuanto haya un contenedor `hebra-mcp` corriendo.

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
  ssh "$HEBRA_MCP_HOST" "cd $HEBRA_MCP_DEST && docker compose down"
  # el volumen NO se borra con `down` a secas; borrarlo es indistinguible de
  # perder los secretos del emparejado remoto y todos los grants OAuth:
  # docker volume rm hebra-mcp_data   # solo si se quiere borrar TODO el estado
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

Pendiente, fuera del alcance de C4: decidir si se quiere un backup cifrado
propio (mismo patrón `age` que los otros dos scripts) para `hebra-mcp_data`, o
si se acepta el mismo riesgo que ya se acepta hoy para `lumbre-mcp_state`.
