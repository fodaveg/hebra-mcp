# hebra-mcp: SPEC v1

Estado: borrador, 26 sep 2026. Tareas en Lumbre: proyecto «hebra-mcp» (anidado en «21.13 Hebra»).
Hechos de Hebra medidos en `~/code/hebra` en `cf883cb9` (26 sep 2026), solo lectura.

## 1. Objetivo

Dar a Claude (Claude Code y Claude Desktop) acceso a la biblioteca de notas de Hebra mediante un
servidor MCP que **lee** la biblioteca y **crea** contenido sin riesgo de perder texto.

## 2. Aceptación de v1

1. David vincula `hebra-mcp` a su biblioteca desde el flujo de aprobación de Hebra
   (Ajustes > Sincronización) y el proceso descarga la biblioteca completa.
2. Desde Claude Code, las ocho herramientas de §5 responden con el esquema de §5.
3. Una nota creada o ampliada desde Claude aparece en Hebra (Mac e iPhone) tras un ciclo de sync.
4. Si Claude añade texto a una nota que David está editando a la vez, aparece una copia de
   conflicto visible en Hebra y ningún texto se pierde.
5. Ninguna nota de una carpeta o etiqueta privada llega a Claude por ninguna herramienta
   (títulos, cuerpos, fragmentos de búsqueda, enlaces, backlinks ni recuentos).
6. Los logs no contienen títulos, cuerpos, consultas ni argumentos de herramientas.
7. Al revocar la conexión en Lumbre, el proceso deja de sincronizar y lo dice en `hebra_status`.

## 3. Decisiones de David (26 sep 2026, cerradas)

| # | Decisión | Motivo / descartes |
|---|---|---|
| D1 | **Dispositivo propio**: proceso Node que se vincula a la biblioteca como un dispositivo más por el flujo de aprobación, con su propia SQLite y el MISMO motor de sync de Hebra. Transporte MCP: **stdio** primero; conector remoto más adelante. | El sync va cifrado de punta a punta: el relé de `app.lumbre.pro` no puede leer notas. Descartados: leer la SQLite del contenedor del Mac y un MCP en el servidor de Lumbre. |
| D2 | **v1 = leer y crear**: listar, buscar (FTS), leer notas, etiquetas, carpetas, enlaces y backlinks; crear nota nueva y añadir texto al final de una existente. **Nunca** reescribe, mueve, etiqueta ni borra. Un choque con una edición produce una copia de conflicto visible, como en Bear. | El motor ya hace la copia de conflicto (§7 de la spec de Hebra). |
| D3 | **Ve toda la biblioteca salvo** carpetas o etiquetas marcadas como privadas en la configuración del MCP. El filtro vive en el MCP y se aplica antes de devolver nada a la IA. | |
| D4 | **Cuándo** (revisada el 26 sep 2026): **BEAR-22 queda cerrada** por decisión de David (la biblioteca actual es de prueba y la va a reimportar desde Obsidian). Se hacen **todos los lotes ya**, en orden L0 → L1 → L2 (en cuanto Lumbre despliegue L2a) → L3 → L4. Objetivo: que David use Hebra en serio con el MCP cuanto antes. | La versión anterior esperaba a BEAR-22 para todo lo que cambiara el sync o el vínculo en Hebra. |
| D5 | **Repo**: hebra-mcp es público y consume Hebra (privado, sin licencia) por submódulo fijado a un SHA, sin versionar código de Hebra. | Descartados: hacer hebra-mcp privado y publicar el núcleo de Hebra con licencia. |

## 4. Arquitectura

```
Claude Code / Desktop ──stdio(MCP)──► hebra-mcp (Node 24)
                                        ├─ servidor MCP: 8 herramientas + filtro de privados
                                        ├─ almacén: sqlite-engine.ts de Hebra sobre node:sqlite
                                        ├─ motor: LibrarySyncEngine de Hebra (sin cambios)
                                        └─ secretos: llavero del SO
                                              │ HTTPS, sobres HBV2 cifrados
                                              ▼
                                   relé de Lumbre (app.lumbre.pro)
                                   /api/integrations/hebra/library/v1/vaults/{syncVaultId}
```

