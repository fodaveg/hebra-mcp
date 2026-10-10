# hebra-mcp

Servidor MCP que da a Claude acceso de lectura y escritura (crear, añadir, leer y añadir
por apartados, editar por sustituciones puntuales, mover a carpetas existentes, marcar como favoritas, archivar,
mandar a la papelera y sacar de ella, restaurar versiones anteriores de notas, leer y
añadir adjuntos, crear y renombrar carpetas, y listar los ficheros sueltos y mandarlos a
la papelera o sacarlos; nunca purgar ni vaciar la papelera, mover ni borrar carpetas,
cambiar ni borrar adjuntos, ni crear, renombrar, mover o reemplazar un fichero suelto ni
leer su contenido; `SPEC.md` §5) a
la biblioteca de notas de [Hebra](https://github.com/fodaveg/hebra), sin pasar por un
relé que pueda leer el contenido: el sync va cifrado de punta a punta y hebra-mcp se
vincula como un dispositivo más de la biblioteca. Detalle completo en `SPEC.md`.

Estado a 9 de octubre de 2026 (versión 0.4.0): el servidor MCP tiene 28 herramientas
(detalle en `SPEC.md` §5):

- Lectura: `hebra_search`, `hebra_list_notes`, `hebra_read_note`, `hebra_list_tags`,
  `hebra_list_folders`, `hebra_links` y `hebra_status`.
- Creación y edición: `hebra_create_note`, `hebra_append_to_note` y `hebra_edit_note`
  (por sustituciones). `hebra_append_to_note` acepta un `operationId` opcional (10 oct
  2026): con él, reintentar tras perder la respuesta (un despliegue, `busy_other_instance`)
  no vuelve a añadir el texto y devuelve lo guardado con `replayed: true`, durante 24 h;
  sin él, cada llamada añade.
- Notas por apartados (D11): `hebra_note_outline` da el esquema de una nota (apartados,
  niveles, líneas y tamaños, sin cuerpo; limit 1-500, def. 200); `hebra_read_note` con
  `heading` lee solo un apartado (subapartados incluidos) y `hebra_append_to_note` con
  `heading` añade al final de uno; si el título se repite, `headingOccurrence`.
  `hebra_search` devuelve `heading`, el apartado del fragmento. Registrar una decisión en
  un apartado son dos llamadas pequeñas (esquema y añadir), sin pasar la nota entera por
  el contexto. Las escrituras devuelven la prueba de lo guardado, leída de la nota
  guardada: `revision`, `totalChars` y el final del texto (`appended.tail` en
  `hebra_append_to_note`, `applied` en `hebra_edit_note`); con una copia de conflicto no
  hay prueba. Un apartado es un encabezado `#` hasta el siguiente de su nivel o menor; los
  encabezados Setext (`===`, `---`) no cuentan.
- Organización: `hebra_move_note`, `hebra_set_favorite` y `hebra_set_archived`.
- Papelera: `hebra_trash_note`, `hebra_restore_note` y `hebra_list_trash` (sin purga).
- Ficheros sueltos (D10; los recursos con carpeta propia que no cuelgan de una nota, como
  un `.base` o un PDF): `hebra_list_files` (los vivos por nombre o, con `trashed: true`,
  los de la papelera; limit 1-100, def. 50), `hebra_trash_file` y `hebra_restore_file`.
  Sin purga y sin leer su contenido, crearlos, renombrarlos, moverlos ni reemplazarlos.
  La versión 0.3.0 o posterior trae las tres de ficheros sueltos (D10).
- Versiones anteriores: `hebra_list_versions`, `hebra_read_version` y
  `hebra_restore_version` (paginadas: limit 1-200, def. 50).
- Adjuntos: `hebra_list_attachments` (paginados: limit 1-200; sin limit, todos) y `hebra_read_attachment`
  (hasta 5 MiB descifrados; imágenes PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON;
  lectura de texto por tramos: offset, maxChars 1–100 000, def. 100 000), y
  `hebra_add_attachment` (D9: los mismos tipos y tope, en base64; queda como
  `![[sha256:H|nombre]]` al final de la nota y sube con el sync). Sin cambiar ni borrar.
- Carpetas (D9): `hebra_create_folder` y `hebra_rename_folder`, con un único
  `folder_unavailable` para todo lo privado. Sin mover ni borrar.

Fuera del MCP, `hebra-mcp checkout` y `apply` sacan notas como ficheros `.md` y las
devuelven (D12, 10 oct 2026; ver «Ficheros de trabajo» abajo).

Emparejado con Hebra por `pair`/`unpair` y llavero del sistema. Corre por dos vías: local
por stdio (`hebra-mcp serve`) y como conector remoto para claude.ai en
`https://mcp.hebra.pro`, con login OAuth mediante Lumbre. Falta el QA real de David sobre
su propia biblioteca desde claude.ai (lote C6 de `SPEC.md` §12). Para que un adjunto de
5 MiB quepa en el conector remoto, el borde (`deploy/mcp-hebra-pro.caddy`) admite cuerpos
de hasta 8 MB desde D9 (la app corta en 7 514 796 bytes).

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

## Ficheros de trabajo (`checkout` y `apply`)

Para editar notas con herramientas normales (`rg`, `sed`, un script, un formateador): se sacan
como `.md`, se editan y se devuelven. SQLite sigue mandando; es el mismo dispositivo que
`serve` (D12, `SPEC.md` §13).

```sh
hebra-mcp checkout --dir trabajo --consulta "TestFlight"   # o --all, --titulo "…", --carpeta "Proyectos"
# … editar trabajo/**/*.md …
hebra-mcp apply --simular        # el diff, sin escribir nada
hebra-mcp apply                  # devuelve solo las cambiadas; imprime el lote
hebra-mcp undo --lote <lote>     # deshace ese lote
hebra-mcp status                 # editadas sin devolver, en conflicto, que faltan…
hebra-mcp diff [--stat] [ficheros…]
```

- `apply` reescribe el cuerpo entero comprobando la base: si la nota cambió en Hebra mientras
  tanto, tu versión queda en una copia de conflicto visible (`--conflicto rechazar`: no escribe
  y la lista). Repetir un `apply` cortado no duplica nada.
- Lo privado (`config.json`), lo bloqueado, la papelera, las archivadas y las copias de conflicto
  no salen.
- No crea ni borra notas: un `.md` nuevo o renombrado no se devuelve. Sin adjuntos.
- Si otra sesión tiene `serve` abierto, la orden le pasa las escrituras por `writer.sock`.

## Almacén de secretos: llavero o fichero

Por defecto, `serve`, `pair` y `unpair` guardan los secretos en el llavero del sistema.
`HEBRA_MCP_SECRET_STORE=file` los guarda en su lugar en un JSON (`secrets.json`) dentro
del directorio de datos, en 0600 y con escritura atómica: solo pensado para el
contenedor Linux del conector remoto (`SPEC.md` §12.3), donde no hay Secret Service y
`@napi-rs/keyring` caería en silencio a keyutils, que no persiste tras reiniciar. Nunca
es un fallback automático: hay que pedirlo explícitamente, y un valor que no sea `file`
ni `keychain` falla en vez de arrancar con uno de los dos por sorpresa.

## Conector remoto de Claude y Codex (`serve-http`)

Para claude.ai (web, móvil y sesiones en la nube), hebra-mcp corre como servidor HTTP en
un contenedor del servidor de Lumbre, en `https://mcp.hebra.pro` (`SPEC.md` §12). Claude
o Codex se conectan mediante el OAuth público de Hebra MCP; Lumbre autentica al propietario y
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
- Codex usa el mismo recurso `https://mcp.hebra.pro/mcp`, su CIMD oficial
  `https://chatgpt.com/oauth/codex/client.json` o DCR y un callback local HTTP
  `127.0.0.1`/`localhost` en `/callback` con puerto dinámico. Lumbre exige el mismo
  login y consentimiento; el servidor no entrega acceso por registrar al cliente.
  El soporte local debe publicarse también en el broker de Lumbre antes de usarlo;
  las pruebas sintéticas no acreditan el login real de Codex en producción.
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
  escritura atómica): el almacén de adjuntos del motor, donde queda lo que baja
  `hebra_read_attachment` del relé y lo que añade `hebra_add_attachment` (`blobPut` del
  motor, solo desde el escritor). hebra-mcp no escribe adjuntos por ninguna otra vía.
- `src/store/node-port.ts`, `src/store/types.ts` — el puerto de lectura/escritura propio
  de hebra-mcp sobre el motor (`HebraLibraryPort`): deliberadamente más estrecho que el
  `LibraryStorePort` completo de Hebra, ver el comentario de cabecera de `node-port.ts`.
- `src/workdir/`, `src/store/body-writes.ts` — ficheros de trabajo (`checkout`, `apply`,
  `undo`, `status`, `diff`; `SPEC.md` §13): nombres, diff propio, la carpeta `.hebra-d` y
  la única escritura de cuerpo entero de hebra-mcp, solo en esta vía local.
- `scripts/build.mjs`, `scripts/check-bundle.mjs`, `scripts/check-no-hebra-code.mjs` —
  build y los dos checks que corre `npm run check` junto con `typecheck` y `test`.
