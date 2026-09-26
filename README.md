# hebra-mcp

Servidor MCP que da a Claude acceso de lectura (y, en un lote posterior, de creación) a
la biblioteca de notas de [Hebra](https://github.com/fodaveg/hebra), sin pasar por un
relé que pueda leer el contenido: el sync va cifrado de punta a punta y hebra-mcp se
vincula como un dispositivo más de la biblioteca. Detalle completo en `SPEC.md`.

Este es el estado del **lote L0** (esqueleto y almacén en Node): todavía no hay
servidor MCP ni emparejado con Hebra; solo el almacén (SQLite sobre `node:sqlite`) y un
puerto de lectura/escritura sobre él, verificados con los casos de prueba compartidos
del propio motor de Hebra.

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
  escritura atómica). v1 de hebra-mcp no sirve adjuntos; existe porque el motor de Hebra
  siempre necesita un `BlobBytesStore`.
- `src/store/node-port.ts`, `src/store/types.ts` — el puerto de lectura/escritura propio
  de hebra-mcp sobre el motor (`HebraLibraryPort`): deliberadamente más estrecho que el
  `LibraryStorePort` completo de Hebra, ver el comentario de cabecera de `node-port.ts`.
- `scripts/build.mjs`, `scripts/check-bundle.mjs`, `scripts/check-no-hebra-code.mjs` —
  build y los dos checks de cierre de L0.