### 4.1 Qué se reutiliza de Hebra (medido)

| Pieza | Fichero en Hebra | ¿Sirve en Node sin cambios? |
|---|---|---|
| Motor de sync | `src/lib/library/sync-engine.ts` (`LibrarySyncEngine.create`, `runRound`, `status`) | Sí: TS puro, recibe puerto, transporte, identidad y `vaultKey`. |
| Almacén | `src/lib/library/sqlite-engine.ts` | Sí: opera sobre `SqliteConn` (`exec`, `selectObject`, `selectObjects`, `selectValue`, líneas 119-124), por duck typing. Es el puerto TS de `src-tauri/src/library/store.rs` y ya pasa los casos compartidos `cases/library-cases.json` contra ambos motores. |
| Esquema | `src/lib/library/schema.sql` | Sí. FTS5 con `unicode61 remove_diacritics 2` (línea 225). **Probado** con `node:sqlite` de Node 24.19 (SQLite 3.53.3): «cancion» encuentra «canción». |
| Transporte | `src/lib/library/http-transport.ts` (`HttpLibraryTransport`) | Sí: `fetcher` inyectable, `globalThis.fetch` por defecto. Bearer `readToken`/`writeToken`. |
| Cifrado | `src/lib/vault/blob-v2/{frames,crypto}.ts` | Sí: AES-256-GCM, HKDF-SHA256 y SHA-256 sobre WebCrypto (`globalThis.crypto.subtle`). |
| Derivados | `src/lib/library/derive.ts` (`deriveNote`) | Sí: puro. |
| Vínculo | `src/lib/library/device-link.ts`, `device-link-transport.ts` | Sí en la lógica; ver §7 para lo que falta en Lumbre. |
| Emparejado con Lumbre | `src/lib/lumbre/client.ts` (`pairingUrl`, `/api/integrations/hebra/exchange` con PKCE) | La lógica sí; el retorno del código a un proceso sin navegador está **sin medir** (§7, P2). |

Lo que **no** sirve tal cual y resuelve hebra-mcp sin tocar Hebra:

- Alias `$lib` (tsconfig de Hebra) e import `schema.sql?raw` de Vite (`sqlite-engine.ts:17`): los
  resuelve el empaquetado (esbuild con alias y cargador de texto).
- Persistencia de identidad y credenciales (`identity-vault.ts`, `credential-vault.ts`: Keychain en
  Tauri, IndexedDB en web): hebra-mcp implementa esas interfaces sobre el llavero del SO (§6.1).
- Almacén de blobs: `MemoryBlobStore` por defecto; hebra-mcp implementa `BlobBytesStore` en disco.
  v1 no sirve adjuntos, así que solo guarda lo que el motor exija.
- Worker y OPFS de `web-port.ts`: no se usan. hebra-mcp construye su propio `LibraryPort` sobre
  `sqlite-engine.ts` en el mismo proceso.

### 4.2 Cómo consume hebra-mcp el código de Hebra

| Opción | ¿Cambia Hebra? | Problema |
|---|---|---|
| **Submódulo git de `fodaveg/hebra` fijado a un SHA + empaquetado con esbuild** | No | Solo compila quien tenga acceso al repo privado. |
| Copia del código dentro de hebra-mcp | No | Publica código de un repo **privado y sin licencia** en un repo **público**; además deriva del original y pierde la paridad que dan los casos compartidos. |
| Paquete publicado desde Hebra (subruta `exports`) | Sí | Espera a BEAR-22 y obliga a decidir licencia. |
| Workspace pnpm (monorepo) | Sí, mueve repos | Hebra no tiene `pnpm-workspace.yaml`; cambio de estructura en plena BEAR-22. |

**Recomendación: submódulo fijado a SHA** en `vendor/hebra`, empaquetado local con esbuild.
- Hebra no cambia.
- El SHA fijado hace el build reproducible.
- Actualizar es mover el submódulo y volver a pasar los casos compartidos.
- En el repo público no entra ni una línea de Hebra: `dist/` está en `.gitignore` y solo se versiona
  la referencia al submódulo.
