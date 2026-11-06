# hebra-mcp

Servidor MCP que da a Claude acceso de lectura y escritura (crear, añadir, leer y añadir
por apartados, editar por sustituciones puntuales, mover a carpetas existentes, marcar como favoritas, archivar,
mandar a la papelera y sacar de ella, restaurar versiones anteriores de notas, leer y
añadir adjuntos, crear y renombrar carpetas, listar los ficheros sueltos, mandarlos a
la papelera o sacarlos, leer su contenido, reemplazar el texto de uno, crear uno de texto
y renombrarlos, moverlos o duplicarlos, crear un ID nuevo del JDex, auditar el sistema
Johnny.Decimal y archivar notas, ficheros o carpetas dentro de un ID; nunca purgar ni vaciar
la papelera, borrar carpetas ni moverlas fuera de un ID, cambiar ni borrar adjuntos, ni purgar un fichero suelto; `SPEC.md` §5) a
la biblioteca de notas de [Hebra](https://github.com/fodaveg/hebra), sin pasar por un
relé que pueda leer el contenido: el sync va cifrado de punta a punta y hebra-mcp se
vincula como un dispositivo más de la biblioteca. En el conector remoto, el servidor es
ese dispositivo y custodia las claves: quien tenga acceso root al servidor puede leer las
notas de las cuentas conectadas. Detalle completo en `SPEC.md`.

Estado a 5 de noviembre de 2026: el servidor MCP tiene 46 herramientas
(detalle en `SPEC.md` §5):

- Lectura: `hebra_search`, `hebra_grep`, `hebra_list_notes`, `hebra_read_note`,
  `hebra_list_tags`, `hebra_list_properties`, `hebra_query_properties`,
  `hebra_list_folders`, `hebra_links` y `hebra_status`.
- Texto exacto (D13): `hebra_grep` busca un literal o una expresión regular línea a línea
  (como grep) y devuelve la nota, la línea, `heading` y, si se pide, contexto; sirve para
  una cadena exacta, un patrón o todas sus apariciones, y `hebra_search` para buscar por
  palabras (FTS5, sin tildes). `hebra_read_note` con `lines: {from, to}` lee solo esas
  líneas. Con un tope de tiempo (`cutoff` y `nextCursor` para seguir) y sin ningún recuento
  que delate las notas privadas. Medido sobre unos 20 MB: entre 8 y 118 ms por consulta.
- Creación y edición: `hebra_create_note`, `hebra_append_to_note` y `hebra_edit_note`
  (por sustituciones). `hebra_append_to_note` acepta un `operationId` opcional (10 oct
  2026): con él, reintentar tras perder la respuesta (un despliegue, `busy_other_instance`)
  no vuelve a añadir el texto y devuelve lo guardado con `replayed: true`, durante 24 h;
  sin él, cada llamada añade.
- Sustitución en lote (D14): `hebra_replace_in_notes` cambia un texto o un patrón (con las
  reglas de `hebra_grep`) en hasta 200 notas, siempre en dos pasos. `mode: "simulate"` no
  escribe nada: devuelve un `planId` y, por nota, las coincidencias y las líneas antes y
  después, para revisarlo. `mode: "apply"` con ese `planId` y un `operationId` aplica
  exactamente lo simulado, con una versión anterior forzada de cada nota; una nota que
  cambió entre medias deja una copia de conflicto. El informe dice qué entró, qué chocó y
  qué no se tocó, y repetir con el mismo `operationId` no duplica nada y completa lo
  pendiente. `mode: "undo"` deshace el lote entero durante 7 días (no toca lo que se cambió
  después). Ninguna nota privada entra en el plan ni en los recuentos.
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
- Organización: `hebra_move_note`, `hebra_set_favorite` y `hebra_set_archived`;
  `hebra_set_hidden` oculta del listado general de Hebra (una preferencia de vista, no
  privacidad) y `hebra_clear_conflict` marca como resuelta una copia de conflicto (D23).
- Papelera: `hebra_trash_note`, `hebra_restore_note` y `hebra_list_trash` (sin purga). Mover,
  mandar a la papelera y sacar aceptan `expectedRevision`: si el texto cambió desde esa lectura,
  `revision_conflict` sin escribir.
- Ficheros sueltos (D10; los recursos con carpeta propia que no cuelgan de una nota, como
  un `.base` o un PDF): `hebra_list_files` (los vivos por nombre o, con `trashed: true`,
  los de la papelera; limit 1-100, def. 50), `hebra_trash_file` y `hebra_restore_file`.
  Sin purga. La versión 0.3.0 o posterior trae las tres de ficheros sueltos (D10).
- Contenido de un fichero suelto (D15): `hebra_read_file` lo lee (un `.base` de Obsidian
  Bases, `.md`, `.txt`, `.json`, `.csv` o `.yaml` como texto, por tramos de 100 000
  caracteres; PNG, JPEG, GIF y WebP como imagen; PDF como recurso; hasta 5 MiB) y da el
  `sha256` de sus bytes. `hebra_replace_file_text` sustituye el texto ENTERO de uno de
  texto (hasta 1 000 000 bytes) con ese `sha256` como base: si alguien lo cambió desde la
  lectura, `file_changed` y no escribe; conserva el id, el nombre y la carpeta, devuelve el
  `sha256` y el tamaño de lo guardado, y guarda el contenido anterior 7 días para volver a
  él (`undoOperationId`). Un fichero privado responde `not_found` igual que uno inexistente.
- Crear, renombrar, mover y duplicar ficheros sueltos (D17, 12 oct 2026):
  `hebra_create_file` crea uno de texto (`.base`, `.yaml`, `.yml`, `.json`, `.csv` o `.txt`,
  hasta 1 000 000 bytes; un `.base` creado así sale en Bases de Hebra tras el sync),
  `hebra_rename_file` lo renombra sin cambiar la extensión y arregla las notas que lo incrustan
  (`relinked`, D23), `hebra_move_file` lo mueve a otra
  carpeta y `hebra_duplicate_file` lo copia (mismos bytes, hasta 5 MiB) con otro nombre. Las
  cuatro llevan `operationId`; un nombre que ya usa otro fichero visible de la carpeta
  responde `file_exists` con su id, y lo privado responde como lo inexistente.
- Versiones anteriores: `hebra_list_versions`, `hebra_read_version` y
  `hebra_restore_version` (paginadas: limit 1-200, def. 50).
- Adjuntos: `hebra_list_attachments` (paginados: limit 1-200; sin limit, todos) y `hebra_read_attachment`
  (hasta 5 MiB descifrados; imágenes PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON;
  lectura de texto por tramos: offset, maxChars 1–100 000, def. 100 000), y
  `hebra_add_attachment` (D9: los mismos tipos y tope, en base64; queda como
  `![[sha256:H|nombre]]` al final de la nota, o de un apartado con `heading`, y sube con el sync). Sin cambiar ni borrar.
- Carpetas (D9): `hebra_create_folder` y `hebra_rename_folder`, con un único
  `folder_unavailable` para todo lo privado. Sin borrar; moverlas, solo con `hebra_jd_move`.
- Johnny.Decimal (D18, 19 oct 2026), con el motor de
  [jdex-manager](https://github.com/fodaveg/jdex-manager) (submódulo `vendor/jdex-manager`):
  `hebra_jd_new_id` crea un ID nuevo en una categoría que ya existe (la nota del JDex con
  la plantilla de `00.03`, o la de serie, y por defecto la carpeta del ID), siempre en dos
  pasos: `mode: "simulate"` devuelve un `planId` y lo que se escribiría, sin escribir, y
  `mode: "apply"` con ese `planId` y un `operationId` lo escribe; reintentar con el mismo
  `operationId` completa lo que falte sin duplicar. `hebra_jd_audit` audita el sistema en
  solo lectura (IDs repetidos, carpetas sin nota, nombres que no casan…). Una categoría con
  algo privado responde `category_has_hidden`, sin decir qué. Sin categorías, áreas ni hijos
  «+».
- Mover a un ID (D19, 19 oct 2026): `hebra_jd_move` archiva una nota, un fichero suelto o
  una carpeta entera dentro de la carpeta de un ID del JDex (o de una subcarpeta suya), y
  crea la carpeta del ID y la subcarpeta si faltan; con `as`, otro nombre. Es la única forma
  de mover carpetas desde el MCP. Tres pasos: `simulate` (sin escribir), `apply` (con
  `operationId`) y `undo` (7 días). Una carpeta solo se rechaza por la configuración de
  privados, con el `folder_unavailable` de `hebra_rename_folder`; lo privado que tenga dentro
  se mueve con ella y sigue oculto, como al renombrarla.
- Espacios compartidos (H-L7) y organizaciones (D22): `hebra_list_spaces` devuelve los espacios
  que vería la persona de esa cuenta, con `spaceId`, `name`, su organización y `granted`;
  `hebra_list_organizations` lista en solo lectura sus organizaciones, miembros y espacios.
  Las herramientas de contenido aceptan `space`, solo con un espacio de `granted: true`; sin él
  trabajan en la biblioteca personal de la cuenta autenticada. Ser miembro de una organización
  no concede contenido, y pertenecer a un espacio u organización nunca abre la biblioteca
  personal de otro miembro. Privacidad: `hebra_list_organizations` entrega el nombre y el
  `accountId` de otros miembros de la organización al proveedor de IA del cliente conectado.

Fuera del MCP, `hebra-mcp checkout` y `apply` sacan notas como ficheros `.md` y las
devuelven (D12, 10 oct 2026; ver «Ficheros de trabajo» abajo).

Emparejado con Hebra por `pair`/`unpair` y llavero del sistema. Corre por dos vías: local
por stdio (`hebra-mcp serve`) y como conector remoto para claude.ai en
`https://mcp.hebra.pro`. El conector remoto identifica a cada persona con Sumego y Lumbre
comprueba que esa cuenta sea propietaria del dispositivo y la bóveda que autoriza. Para que un adjunto de
5 MiB quepa en el conector remoto, el borde (`deploy/mcp-hebra-pro.caddy`) admite cuerpos
de hasta 8 MB desde D9 (la app corta en 7 514 796 bytes).

## Requisitos

- Node `>=24 <25` (usa `node:sqlite`, estable desde Node 22 y con FTS5 con
  `unicode61 remove_diacritics 2` probado en Node 24.19 / SQLite 3.53.3).
- Acceso SSH al repo privado `git@github.com:fodaveg/hebra.git` (submódulo de
  `vendor/hebra`): sin él, `git submodule update` falla.

## Emparejar (L2)

El comando `hebra-mcp` es un lanzador en `~/.local/bin` que ejecuta `dist/cli.mjs` con Node 24
(no `npm link`: el `node` por defecto puede ser otra versión). Cómo instalarlo: apartado
"Instalar el comando `hebra-mcp`" de `skills/hebra/SKILL.md`. `pair` necesita una terminal
real (TTY).

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
ni `keychain` falla en vez de arrancar con uno de los dos por sorpresa. En ese modo,
los secretos globales del conector viven aparte, en `control/secrets.json` (D22,
`deploy/README-deploy.md`).

## Conector remoto de Claude y Codex (`serve-http`)

Para claude.ai (web, móvil y sesiones en la nube), hebra-mcp corre como servidor HTTP en
un contenedor del servidor de Lumbre, en `https://mcp.hebra.pro` (`SPEC.md` §12). Claude
o Codex se conectan mediante el OAuth público de Hebra MCP. Sumego identifica a la persona;
Lumbre comprueba la propiedad de la biblioteca y emite la concesión:

```sh
hebra-mcp serve-http            # requiere configuración de backchannel
hebra-mcp account-remove <account-id> # retira solo la cuenta indicada
hebra-mcp oauth-revoke-all      # corta localmente todos los tokens OAuth
```

- `HEBRA_MCP_BACKCHANNEL_SECRET` (32–512 caracteres) es exclusivo de Hebra MCP y se
  provisiona en ambos servidores sin versionar su valor. Ningún login entrega la clave de
  biblioteca: cada persona aprueba su dispositivo en Hebra y el servidor guarda la clave en
  su directorio aislado del volumen cifrado. El aislamiento separa cuentas, pero no protege
  frente al operador con acceso root, que puede leer esas claves y notas.
- En el contenedor, `oauth-revoke-all` actúa sobre el volumen compartido sin abrir la
  biblioteca; el emparejado y los comandos que sí la abren conservan el bloqueo de escritor.
- `account-remove` es una operación administrativa local: con el daemon activo usa su
  socket protegido; sin él toma el bloqueo global y trabaja sin listener HTTP. El ID es
  el identificador opaco del registro de cuentas, no el email ni el `sub` de Sumego.
- Entorno, sin secretos: `HEBRA_MCP_HTTP_PORT` (8787), `HEBRA_MCP_HTTP_LISTEN`
  (`127.0.0.1`; en el contenedor, `0.0.0.0`), `HEBRA_MCP_PUBLIC_URL`
  (`https://mcp.hebra.pro`), `LUMBRE_APP_ORIGIN` (`https://app.lumbre.pro`: el origen de
  Lumbre, el mismo que su `ORIGIN`; la URL de consentimiento de otro origen se rechaza) y,
  para los secretos del dispositivo, `HEBRA_MCP_SECRET_STORE=file`. La capacidad se regula
  por memoria real, sin máximo de cuentas (D22): `HEBRA_MCP_CONTEXT_IDLE_MS` (120000),
  `HEBRA_MCP_OPEN_WAIT_MS` (20000) y `HEBRA_MCP_MEMORY_HIGH_WATER` (`80%` del límite del
  contenedor; admite `0.8`, `80%` o bytes). Las dos primeras dicen cuánto tarda en cerrarse una
  biblioteca sin uso y cuánto espera una apertura o una llamada antes del 503 con `Retry-After`; la
  tercera, a partir de qué memoria se cierra antes lo que no se usa y hasta dónde llega lo que hay
  en curso (aperturas y llamadas apartan memoria mientras duran). `mem_limit` de `deploy/compose.yml` no
  cuenta personas: es la barrera de la máquina compartida y su valor sale de la medición de
  aceptación. Para más capacidad se sube ese límite o se añade máquina.
- Para volver a una imagen anterior a los secretos globales (`control/secrets.json`), con el
  servicio parado y antes de arrancarla, `hebra-mcp control-secrets-rollback`; el procedimiento
  está en `deploy/README-deploy.md`.
- En claude.ai se añade el conector con la URL `https://mcp.hebra.pro/mcp`. El navegador
  pasa por Sumego y por el consentimiento de hebra-mcp; Claude recibe un access token de 1 h y un
  refresh rotatorio. La autorización caduca 30 días después de aprobarla o del último
  refresh, que la renueva en Lumbre; caducada, hay que volver a aprobarla. La gestión de
  concesiones está en `/integrations/hebra-mcp` de Lumbre.
- Codex usa el mismo recurso `https://mcp.hebra.pro/mcp`, su CIMD oficial
  `https://chatgpt.com/oauth/codex/client.json` o DCR y un callback local HTTP
  `127.0.0.1`/`localhost` en `/callback` con puerto dinámico. Lumbre exige el mismo
  login y consentimiento; el servidor no entrega acceso por registrar al cliente.
  El soporte local debe publicarse también en el broker de Lumbre antes de usarlo;
  las pruebas sintéticas no acreditan el login real de Codex en producción.
- Cada cuenta tiene su propia SQLite, blobs, secretos, privados, escritor y sync. El token
  autenticado selecciona la cuenta antes de ejecutar una herramienta; el cuerpo MCP no puede
  elegirla. David conserva su dispositivo y sus tokens anteriores sin reemparejar.

### Primera conexión remota

Si la cuenta todavía no tiene biblioteca en el servidor, el propio flujo de conexión inicia
el emparejado. La persona entra con Sumego, aprueba el dispositivo en Hebra > Ajustes >
Sincronización y confirma hasta tres títulos de su biblioteca. Solo después queda activa la
cuenta. Ya no se crea un dispositivo temporal en el Mac ni se copia por `scp` al servidor.

Una alta interrumpida queda aislada y bloqueada; al reiniciar, el servidor reanuda su limpieza
o revocación. Repetir la conexión no publica dos cuentas ni mezcla secretos.

### Qué puede ver cada persona

- Su biblioteca personal.
- Los espacios y el contenido de organizaciones para los que tenga membresía, concesión del
  recurso y permiso propio del agente.
- Nunca la biblioteca personal de otra persona, aunque compartan espacio u organización.

Quitar una membresía o un permiso corta solo ese contenido compartido. Cerrar sesión corta las
familias OAuth correspondientes; no borra la biblioteca. Retirar una cuenta es otra operación:
primero la bloquea, drena y revoca, y después borra únicamente sus datos. `oauth-revoke-all`
sigue siendo una revocación global de emergencia y no equivale a retirar una persona.

### Preguntas frecuentes

**¿Mikel puede ver la biblioteca de David si ambos están en la misma organización?** No. Solo
ve su biblioteca y el contenido compartido que sus permisos autoricen.

**¿David tiene que emparejar otra vez?** No. La migración conserva su dispositivo y las familias
OAuth existentes; si no se puede demostrar la propiedad del vínculo heredado, se detiene sin
reasignar ni borrar datos.

**¿Un healthcheck verde prueba el aislamiento?** No. El cierre exige las pruebas negativas de
dos cuentas de `SPEC.md` §12.10 y QA separado de biblioteca personal, espacios y organizaciones.

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
- `vendor/jdex-manager/` — submódulo público (MIT) del motor JD, fijado a un SHA; entra solo
  por `src/jd.ts` (`src/jd/public.ts`). Tampoco se edita desde aquí (D18).
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
- `src/store/replace*.ts`, `src/server/tools/replace-in-notes.ts` — `hebra_replace_in_notes`
  (D14): la sustitución línea a línea, su hilo con plazo, los planes en `library.sqlite` y
  simular, aplicar y deshacer en el escritor.
- `src/store/file-*.ts`, `src/server/tools/read-file.ts`, `replace-file-text.ts` —
  leer un fichero suelto y reemplazar el texto de uno (D15): tipos y topes, el reemplazo
  con la base comprobada en el turno del escritor (`fileReplace` del motor) y el contenido
  anterior guardado 7 días en `library.sqlite`.
- `src/store/file-verbs.ts`, `src/server/tools/loose-files.ts` — crear, renombrar, mover y
  duplicar un fichero suelto (D17): el choque de nombres y la regla de que el resultado no
  quede oculto, en el turno del escritor (`fileCreate`, `fileRename` y `fileMove` del motor).
- `scripts/build.mjs`, `scripts/check-bundle.mjs`, `scripts/check-no-hebra-code.mjs` —
  build y los dos checks que corre `npm run check` junto con `typecheck` y `test`.
