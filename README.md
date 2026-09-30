# hebra-mcp

Servidor MCP que da a Claude acceso de lectura y escritura (crear, añadir, editar por
sustituciones puntuales, mover a carpetas existentes, marcar como favoritas, archivar,
mandar a la papelera y sacar de ella, restaurar versiones anteriores de notas y leer sus
adjuntos; nunca purgar ni vaciar la papelera, escribir adjuntos ni gestionar carpetas, que
se crean desde la app Hebra; `SPEC.md` §5) a
la biblioteca de notas de [Hebra](https://github.com/fodaveg/hebra), sin pasar por un
relé que pueda leer el contenido: el sync va cifrado de punta a punta y hebra-mcp se
vincula como un dispositivo más de la biblioteca. Detalle completo en `SPEC.md`.

Estado a 30 de septiembre de 2026: el servidor MCP tiene 21 herramientas (detalle en
`SPEC.md` §5):

- Lectura: `hebra_search`, `hebra_list_notes`, `hebra_read_note`, `hebra_list_tags`,
  `hebra_list_folders`, `hebra_links` y `hebra_status`.
- Creación y edición: `hebra_create_note`, `hebra_append_to_note` y `hebra_edit_note`
  (por sustituciones).
- Organización: `hebra_move_note`, `hebra_set_favorite` y `hebra_set_archived`.
- Papelera: `hebra_trash_note`, `hebra_restore_note` y `hebra_list_trash` (sin purga).
- Versiones anteriores: `hebra_list_versions`, `hebra_read_version` y
  `hebra_restore_version`.
- Adjuntos, solo lectura: `hebra_list_attachments` y `hebra_read_attachment` (hasta 5 MiB;
  imágenes PNG, JPEG, GIF y WebP, PDF, texto plano, Markdown, CSV y JSON).

Emparejado con Hebra por `pair`/`unpair` y llavero del sistema. Corre por dos vías: local
por stdio (`hebra-mcp serve`) y como conector remoto para claude.ai en
`https://mcp.hebra.pro`, con login OAuth mediante Lumbre. Falta el QA real de David sobre
su propia biblioteca desde claude.ai (lote C6 de `SPEC.md` §12); escribir adjuntos queda
fuera.

## Requisitos

- Node `>=24 <25` (usa `node:sqlite`, estable desde Node 22 y con FTS5 con
  `unicode61 remove_diacritics 2` probado en Node 24.19 / SQLite 3.53.3).
- Acceso SSH al repo privado `git@github.com:fodaveg/hebra.git` (submódulo de
  `vendor/hebra`): sin él, `git submodule update` falla.

## Emparejar (L2)

```sh
hebra-mcp pair [--lumbre https://app.lumbre.pro] [--label "Claude (hebra-mcp)"]
claude mcp add hebra -- hebra-mcp serve
hebra-mcp unpair   # borra los secretos del llavero y el directorio de datos
```

`pair` abre Lumbre en el navegador (o imprime la URL), recibe el código en un listener
de `127.0.0.1` y pide acceso a la biblioteca: se aprueba en Hebra > Ajustes >
Sincronización. Antes de guardar nada enseña en la terminal hasta tres títulos para que
confirmes que es tu biblioteca. Los secretos van al llavero del sistema (servicio
`hebra-mcp`, `@napi-rs/keyring`), nunca a ficheros, variables de entorno ni argumentos.
Con una identidad ya guardada (tras revocar la conexión en Lumbre), `pair` solo renueva
la credencial. Contrato completo: `SPEC.md` §7.

## Almacén de secretos: llavero o fichero

Por defecto, `serve`, `pair` y `unpair` guardan los secretos en el llavero del sistema.
`HEBRA_MCP_SECRET_STORE=file` los guarda en su lugar en un JSON (`secrets.json`) dentro
del directorio de datos, en 0600 y con escritura atómica: solo pensado para el
contenedor Linux del conector remoto (`SPEC.md` §12.3), donde no hay Secret Service y
`@napi-rs/keyring` caería en silencio a keyutils, que no persiste tras reiniciar. Nunca
es un fallback automático: hay que pedirlo explícitamente, y un valor que no sea `file`
ni `keychain` falla en vez de arrancar con uno de los dos por sorpresa.

## Conector remoto de claude.ai (`serve-http`)

Para claude.ai (web, móvil y sesiones en la nube), hebra-mcp corre como servidor HTTP en
un contenedor del servidor de Lumbre, en `https://mcp.hebra.pro` (`SPEC.md` §12). Claude
se conecta mediante el OAuth público de Hebra MCP; Lumbre autentica al propietario y
muestra el consentimiento:

```sh
hebra-mcp serve-http            # requiere configuración de backchannel
hebra-mcp oauth-revoke-all      # corta localmente todos los tokens OAuth
```

- `HEBRA_MCP_BACKCHANNEL_SECRET` (32–512 caracteres) es exclusivo de Hebra MCP y se
  provisiona en ambos servidores sin versionar su valor. El servidor necesita su
  dispositivo ya emparejado; el login de Lumbre no entrega la clave de biblioteca.
- En el contenedor, `oauth-revoke-all` actúa sobre el volumen compartido sin abrir la
  biblioteca; el emparejado y los comandos que sí la abren conservan el bloqueo de escritor.
- Entorno, sin secretos: `HEBRA_MCP_HTTP_PORT` (8787), `HEBRA_MCP_HTTP_LISTEN`
  (`127.0.0.1`; en el contenedor, `0.0.0.0`), `HEBRA_MCP_PUBLIC_URL`
  (`https://mcp.hebra.pro`) y, para los secretos del dispositivo,
  `HEBRA_MCP_SECRET_STORE=file`.
- En claude.ai se añade el conector con la URL `https://mcp.hebra.pro/mcp`. El navegador
  pasa por el login y consentimiento de Lumbre; Claude recibe un access token de 1 h y un
  refresh rotatorio (la autorización dura hasta 30 días). La gestión de concesiones está
  en `/integrations/hebra-mcp` de Lumbre.
- `serve-http` siempre es el escritor único: si otro proceso tiene `writer.lock`, no
  arranca.

## Clonar

```sh
git clone --recurse-submodules git@github.com:fodaveg/hebra-mcp.git
# o, si ya clonaste sin submódulos:
git submodule update --init --recursive
```

## Por qué un submódulo

Hebra es un repo privado y sin licencia; hebra-mcp es público. No se copia ni una línea
de su código: `vendor/hebra` es un submódulo de git fijado a un commit concreto, y
`scripts/build.mjs` lo empaqueta con esbuild. Lo que exporta el punto de entrada Node de
Hebra (`vendor/hebra/src/lib/library/node.ts`) entra por `src/hebra.ts`; lo que no
exporta, por el alias `$lib` → `vendor/hebra/src/lib` (la convención de SvelteKit que
usa Hebra). `scripts/check-no-hebra-code.mjs`
comprueba que ningún fichero versionado fuera de `vendor/` es idéntico, byte a byte, a
uno del submódulo.

## Instalar la skill opcional

La skill `hebra` vive en `skills/hebra/`. No es necesaria para usar el MCP, pero enseña al
agente qué puede y qué no puede hacer, cómo editar por sustituciones y qué hacer con cada
error. Se instala desde este repositorio con [`skills`](https://skills.sh) (requiere
Node.js), que la deja en `~/.agents/skills/hebra` y la enlaza en cada cliente elegido:

```sh
npx --yes skills add fodaveg/hebra-mcp -g -y \
  --skill hebra \
  --agent codex claude-code
```

Para actualizarla tras un cambio en `skills/hebra/`, se repite el mismo comando.

## Build y tests

```sh
npm install
npm run build            # esbuild -> dist/
npm run typecheck        # tsc --noEmit
npm test                 # vitest run --maxWorkers=1
npm run check:bundle     # build + grep de dist/ (nada de Tauri, $app ni DOM)
npm run check:no-hebra-code
npm run check            # los cuatro anteriores
```

Los tests de `test/library-cases.node.test.ts` ejecutan los **casos compartidos** del
almacén de Hebra (`vendor/hebra/src/lib/library/cases/library-cases.json`, el mismo
fichero que Hebra corre contra su motor TypeScript y contra Rust) sobre el adaptador
`node:sqlite` de `src/store/sqlite-conn-node.ts`: si un caso pasa aquí y falla en Hebra
(o al revés), el almacén de Node se ha desviado del contrato (SPEC.md, R2/R3).

## Estructura

- `vendor/hebra/` — submódulo, fijado a un SHA. Nunca se edita desde este repo.
- `src/store/sqlite-conn-node.ts` — adaptador `node:sqlite` → `SqliteConn` (la interfaz
  que espera `sqlite-engine.ts` de Hebra, por duck typing con `@sqlite.org/sqlite-wasm`).
- `src/store/blob-store-fs.ts` — adjuntos en disco (`<dir>/blobs/aa/bb/<sha256>`,
  escritura atómica): la caché de adjuntos del motor, donde queda lo que baja
  `hebra_read_attachment` del relé. hebra-mcp no escribe adjuntos por ninguna otra vía.
- `src/store/node-port.ts`, `src/store/types.ts` — el puerto de lectura/escritura propio
  de hebra-mcp sobre el motor (`HebraLibraryPort`): deliberadamente más estrecho que el
  `LibraryStorePort` completo de Hebra, ver el comentario de cabecera de `node-port.ts`.
- `scripts/build.mjs`, `scripts/check-bundle.mjs`, `scripts/check-no-hebra-code.mjs` —
  build y los dos checks que corre `npm run check` junto con `typecheck` y `test`.