- **Decidido por David (26 sep 2026)**: hebra-mcp sigue público y consume Hebra por submódulo
  privado fijado, sin copiar código de Hebra.
- La sesión de Hebra está haciendo ya (L6) un punto de entrada estable (`src/lib/library/node.ts` o una subruta
  de `exports`) y un esquema cargado sin `?raw` de Vite (petición P1, aceptada por la sesión de
  Hebra). Cuando llegue, el empaquetado dejará de depender de rutas internas; hasta entonces, submódulo
  con alias.

## 5. Herramientas MCP de v1

Reglas comunes:
- Las notas en la papelera nunca se devuelven.
- Las copias de conflicto se devuelven marcadas.
- Toda salida pasa por el filtro de privados (§6.3).
- Los identificadores son los `id` de nota del almacén.
- Las fechas van en ISO 8601.

| Herramienta | Entrada | Salida |
|---|---|---|
| `hebra_search` | `query` (texto, FTS5), `limit` (1-50, def. 20), `folder?` (ruta), `tag?` | `results: [{id, title, folderPath, tags, snippet, updatedAt}]` |
| `hebra_list_notes` | `folder?`, `tag?`, `cursor?`, `limit` (1-100, def. 50); orden por `updatedAt` descendente | `{notes: [{id, title, folderPath, tags, excerpt, updatedAt, isConflictCopy}], nextCursor}` |
| `hebra_read_note` | `id` o `title` (exactamente uno) | `{id, title, body, folderPath, tags, createdAt, updatedAt, isConflictCopy, conflictOf?}`. Con `title` ambiguo: error `ambiguous_title` con los candidatos `[{id, title, folderPath}]`. |
| `hebra_list_tags` | nada | `tags: [{tag, count}]` (anidadas como `a/b`) |
| `hebra_list_folders` | nada | `folders: [{id, path, count}]` |
| `hebra_links` | `id` | `{outgoing: [{ref, resolvedId?, title?}], backlinks: [{id, title}]}` |
| `hebra_create_note` | `body` (Markdown; el primer H1 es el título, como en Hebra), `folder?` (ruta existente; por defecto, la raíz) | `{id, title, folderPath}` |
| `hebra_append_to_note` | `id`, `text` (≤ 20 000 caracteres) | `{id, outcome: "saved" \| "conflict_copy", copyId?}` |
| `hebra_status` | nada | `{linked, lastSyncAt, lastSyncOutcome, pendingUpload, errorsByCode, writer: "this" \| "other_instance", revoked}`. Sin contenido de notas. |

Detalle de las escrituras (D2):
- `hebra_create_note` usa `noteCreate(folderId)` y después `noteSave` con los derivados de
  `deriveNote(body)` (`types.ts:445-447`, `NoteSaveInput` en `types.ts:104`). El cuerpo tiene un
  límite de 100 000 caracteres.
- `hebra_append_to_note`:
  1. Lee la nota (`noteRead`).
  2. Construye `body + "\n\n" + text`.
  3. Guarda con `noteSave` pasando `expectedLocalSeq` y `baseBodySha256` de lo leído.
  4. Lanza una ronda de sync.

  Si el almacén responde `redirected`, o la ronda produce `sync.conflict_copy` para esa nota, la
  salida es `conflict_copy` con el id de la copia. En Hebra no existe una operación de «añadir al
  final»: se construye así y nunca toca otro campo.
- No se exponen `noteMove`, `noteTrash`, `notePurge`, `folder*`, `file*` ni ninguna otra mutación de
  `LibraryStorePort`: el servidor ni siquiera las importa en su capa de herramientas.
- Los nombres exactos de los métodos del almacén para búsqueda, etiquetas y enlaces se fijan en L0
  leyendo `sqlite-engine.ts` y `graph-store.ts` en el SHA fijado.

## 6. Modelo de seguridad

### 6.1 Secretos y datos locales

El dispositivo acumula tres secretos:

| Secreto | Qué da | Origen |
|---|---|---|
| Credencial de Lumbre (`credentialId`, `readToken`, `writeToken`) | Acceso al relé | Canje con `/api/integrations/hebra/exchange` |
| Código de recuperación de la biblioteca | Contiene la clave de biblioteca, que descifra **toda** la biblioteca | `device-link.ts:437-446`, recibido del dispositivo que aprueba |
| Identidad del dispositivo (`opaqueDeviceId` y claves) | Identifica al dispositivo ante el relé | Generada en el dispositivo |

