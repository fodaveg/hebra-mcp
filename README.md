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

## Clonar

```sh
git clone --recurse-submodules git@github.com:fodaveg/hebra-mcp.git
# o, si ya clonaste sin submódulos:
git submodule update --init --recursive
```

## Por qué un submódulo

Hebra es un repo privado y sin licencia; hebra-mcp es público. No se copia ni una línea
de su código: `vendor/hebra` es un submódulo de git fijado a un commit concreto, y
`scripts/build.mjs` lo empaqueta con esbuild (alias `$lib` → `vendor/hebra/src/lib`,
igual que la convención de SvelteKit que usa Hebra, y un loader para los `import
'*.sql?raw'` de Vite que esbuild no trae de fábrica). `scripts/check-no-hebra-code.mjs`
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