- **Dónde viven los secretos**: en el llavero del SO, con el servicio `hebra-mcp`, mediante
  `@napi-rs/keyring` (Keychain en macOS, libsecret en Linux, Credential Manager en Windows). Nunca en
  ficheros de configuración, variables de entorno ni argumentos de proceso (`security -w` los
  mostraría en `ps`).
- **Datos locales**:
  - SQLite en `~/Library/Application Support/hebra-mcp/` en macOS, o en `$XDG_DATA_HOME/hebra-mcp/`
    en Linux.
  - Permisos: directorio 0700, ficheros 0600.
  - En claro en disco, igual que la SQLite de las apps de Hebra; la protección en reposo es la del
    disco (FileVault).
- **Plataformas de v1**: macOS. Linux se cubre si `@napi-rs/keyring` funciona en Fedora (se mide en
  L2). Windows queda fuera de v1.

### 6.2 Revocación

- **Desde Lumbre**: Integraciones > Hebra > revocar la conexión de hebra-mcp. El relé rechaza sus
  tokens y el proceso pasa a `revoked: true` y deja de sincronizar. Es el mecanismo que ya indica
  Hebra en `LibrarySettingsDeviceLinks.svelte:308`.
- **Límite conocido**: revocar borra la credencial en Lumbre (`hebra-integration.ts:224-238`) y
  corta el relé, pero **no rota la clave de biblioteca** ni borra lo que el dispositivo ya descargó.
  `keyEpoch` está fijo a 1 en todo Hebra y la rotación está aplazada a una fase posterior
  (`docs/SPEC-HEBRA-COMO-BEAR.md:646-647`). Un hebra-mcp comprometido conserva la clave y la copia
  local. Es el mismo límite que cualquier dispositivo de Hebra hoy (R1).
- **En local**: `hebra-mcp unpair` borra los secretos del llavero y el directorio de datos.

### 6.3 Filtro de privados (D3)

- **Configuración**: `config.json` en el directorio de datos:
  `{ "privateFolders": ["Diario", "Salud/Médico"], "privateTags": ["privado", "diario"] }`.
- **Qué se oculta**: una nota queda oculta si está en una carpeta privada **o en cualquier
  subcarpeta**, o si tiene una etiqueta privada **o una descendiente** (`diario` oculta `diario/2026`).
- **Cuándo se evalúa**: al construir cada respuesta, a partir de los ids de carpeta y las etiquetas
  canónicas (`canonicalTag` de Hebra) del almacén, no del texto.
- **Qué no se filtra**: la configuración no viaja por sync; es del proceso local.
- **Dónde actúa**: en TODAS las salidas.
  - Búsqueda: la paginación rellena hasta `limit` con notas visibles.
  - Listados, lectura (una nota oculta responde `not_found`, igual que una inexistente).
  - Recuentos de `hebra_list_tags` y `hebra_list_folders`: las carpetas privadas no aparecen, y las
    etiquetas privadas o solo presentes en notas ocultas tampoco.
  - `outgoing` de `hebra_links`: un enlace a una nota oculta sale como `ref` sin resolver.
  - `backlinks`: omiten las notas ocultas.
- **Escrituras**: no pueden apuntar a una carpeta privada ni a una nota oculta; responden
  `not_found`. Una nota creada con una etiqueta privada queda oculta desde ese momento.
- **Cerrado ante la duda**: si una carpeta de `privateFolders` no existe (renombrada o borrada), el
  servidor responde a toda herramienta con `privacy_config_unresolved` hasta que se corrija la
  configuración. No se sirve nada con un filtro que no se puede aplicar.

### 6.4 Logs

- **Qué se registra**: solo eventos cerrados en stderr, como en §11 de la spec de Hebra
  (`sync.round`, `sync.record_error`, `sync.conflict_copy`), con ids opacos, códigos y recuentos.
- **Qué nunca se registra**: títulos, cuerpos, consultas de búsqueda ni argumentos de herramientas.
- Stdout es exclusivo del protocolo MCP.
- **Test**: un test ejecuta todas las herramientas con notas-cebo y comprueba que ningún texto de
  las notas aparece en stderr.

### 6.5 Contenido de notas como entrada a la IA

El texto de una nota puede contener instrucciones dirigidas al modelo. El daño posible está acotado
por D2: sin borrar, mover ni reescribir, lo peor que puede hacer una instrucción inyectada es crear
notas o añadir texto, siempre visible y revertible en Hebra.

## 7. Emparejado (primera vez)

Comando `hebra-mcp pair`, interactivo en terminal:

1. **Credencial de Lumbre**: genera la URL de emparejado con PKCE, igual que
   `LumbreClient.pairingUrl` (`/integrations/hebra?deviceId&label&code_challenge`). David la abre y
   aprueba en Lumbre. El proceso canjea el código en `/api/integrations/hebra/exchange` y comprueba
   la cuenta como `lumbre-pairing.ts`: un 404 al leer la bóveda significa otra cuenta, y se rechaza.
   - **Hoy no funciona sin cambiar Lumbre (P2, medido por la sesión de Hebra en Lumbre
     `7bffeca94`)**. El código vuelve por `hebra://lumbre/connect#code=…` o por
     `<webOrigin>/lumbre/connect#code=…`, y `webOrigin` pasa por `isAllowedHebraOrigin`
     (`hebra-http.ts:82-90`), que en producción solo admite `HEBRA_ALLOWED_ORIGINS` y
     `http://tauri.localhost`. No hay modo de mostrar el código para copiarlo.
   - **Cambio en Lumbre** (L2a, aceptado y en curso por la sesión de Lumbre el 26 sep 2026; pasa
     revisión de seguridad antes de desplegar). Contrato:
     - `webOrigin` `http://127.0.0.1:<cualquier puerto>` o `http://[::1]:<puerto>`; `localhost` por
       nombre NO (RFC 8252 §8.3).
     - Ruta de retorno fija: `/lumbre/connect`.
     - En loopback, PKCE S256 obligatorio en `/pair` y `code_verifier` obligatorio en `/exchange`.
     - La credencial aparece en Integraciones > Hebra con la etiqueta del cliente y se revoca como las
       demás.
     - Los orígenes actuales no cambian.
     - Retorno con el código en la **query** (`?code=…&apiOrigin=…`), porque el `#fragmento` no llega
       al servidor.
   - **hebra-mcp**: abre un servidor HTTP efímero en `127.0.0.1` con un puerto libre, acepta solo
     `GET /lumbre/connect`, lee `code` y `apiOrigin` y se cierra.
2. **Petición de vínculo**: `POST /device-links` con la plataforma y la etiqueta
   «Claude (hebra-mcp)», saneada con `sanitizeDeviceLabel`. El terminal muestra la verificación que
   David debe ver en Hebra.
3. **Aprobación**: David aprueba en Hebra > Ajustes > Sincronización. El proceso sondea cada 2 s
   (`DEVICE_LINK_POLL_MS`), desenvuelve el código de recuperación y ejecuta `verifyGrantedAccess`:
   lee hasta 4 páginas y muestra títulos descifrados para que David confirme que es su biblioteca.
   Es el único momento en que se imprimen títulos, y es en su terminal, no en logs.
4. **Guardado**: los secretos van al llavero (§6.1). Después, `libraryConnect` y la primera descarga
   completa.
5. **Registro en Claude**: `claude mcp add hebra -- hebra-mcp serve`.

## 8. Ejecución y concurrencia

- **Escritor único**: stdio lanza **un proceso por sesión de Claude**, y dos sesiones abiertas serían
  dos escritores sobre la misma SQLite.
  - Solución de v1: un fichero de bloqueo en el directorio de datos, con PID y comprobación de
    vida. El proceso que lo tiene sincroniza y escribe.
  - Los demás abren la SQLite en solo lectura (WAL), sirven las lecturas y responden a las
    escrituras con `busy_other_instance`.
  - `hebra_status` dice quién es el escritor.
  - `syncLeaseAcquire` del motor solo coordina dentro de un proceso, así que no basta.
- **Ritmo de sync**:
  - Al arrancar: una ronda, y las lecturas esperan como mucho 10 s a que termine.
  - Después, una ronda cada 30 s mientras el proceso vive.
  - Una ronda justo después de cada escritura.
  - En reposo, cada ronda es 1 petición HTTP y 0 escrituras (A6 de Hebra).
- **Adjuntos**: v1 no sirve adjuntos. Los blobs se bajan solo si el motor lo exige para completar
  una ronda.

## 9. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | El proceso tiene la clave completa de la biblioteca; revocar no la rota. | Llavero del SO, permisos 0600, `unpair` borra todo. Rotación, petición P4 a Hebra. |
| R2 | El submódulo fija un SHA; un cambio de Hebra en el contrato del almacén o del sync deja a hebra-mcp desfasado, y un dispositivo desfasado podría escribir registros que las apps nuevas no esperan. | Mover el submódulo es un paso explícito con los casos compartidos en verde. Petición P5: Hebra avisa cuando cambie el formato del sobre o el esquema. |
| R3 | `node:sqlite` no es `@sqlite.org/sqlite-wasm`: tipos de enlace (`undefined`, booleanos, BigInt) y `exec` con varias sentencias se comportan distinto. | L0 cierra con `cases/library-cases.json` en verde sobre el adaptador. Si no se puede, alternativa: la build de Node de sqlite-wasm que ya usan los tests de Hebra. |
| R4 | Dos procesos escritores sobre la misma SQLite. | Bloqueo de §8. |
| R5 | Una configuración de privados mal escrita expone notas. | Cerrado ante la duda (§6.3) y tests de subárbol, etiqueta anidada, backlinks, fragmentos y recuentos. |
| R6 | Un fallo de hebra-mcp en el emparejado o en las escrituras ensucia la biblioteca de David. | BEAR-22 está cerrada, así que L4 no espera a nada más que a L2 y L3. Aun así, L2 y L3 se prueban primero contra una bóveda de pruebas propia, creada en el relé de producción por la misma vía que `createTestVaultState` de Hebra (`test-vault.ts:178-189`): bóveda y credencial propias, aisladas de la biblioteca de David. No existe relé de staging. La biblioteca actual es de prueba y David la reimporta desde Obsidian, así que el riesgo es para la medición, no para los datos. |
| R7 | Lumbre no admite hoy devolver el código de emparejado a un CLI (P2). | L2a: redirección loopback con PKCE obligatorio, pedida a la sesión de Lumbre. L2 no empieza sin ella. |
| R9 | Aprobar exige que el dispositivo que aprueba tenga `recoveryExported` (`identity-vault.ts:151`) (P7). | **Cerrado**: David confirmó el 26 sep 2026 que exportó el código de recuperación en el Mac. Es un dato dicho por él, no medido en el contenedor: si la aprobación falla en L4 con ese motivo, se revisa esto primero. |
| R8 | El relé solo acepta las plataformas `mac`, `iphone`, `ipad` y `web` (`device-link.ts:117-121`); las copias de conflicto de hebra-mcp dirían «Mac». | v1 usa `mac` con la etiqueta «Claude (hebra-mcp)». Plataforma propia, petición P3 tras BEAR-22. |

## 10. Lotes

Leyenda: 🟢 no toca Hebra ni la biblioteca real · 🟡 no cambia Hebra, pero usa el relé o la
biblioteca real · 🔴 necesita cambios en Hebra o Lumbre, que hacen sus sesiones.
BEAR-22 está cerrada (D4): ningún lote espera ya por ella.
Orden: L0 → L1 → L2 (tras L2a) → L3 → L4. L5 y L6, en paralelo en la sesión de Hebra; L2a, en la de
Lumbre.

| Lote | Qué | Tipo | Criterio de cierre |
|---|---|---|---|
| **L0** Esqueleto y almacén en Node | Proyecto Node 24 ESM/TS; submódulo `vendor/hebra` fijado; esbuild con alias `$lib` y `.sql` como texto; adaptador `node:sqlite` → `SqliteConn`; `LibraryPort` propio sobre `sqlite-engine.ts`. | 🟢 | `cases/library-cases.json` en verde sobre el adaptador; el bundle no contiene imports de `@tauri-apps`, `$app` ni DOM (grep en `dist/`); ni una línea de Hebra versionada en hebra-mcp (grep del árbol). |
| **L1** Servidor MCP de lectura y filtro | Servidor stdio con `hebra_search`, `hebra_list_notes`, `hebra_read_note`, `hebra_list_tags`, `hebra_list_folders`, `hebra_links` y `hebra_status`, sobre una SQLite de prueba generada con el propio motor; `config.json` y filtro de §6.3; logs de §6.4. | 🟢 | Tests de contrato de cada herramienta; tests del filtro (subárbol, etiqueta anidada, fragmento de búsqueda, backlinks, recuentos, `not_found` y `privacy_config_unresolved`); test de notas-cebo sin texto en stderr; inspección con `npx @modelcontextprotocol/inspector`. |
| **L2a** Retorno loopback en Lumbre (P2) | `isAllowedHebraOrigin` admite `http://127.0.0.1:<puerto>` solo con PKCE S256. La implementa la sesión de Lumbre. | 🔴 (Lumbre, no Hebra; no toca el sync ni BEAR-22) | Un cliente con `webOrigin=http://127.0.0.1:<puerto>` y PKCE recibe el código; sin PKCE se rechaza. |
| **L2** Emparejado y secretos | `hebra-mcp pair` y `unpair`; llavero; comprobación de cuenta; `verifyGrantedAccess`; bóveda de pruebas propia. Depende de L2a. | 🟡 | Contra una bóveda de pruebas: emparejado completo, primera descarga y `hebra_status` con `linked: true`. Revocar en Lumbre deja `revoked: true`. `unpair` deja vacíos el llavero y el directorio. |
| **L3** Sync, escritor único y escrituras | Bucle de sync de §8; bloqueo; `hebra_create_note` y `hebra_append_to_note`. | 🟢 en tests (transporte en memoria de Hebra, `memory-transport.ts`) · 🟡 en vivo | Tests: nota creada visible en un segundo motor; añadir con edición concurrente produce copia de conflicto con los dos textos; segunda instancia responde `busy_other_instance`; ninguna herramienta llama a mutaciones fuera de D2 (test de la superficie importada). |
| **L4** Puesta en marcha con la biblioteca real | Emparejado real, configuración de privados de David, `claude mcp add`, QA de David. | 🟡 tras L2 y L3 | Los 7 puntos de §2 comprobados por David en su biblioteca. |
| **L5** Plataforma propia del dispositivo (opcional) | `agent` en el relé, en Ajustes y en `conflictDevice` para que Hebra diga «Claude». La implementa la sesión de Hebra; la parte del relé, la de Lumbre. hebra-mcp solo cambia la plataforma que declara. | 🔴 sesión de Hebra, después de L6; necesita también a Lumbre | Hebra la muestra; P3 cerrada. |
| **L6** Punto de entrada estable de Hebra (P1) | Hebra exporta `node.ts` o una subruta de `exports` con motor, almacén, transporte, vínculo y derivados; esquema sin `?raw`. La implementa la sesión de Hebra; hebra-mcp cambia su empaquetado para usarlo. | 🔴 sesión de Hebra, en curso desde el 26 sep 2026 | hebra-mcp compila sin alias `$lib` ni plugin de `?raw`, y los casos compartidos siguen en verde. |
| **Después de v1** | Conector remoto (HTTP), servir adjuntos, más escrituras. | Fuera de v1 | Nueva decisión de David. |

## 11. Pendiente

- **Peticiones a la sesión de Hebra**, enviadas el 26 sep 2026:
  - Aceptadas: P1 (L6, en curso) y P3 (L5, después de L6); P5, avisar de cambios de contrato.
  - Medidas el 26 sep 2026: P2 exige un cambio en Lumbre (L2a, aceptado y en curso por la sesión de Lumbre); P4 no
    hay rotación (R1); P6 bóveda de pruebas propia en el relé de producción (R6); P7 confirmada por
    David (R9 cerrado).
  - L2 no empieza sin L2a.
