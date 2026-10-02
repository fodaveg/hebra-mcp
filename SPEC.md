# hebra-mcp: SPEC v1

Estado: borrador, 26 sep 2026. Tareas en Lumbre: proyecto «hebra-mcp» (anidado en «21.13 Hebra»).
Hechos de Hebra medidos en `~/code/hebra` en `cf883cb9` (26 sep 2026), solo lectura.

## 1. Objetivo

Dar a Claude (Claude Code y Claude Desktop) acceso a la biblioteca de notas de Hebra mediante un
servidor MCP que **lee** la biblioteca y **crea, edita y organiza** contenido sin riesgo de perder
texto (D2, ampliada el 28 sep 2026 y, con la papelera y las versiones anteriores, el 30 sep 2026).

## 2. Aceptación de v1

1. David vincula `hebra-mcp` a su biblioteca desde el flujo de aprobación de Hebra
   (Ajustes > Sincronización) y el proceso descarga la biblioteca completa.
2. Desde Claude Code, las veintiuna herramientas de §5 responden con el esquema de §5.
3. Una nota creada o ampliada desde Claude aparece en Hebra (Mac e iPhone) tras un ciclo de sync.
4. Si Claude añade texto a una nota que David está editando a la vez, aparece una copia de
   conflicto visible en Hebra y ningún texto se pierde.
5. Ninguna nota de una carpeta o etiqueta privada llega a Claude por ninguna herramienta
   (títulos, cuerpos, fragmentos de búsqueda, enlaces, backlinks ni recuentos).
6. Los logs no contienen títulos, cuerpos, consultas ni argumentos de herramientas.
7. Al revocar la conexión en Lumbre, el proceso deja de sincronizar y lo dice en `hebra_status`.

El conector remoto (D6) añade su propia aceptación en §12.7.

## 3. Decisiones de David (26 sep–2 oct 2026, cerradas)

| # | Decisión | Motivo / descartes |
|---|---|---|
| D1 | **Dispositivo propio**: proceso Node que se vincula a la biblioteca como un dispositivo más por el flujo de aprobación, con su propia SQLite y el MISMO motor de sync de Hebra. Transporte MCP: **stdio** primero; conector remoto más adelante (D6). | El sync va cifrado de punta a punta: el relé de `app.lumbre.pro` no puede leer notas. Descartados: leer la SQLite del contenedor del Mac y un MCP en el servidor de Lumbre (este último, revocado por D6). |
| D2 | **v1 = leer y crear**: listar, buscar (FTS), leer notas, etiquetas, carpetas, enlaces y backlinks; crear nota nueva y añadir texto al final de una existente. **Ampliada el 28 sep 2026** («me parecen ok tus decisiones del mcp. adelante con ellas»): 1) el MCP puede modificar notas existentes; 2) por **sustituciones puntuales** `{find, replace}` sobre la revisión leída, nunca reescribiendo el cuerpo entero (renombrar = editar el H1); 3) primer lote = edición + organización (mover nota, favorita, archivar/desarchivar; las carpetas, ver 5); papelera y versiones entraron el 30 sep (ver 6), y los adjuntos, en solo lectura, también (ver 7), y **nunca** purga nada irreversible; 4) nunca mueve una nota a una carpeta privada ni le pone una etiqueta privada, por ninguna vía: se rechaza sin escribir y con el mismo error que un destino inexistente; 5) **opción A** (28 sep 2026): crear, renombrar y mover carpetas quedan **fuera** del MCP, porque sus errores revelarían carpetas privadas (`folder_name_taken` delataba una hermana privada; renombrar o mover una carpeta con una privada dentro respondía distinto); las carpetas se crean desde la app Hebra, y el MCP solo mueve notas a carpetas que ya existen; 6) **papelera y versiones** (30 sep 2026, «acepto tus recomendaciones»): el MCP manda una nota visible a la papelera, la saca y lista la papelera, pero **nunca** purga, vacía la papelera ni borra nada de forma irreversible; en la papelera rige el mismo filtro (una nota de carpeta privada o subcarpeta, también si la carpeta ya se borró, o con etiqueta privada o descendiente no aparece, y mandarla o sacarla responde `not_found`, igual que una inexistente), y restaurar nunca deja una nota en una carpeta que el cliente no ve. Lista y lee las versiones anteriores de una nota visible, y restaurar una versión es una **edición nueva** con el mismo control de concurrencia que `hebra_edit_note` (revisión leída; choque = copia de conflicto visible); una versión cuyo cuerpo lleva una etiqueta privada no se devuelve ni se restaura (misma respuesta que una inexistente, regla 4). Las demás herramientas siguen sin devolver notas de la papelera; 7) **adjuntos en solo lectura** (30 sep 2026, tercer lote de D2): el MCP lista y lee los adjuntos de una nota visible y **nunca** añade, borra ni modifica ninguno; una nota oculta o un adjunto de una nota oculta responde `not_found`, igual que uno inexistente; como mucho **5 MiB** descifrados por adjunto (si no, `attachment_too_large` con el tamaño, sin bajar más de lo necesario cuando el tamaño se sabe antes); solo PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON, decidido por el contenido y el descriptor del motor, no solo por la extensión (si no, `attachment_type_not_allowed`); las imágenes salen como contenido `image`, el texto como texto y el PDF como recurso embebido, nunca con rutas locales, URLs de blob ni URLs permanentes. Un choque con una edición produce una copia de conflicto visible, como en Bear. | El motor ya hace la copia de conflicto (§7 de la spec de Hebra) y ya permitía editar (`noteSave` con `expectedLocalSeq`/`baseBodySha256`). |
| D3 | **Ve toda la biblioteca salvo** carpetas o etiquetas marcadas como privadas en la configuración del MCP. El filtro vive en el MCP y se aplica antes de devolver nada a la IA. | |
| D4 | **Cuándo** (revisada el 26 sep 2026): **BEAR-22 queda cerrada** por decisión de David (la biblioteca actual es de prueba y la va a reimportar desde Obsidian). Se hacen **todos los lotes ya**, en orden L0 → L1 → L2 (en cuanto Lumbre despliegue L2a) → L3 → L4. Objetivo: que David use Hebra en serio con el MCP cuanto antes. | La versión anterior esperaba a BEAR-22 para todo lo que cambiara el sync o el vínculo en Hebra. |
| D5 | **Repo**: hebra-mcp es público y consume Hebra (privado, sin licencia) por submódulo fijado a un SHA, sin versionar código de Hebra. | Descartados: hacer hebra-mcp privado y publicar el núcleo de Hebra con licencia. |
| D6 | **Conector remoto** (26 sep 2026): hebra-mcp tiene que funcionar como conector remoto de claude.ai (web, móvil, sesiones en la nube), y **corre en el servidor de Lumbre**, en un contenedor aparte. stdio sigue funcionando en local. Diseño en §12. | Revoca el descarte de D1: ese servidor guarda las claves de la biblioteca y puede leer las notas (quien tenga root en él). Descartados: una máquina de casa (Fedora o Mac) publicada con Tailscale Funnel, que mantenía el cifrado de punta a punta pero solo funcionaba con esa máquina encendida. |
| D7 | **Autenticación del conector remoto** (revisada el 28 sep 2026): conservar el OAuth público de Hebra MCP y usar login y consentimiento de Lumbre para aprobar la biblioteca ya emparejada. | Sustituye la decisión del 26 sep de usar un secreto del dueño. El login no entrega la clave de biblioteca ni reasocia otra biblioteca. |
| D8 | **Mejoras de paginación y adjuntos** (2 oct 2026): 1) caché de introspección de 30 s (por familia de token); 2) paginación de versiones (limit 1-200, def. 50) y adjuntos (limit 1-200 opcional); 3) lectura de adjuntos de texto por tramos (offset, maxChars 1–100 000, def. 100 000, con totalChars, truncated y nextOffset). Riesgo aceptado: la ventana de 30 s vale para toda revocación hecha en Lumbre (concesión, biblioteca o dispositivo Blob V2), y con Lumbre caído una entrada vigente sigue dando acceso hasta 30 s. El refresh nunca usa la caché. | Medidas de escala y usabilidad. |

## 4. Arquitectura

```
Claude Code / Desktop ──stdio(MCP)──► hebra-mcp (Node 24)
                                        ├─ servidor MCP: 21 herramientas + filtro de privados
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
  Es la caché de adjuntos del motor: guarda lo que baja `readBlob` al leer un adjunto (decisión 7
  de D2) y nada más; hebra-mcp no crea otra.
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
- Las notas en la papelera nunca se devuelven, salvo por las herramientas de la papelera
  (`hebra_list_trash`, `hebra_trash_note`, `hebra_restore_note`), con su propio filtro (§6.3).
- `isConflictCopy: true` sale en `hebra_search`, `hebra_list_notes`, `hebra_list_trash` y `hebra_read_note`. `conflictOf` (el id de la nota original) solo en `hebra_read_note`. Los backlinks de `hebra_links` no marcan conflictos.
- Toda salida pasa por el filtro de privados (§6.3).
- Los identificadores son los `id` de nota del almacén.
- Las fechas van en ISO 8601.

| Herramienta | Entrada | Salida |
|---|---|---|
| `hebra_search` | `query` (texto, FTS5), `limit` (1-50, def. 20), `cursor?`, `folder?` (ruta), `subfolders?` (con `folder`, incluye su subárbol; def. `false`), `tag?`, `fields?` (subconjunto de `title`, `folderPath`, `tags`, `snippet`, `updatedAt`, `isConflictCopy`; `id` siempre) | `{results: [{id, title, folderPath, tags, snippet, updatedAt, isConflictCopy}], nextCursor}` |
| `hebra_list_notes` | `folder?`, `subfolders?` (con `folder`, incluye su subárbol; def. `false`), `tag?`, `cursor?`, `limit` (1-100, def. 50), `fields?` (subconjunto de `title`, `folderPath`, `tags`, `excerpt`, `updatedAt`, `isConflictCopy`; `id` siempre); orden por favoritas primero y `updatedAt` descendente | `{notes: [{id, title, folderPath, tags, excerpt, updatedAt, isConflictCopy}], nextCursor}` |
| `hebra_read_note` | `id` o `title` (exactamente uno) | `{id, title, body, folderPath, tags, createdAt, updatedAt, isConflictCopy, conflictOf?, revision}`. `revision`: opaca, la versión leída (para `hebra_edit_note`). Con `title` ambiguo: error `ambiguous_title` con los candidatos `[{id, title, folderPath}]`. |
| `hebra_list_tags` | `limit?` (1-500; sin él, todas), `cursor?` | `{tags: [{tag, count}], nextCursor}` (anidadas como `a/b`) |
| `hebra_list_folders` | `limit?` (1-500; sin él, todas), `cursor?` | `{folders: [{id, path, count}], nextCursor}` |
| `hebra_links` | `id`, `limit?` (1-200; sin él, todo), `cursor?` | `{outgoing: [{ref, resolvedId?, title?}], backlinks: [{id, title}], nextCursor}` |
| `hebra_create_note` | `body` (Markdown; el primer H1 es el título, como en Hebra; si existe, el `title:` del frontmatter manda sobre el H1), `folder?` (ruta existente; por defecto, la raíz) | `{id, title, folderPath}` |
| `hebra_append_to_note` | `id`, `text` (≤ 20 000 caracteres) | `{id, outcome: "saved" \| "conflict_copy", copyId?}` |
| `hebra_edit_note` | `id`, `edits: [{find, replace}]` (1-50; `find` no vacío; `find` + `replace` de todas ≤ 100 000 caracteres), `expectedRevision`, `operationId` (≤ 200) | `{id, outcome: "saved" \| "conflict_copy", revision?, copyId?, replayed?, sync, syncError?}`. Errores: `revision_conflict`, `no_match` / `ambiguous_match` / `overlapping_edits` (con `edit`: índice), `note_locked`, `operation_id_reused`, `not_found`. |
| `hebra_move_note` | `id`, `folderId` (`"root"` = raíz) | `{id, folderPath, favorite, archived, sync, syncError?}` |
| `hebra_set_favorite` | `id`, `favorite` | igual que `hebra_move_note` |
| `hebra_set_archived` | `id`, `archived` | igual que `hebra_move_note` |
| `hebra_trash_note` | `id` (nota visible, o ya en la papelera y visible allí) | `{id, trashed: true, sync, syncError?}`. Idempotente. Reversible con `hebra_restore_note` o desde Hebra. |
| `hebra_restore_note` | `id` (nota de la papelera visible, o viva y visible) | igual que `hebra_move_note`: a su carpeta si sigue viva; si no, a la raíz (como Hebra). Idempotente. |
| `hebra_list_trash` | `cursor?`, `limit` (1-100, def. 50); orden: la última en entrar primero | `{notes: [{id, title, folderPath, tags, excerpt, trashedAt, updatedAt, isConflictCopy}], nextCursor}`. `folderPath`: donde quedará al restaurarla. Sin recuento. |
| `hebra_list_versions` | `id`, `limit?` (1-200, def. 50), `cursor?` | `{id, versions: [{versionId, createdAt, byteLength}], nextCursor}`, la más reciente primero, sin cuerpo ni `cause`. |
| `hebra_read_version` | `id`, `versionId` | `{id, versionId, createdAt, byteLength, body}`. |
| `hebra_restore_version` | `id`, `versionId`, `expectedRevision`, `operationId` (≤ 200) | igual que `hebra_edit_note`, con los mismos errores salvo los de las sustituciones. |
| `hebra_list_attachments` | `id`, `limit?` (1-200), `cursor?` | `{id, attachments: [{attachmentId, name, mimeType, byteLength}], nextCursor}` en el orden del cuerpo. `attachmentId`: el SHA-256 del adjunto; `name`: el alias `\|nombre` del cuerpo o `null`; `mimeType` (orientativo) y `byteLength`: `null` si no se saben sin bajarlo. Errores: `not_found`, `note_locked`. |
| `hebra_read_attachment` | `id`, `attachmentId`, `offset?` (carácter por el que empezar, def. 0), `maxChars?` (1–100 000, def. 100 000; solo texto) | Imagen, PDF: un bloque `{id, attachmentId, name, mimeType, byteLength}` y el contenido íntegro como `image` (base64 + `mimeType`) o `resource` embebido (blob base64 + URI opaca `hebra-attachment:<sha256>`). Texto, Markdown, CSV, JSON: bloque `{id, attachmentId, name, mimeType, byteLength, totalChars, truncated, nextOffset}` y el texto. Para leer el resto: `offset = nextOffset`. Errores: `not_found`, `note_locked`, `attachment_too_large` (`byteLength`, `maxBytes`), `attachment_type_not_allowed` (`mimeType?`), `attachment_unavailable`. |
| `hebra_status` | nada | `{linked, lastSyncAt, lastSyncOutcome, pendingUpload, errorsByCode, writer: "this" \| "other_instance", revoked, capabilities}`. Sin contenido de notas. |

Anotaciones MCP (2 oct 2026, decision D8):
- Las 21 herramientas declaran `annotations` en el esquema. **Lectura** (`readOnlyHint: true`): `hebra_search`, `hebra_list_notes`, `hebra_read_note`, `hebra_list_tags`, `hebra_list_folders`, `hebra_links`, `hebra_status`, `hebra_list_trash`, `hebra_list_versions`, `hebra_read_version`, `hebra_list_attachments`, `hebra_read_attachment`.
- **Escritura no destructiva** (`destructiveHint: false`): `hebra_move_note`, `hebra_set_favorite`, `hebra_set_archived`, `hebra_trash_note`, `hebra_restore_note` (ambas idempotentes); `hebra_edit_note` y `hebra_restore_version` (con `idempotentHint: true` por el control de concurrencia y la revocación de `operationId`).
- **Escritura con consecuencias** (`destructiveHint: false`, `idempotentHint: false`): `hebra_create_note` y `hebra_append_to_note` (las escrituras iniciales, no idempotentes sin `operationId`).
- Todas `openWorldHint: false`.

Paginación, campos y capacidades (30 sep 2026, «Recursos y escala»):
- **Paginación común** (`src/server/pagination.ts`): `hebra_search`, `hebra_list_notes`, `hebra_links`,
  `hebra_list_tags`, `hebra_list_folders`, `hebra_list_trash`, `hebra_list_versions` y `hebra_list_attachments` aceptan `limit` y `cursor` y devuelven `nextCursor`, que es
  `null` al final. Los valores por defecto son búsqueda 20, notas 50, papelera 50, versiones 50, adjuntos todo si no hay `limit`; etiquetas, carpetas y
  enlaces, todo si no hay `limit`. El cursor es opaco y lleva un prefijo por herramienta: el de una
  no vale en otra (`invalid_input`). En las listas de notas es la clave del último resultado
  devuelto (reanuda exactamente tras él); en etiquetas y carpetas, la clave del último elemento.
  En `hebra_list_notes` se sigue aceptando el cursor sin envolver de versiones anteriores.
- **Las ocultas no se notan** (§6.3): una página se rellena hasta `limit` solo con notas visibles;
  `nextCursor` existe solo si hay otra nota VISIBLE detrás (se mira una por delante), así que ni el
  tamaño de la página ni la presencia del cursor dependen de cuántas notas privadas hay ni de dónde
  están. El cursor lleva la clave de una nota ya devuelta, nunca la de una oculta.
- **`hebra_links`**: `limit` vale para `outgoing` y para `backlinks` a la vez y hay UN `cursor` para las
  dos listas; `nextCursor` existe si a alguna le queda algo, y la que ya terminó sale vacía en las
  páginas siguientes.
- **Filtros comunes**: `folder` (ruta), `subfolders` y `tag` se llaman y se comportan igual en
  `hebra_search` y `hebra_list_notes` (`subfolders` es nuevo en la búsqueda). Una carpeta o etiqueta
  privada o inexistente da lista vacía en ambas. No hubo renombrados, así que no hay alias.
- **`fields?`** (`hebra_search`, `hebra_list_notes`): cada elemento lleva `id` y solo los campos pedidos,
  en el orden de siempre; un nombre desconocido lo rechaza el esquema. Ausente, salida completa.
- **Capacidades**: el `initialize` lleva `instructions` fijas (qué hace el servidor, cómo paginar, cómo
  editar, qué no permite) y `hebra_status.capabilities` da `{server: {name, version}, tools, pagination,
  limits, notAllowed, privacyConfigured}`. `limits` recoge los máximos de `limit` por herramienta (`listNotes`, `listTags`, `listFolders`, `links`, `search`, `listTrash`, `listVersions`, `listAttachments`), los tamaños de las escrituras, `attachmentBytes` (5 MiB) y `attachmentTextChars` (100 000); `notAllowed` lista lo que no hace (purgar o vaciar la
  papelera, carpetas, y escribir/cambiar/borrar adjuntos);
  `privacyConfigured` es solo un booleano: ni nombres de carpetas o etiquetas privadas ni contenido.

Detalle de las escrituras (D2):
- **Escrituras que no escriben nada** (edición sin cambios, reintento con el mismo `operationId`, organización a un estado que la nota ya tiene) no piden ni esperan ronda de sync, y responden `sync` según la fila: `not_linked` sin sync; `uploaded` si la nota no está sucia; `pending` si lo está (la sube la siguiente ronda periódica). Organizar a un estado que la nota ya tiene no la marca sucia ni sube su `local_seq`.
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
- `hebra_edit_note` (D2 ampliada, 28 sep 2026):
  - **Revisión**: `r1.` + base64url de `[library_id, id, local_seq, body_sha256]` de la fila leída.
    `updatedAt` no vale (mover o archivar no lo cambia). La edición se certifica contra la base que
    trae el agente, no contra la nota actual: el SHA-256 del cuerpo de la revisión tiene que ser el
    de ahora (si no, `revision_conflict` sin escribir) y `noteSave` recibe `expectedLocalSeq` y
    `baseBodySha256` de la revisión. Una revisión de otra nota o ilegible: `invalid_input`.
  - **Sustituciones**: cada `find` se busca en el cuerpo leído (no en el resultado de las
    anteriores) y tiene que aparecer exactamente una vez, contando solapes consigo mismo. Dos no
    pueden tocar el mismo tramo. Cualquier fallo rechaza todas, sin escribir.
  - Todo en un turno de la cola del almacén, por el escritor único (un lector la reenvía por
    `writer.sock`, op `editNote`): idempotencia, filtro de privados, nota bloqueada (`note_locked`),
    revisión, sustituciones, resultado sin etiqueta privada, guardado. Derivados completos de
    `deriveNote`.
  - **Idempotencia**: tabla propia `hebra_mcp_operations` en `library.sqlite` (no viaja por sync ni
    la toca `libraryReset`), en dos fases (`started` con el SHA-256 del cuerpo resultante → `noteSave`
    → `done` con el resultado). El mismo `operationId` con la misma petición devuelve lo mismo con
    `replayed: true`; con otra, `operation_id_reused`. Si el proceso muere entre guardar y cerrar el
    registro, el SHA-256 dice que se guardó y no se repite; si murió antes, se guarda. **Límites**:
    caduca a las 24 h (después, el reintento choca con su revisión, nunca duplica); cada directorio
    de datos tiene el suyo (el Mac y el conector remoto no comparten registro ni revisiones); `unpair`
    lo borra con el resto.
- **Organización de notas** (`hebra_move_note`, `hebra_set_favorite`, `hebra_set_archived`): por
  id, sobre `noteMove`, `noteSetFavorite` y `noteArchive`/`noteUnarchive` del motor (los reexporta
  `node.ts` de Hebra). Un turno de la cola, por el escritor único (op `organize`). Mover lleva la
  nota a una carpeta que ya existe; favorita y archivar son idempotentes. Una nota bloqueada se
  puede organizar (nada de esto toca su cuerpo).
- **Carpetas fuera del MCP** (opción A de David, 28 sep 2026): no hay herramientas para crear,
  renombrar ni mover carpetas, ni el socket acepta esas acciones, porque sus errores revelarían
  carpetas privadas (`folder_name_taken` con el nombre de una hermana privada; renombrar o mover una
  carpeta visible con una privada dentro respondía distinto que sin ella). Las carpetas se crean
  desde la app Hebra; llamar a una de esas herramientas da el error genérico del SDK de herramienta
  inexistente.
- **Privacidad de las escrituras** (decisión 4): toda escritura (crear, añadir, editar, organizar,
  papelera y restaurar una versión) lleva la configuración de privados de quien la pide (también
  la del lector por `writer.sock`, que la exige) y el escritor la aplica dentro del turno en que
  escribe y sobre el resultado: origen visible, destino visible, cuerpo resultante sin etiquetas
  privadas ni descendientes. Lo que no, `not_found`, igual que una nota o carpeta inexistente
  (§6.3 «Escrituras»): una nota con etiqueta privada ya no se crea ni se amplía (antes,
  `hidden: true`).
- **Estado de sync** (edición, organización, papelera y restaurar una versión): se espera la
  ronda como mucho 10 s y `sync` dice `uploaded` (ronda `ok` y fila ya limpia), `pending` (guardado; sin ronda a tiempo o aún sucio),
  `error` (ronda con otro código: `syncError`, p. ej. `offline`, `revoked`) o `not_linked` (sin
  emparejar). Una copia de conflicto de la ronda para esa nota da `conflict_copy` con `copyId`, sin
  reintento automático.
- **Papelera** (`hebra_trash_note`, `hebra_restore_note`, `hebra_list_trash`; decisión 6 de D2,
  30 sep 2026): mandar y sacar son dos acciones más de `organize` (`trashNote`/`restoreNote`,
  sobre `noteTrash`/`noteRestore` del motor), por el mismo escritor, el mismo reenvío y la misma
  privacidad dentro del turno; las dos son idempotentes y se deshacen la una a la otra. Restaurar
  deja la nota en su carpeta si sigue viva y, si se borró, en la raíz (la carpeta efectiva de una
  lápida, igual que en Hebra). La lista sale de `notesPage({kind: 'trash'})`; se rellena hasta
  `limit` con notas visibles y mira una de más para que `nextCursor` no delate una cola de notas
  ocultas.
- **Versiones anteriores** (`hebra_list_versions`, `hebra_read_version`, `hebra_restore_version`;
  decisión 6 de D2): son las instantáneas **locales** del almacén de hebra-mcp (`note_versions` de
  Hebra: el cuerpo que sustituyó un guardado o un cambio bajado por el sync, una cada 5 minutos
  como mucho, 7 días); no viajan por sync, así que no son las del Mac. No se devuelve `cause`
  (en un renombrado de etiquetas en lote nombra las etiquetas y podría nombrar una privada).
  El motor no tiene una operación de restaurar: como «Restaurar» en Hebra
  (`LibraryEditor.svelte`), es `noteVersionSnapshot` (instantánea ya del cuerpo actual, para
  que lo que había se pueda recuperar) + `noteSave` normal. Va por la vía de `hebra_edit_note`:
  un turno de la cola en el escritor (op `restoreVersion` de `writer.sock`), la base de
  `expectedRevision`, idempotencia en el mismo registro (con huella propia: un `operationId` de
  una edición no vale para restaurar) y la copia de conflicto de la ronda anotada para el
  reintento.
- **Adjuntos en solo lectura** (`hebra_list_attachments`, `hebra_read_attachment`; decisión 7 de
  D2, 30 sep 2026):
  - **Qué es un adjunto**: lo que la nota adjunta con `![[sha256:H|nombre]]` (`note_blob_refs` de
    Hebra, en el orden del cuerpo). Así quedan también los de Obsidian: el importador de Hebra
    reescribe sus enlaces a `sha256:` (`library/import.ts`). Los recursos sueltos (`files`,
    `![[plano.pdf]]` por nombre, con carpeta propia) no entran en este lote.
  - **Bytes**: si no están en el disco, los baja el **escritor** con `readBlob` del motor de sync
    (Blob V2: `getObject` del relé, descifrado, SHA-256 verificado y `blobPut` en su almacén de
    adjuntos, la única caché). Un lector se lo pide por `writer.sock` (op `fetchAttachment`,
    respuesta `{available}`, nunca los bytes) y los lee del disco compartido con su propio filtro.
    El sync de producción no llevaba transporte de blobs: desde este lote `SyncRunner` usa
    `HttpBlobRelayV2` sobre la misma conexión, como `LibraryApp.svelte` de Hebra. Sin sync, sin
    red o si el relé no lo tiene: `attachment_unavailable`.
  - **Tamaño**: 5 MiB descifrados. Si la fila de `blobs` lo sabe (un recurso recibido por sync la
    trae aunque los bytes sigan en el relé) se rechaza **antes** de bajar nada. Si no hay fila (un
    `sha256:` de otro dispositivo), no se puede saber antes: Blob V2 no guarda ni tamaño ni tipo
    (`library-ui/blob-attachments.ts:69-70` de Hebra) y `readBlob` baja el objeto entero
    (`getObject`, `sync-engine.ts:1035`), así que se rechaza después de bajarlo, que queda en la caché.
  - **Tipo**, por el contenido: firma de los primeros bytes para PNG, JPEG, GIF, WebP y PDF (manda
    sobre lo declarado y el nombre); texto plano, Markdown, CSV y JSON solo si el almacén declara
    ese tipo (o no declara ninguno y la extensión del nombre es de texto) **y** los bytes son UTF-8
    válido sin NUL. Un JSON ilegible pasa como `text/plain`. Lo demás, incluida una «imagen» cuyos
    bytes no lo son: `attachment_type_not_allowed`.
  - Una nota bloqueada da `note_locked` (sus adjuntos van cifrados con ella).
  - **Lectura de adjuntos de texto por tramos** (decisión 2b, 2 oct 2026): para texto plano, Markdown, CSV y JSON, `hebra_read_attachment` acepta `offset?` (carácter por el que empezar, def. 0) y `maxChars?` (1–100 000, def. 100 000). La respuesta lleva `totalChars`, `truncated` y `nextOffset` (`null` al final). Para leer el resto, repetir con `offset = nextOffset`. Imágenes y PDF no cambian: siempre íntegros.
- No se exponen `notePurge`, `trashEmpty`, `trashCounts` (contaría las privadas),
  `noteVersionsPurgeExpired`, `folderTrash`, `file*` ni `tagRename`: el servidor ni siquiera las
  importa en su capa de herramientas (`test/store/surface.node.test.ts`). Tampoco `blobPut`: solo
  lo tiene la vista de sync del almacén, para que el motor guarde lo que baja.
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
  mostraría en `ps`). Excepción: el contenedor remoto usa un fichero 0600, elegido de forma explícita
  (§12.3).
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
- **Escrituras** (crear, añadir, editar, organizar, papelera y restaurar una versión): no pueden
  apuntar a una carpeta privada ni a una nota oculta, ni dejar una nota en una carpeta privada o con una etiqueta privada (o
  descendiente); responden `not_found` sin escribir, igual que un destino inexistente (decisión 4 de
  David, 28 sep 2026). Se comprueba en la herramienta y otra vez en el escritor, dentro del turno en
  que escribe, con la configuración de quien pide (§5, «Detalle de las escrituras»). Una nota con
  etiqueta privada ya no se crea ni se amplía. El MCP no crea, renombra ni mueve carpetas (opción A,
  §5): sus errores revelarían carpetas privadas.
- **Papelera** (decisión 6 de D2, 30 sep 2026; `src/privacy/trash-filter.ts`): una nota de la
  papelera está oculta si tiene una etiqueta privada (o descendiente) o si su carpeta es privada
  (o subcarpeta). Si su carpeta ya se borró (`folderTrash` de Hebra deja la carpeta como lápida,
  con nombre y padre, y manda sus notas a la papelera sin tocar su `folder_id`), se sube por las
  lápidas hasta una carpeta viva o la raíz: oculta si esa carpeta viva es privada o si alguna ruta
  intermedia (la de la carpeta viva más los nombres de las lápidas) es una ruta privada
  configurada, así que una carpeta privada borrada y vuelta a crear con el mismo nombre no destapa
  las notas de la vieja. Cerrado ante la duda: una fila que falta, sin nombre o en ciclo, oculta.
  Una nota oculta no sale en `hebra_list_trash` (sin recuento, y sin un `nextCursor` que delate
  que quedan ocultas detrás), y `hebra_trash_note`/`hebra_restore_note` sobre ella responden
  `not_found`, igual que una inexistente. Restaurar deja la nota en su carpeta si sigue viva o en
  la raíz: con esta regla, lo que se ve en la papelera nunca acaba en una carpeta privada al
  restaurarlo. Se comprueba en la herramienta y otra vez en el escritor, dentro del turno.
- **Adjuntos** (decisión 7 de D2, 30 sep 2026): solo los de una nota visible (viva; oculta, en la
  papelera o inexistente, `not_found`), y solo los que ESA nota adjunta: un adjunto de una nota
  oculta pedido a través de otra nota que no lo adjunta, o un `attachmentId` que no es un SHA-256,
  responde `not_found`, igual que uno inexistente. El nombre sale del cuerpo de la nota visible,
  nunca de un recurso (`files`) que podría estar en una carpeta privada. Lo comprueba la
  herramienta y, si hay que bajar los bytes, otra vez el escritor dentro del turno, con la
  configuración de quien pide. Los bytes nunca viajan por `writer.sock` y nunca salen rutas
  locales ni URLs.
- **Versiones** (decisión 6 de D2): solo de una nota visible (viva; oculta, en la papelera o
  inexistente, `not_found`). Una versión cuyo cuerpo lleva una etiqueta privada (o descendiente),
  con las etiquetas de `deriveNote` (las que Hebra guardaría al restaurarla), no se lista, no se
  lee y no se restaura: `not_found`, igual que una versión que no existe o que es de otra nota.
  La lista no dice cuántas se saltó ni devuelve `cause`. Restaurar lo vuelve a comprobar el
  escritor dentro del turno, sobre el cuerpo resultante, como cualquier edición.
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
por D2 (ampliada el 28 y el 30 sep 2026): sin borrar, purgar ni vaciar la papelera, y sin poder
llevar nada a una carpeta o etiqueta privada, lo peor que puede hacer una instrucción inyectada es
crear notas, añadir texto, sustituir fragmentos de una nota visible o restaurarle una versión
anterior, mover (a carpetas que ya existen), archivar y marcar notas visibles, y **mandar notas
visibles a la papelera** (o sacar de ella notas visibles). Las carpetas no se tocan. Todo queda
visible en Hebra y es revertible, allí y desde el MCP: una nota mandada a la papelera se saca con
`hebra_restore_note` o desde Hebra (nada la purga), y las «Versiones anteriores» guardan el cuerpo
previo a una edición o a una restauración (en Hebra, las del dispositivo; en el MCP, las suyas);
una edición concurrente produce una copia de conflicto. Los adjuntos (decisión 7) son de solo
lectura, así que no amplían ese daño, pero su contenido es entrada a la IA igual que el cuerpo: un
texto, un PDF o una imagen adjuntos pueden llevar instrucciones, y se tratan como datos.

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
   - **Cambio en Lumbre** (L2a): pasó la auditoría de seguridad y está integrado en `main` de Lumbre
     (`54b7aab5b`), pendiente de despliegue. Contrato:
     - El parámetro de retorno es `webOrigin` (no hay `redirect_uri`): va en la query de
       `GET /integrations/hebra` y en el JSON de `POST /api/integrations/hebra/pair`.
     - Valores admitidos: `http://127.0.0.1:<puerto>` o `http://[::1]:<puerto>`, sin ruta o con
       exactamente `/lumbre/connect`.
     - `code_challenge` y `code_challenge_method=S256` son obligatorios.
     - `/pair` devuelve `callbacks.web` = `http://127.0.0.1:P/lumbre/connect?code=<64 hex>&apiOrigin=…`.
     - Canje: `POST /api/integrations/hebra/exchange` con `{code, deviceId, code_verifier}` y **sin**
       cabecera `Origin` (con `Origin`, 403). Un verifier incorrecto da 401 y no quema el código.
   - **Obligaciones de hebra-mcp** (de la auditoría de Lumbre; cada una con su test en L2):
     1. Ignorar el `apiOrigin` de la query y usar el Lumbre configurado. Mientras el listener escucha,
        cualquier web puede disparar el callback con un `apiOrigin` falso para robar el verifier.
     2. Aceptar solo un `code` que case con `^[a-f0-9]{64}$`.
     3. Responder una sola vez, con `Referrer-Policy: no-referrer` y sin recursos externos, y cerrar
        el listener.
     4. Verifier PKCE de 32 bytes aleatorios o más.
     5. Escuchar en la IP literal `127.0.0.1` o `[::1]`, nunca en `localhost`.
   - **hebra-mcp**: abre el listener en `127.0.0.1` con un puerto libre, solo `GET /lumbre/connect`,
     y lo cierra tras la primera respuesta válida o al expirar (5 min).
2. **Petición de vínculo**: `POST /device-links` con la plataforma y la etiqueta
   «Claude (hebra-mcp)», saneada con `sanitizeDeviceLabel`. El terminal muestra la verificación que
   David debe ver en Hebra.
3. **Aprobación**: David aprueba en Hebra > Ajustes > Sincronización. El proceso sondea cada 2 s
   (`DEVICE_LINK_POLL_MS`), desenvuelve el código de recuperación y ejecuta `verifyGrantedAccess`:
   comprueba el acceso con hasta 4 páginas de 200 registros y sigue buscando hasta 3 títulos de nota
   (`VERIFY_TITLE_SEARCH_MAX_RECORDS`, 5000 registros; la subida inicial manda las carpetas
   primero), y los muestra descifrados para que David confirme que es su biblioteca. Sin ningún
   título, avisa de que compare la fecha de creación.
   Es el único momento en que se imprimen títulos, y es en su terminal, no en logs.
4. **Guardado**: los secretos van al llavero (§6.1). Después, `libraryConnect` y la primera descarga
   completa.
5. **Registro en Claude**: `claude mcp add hebra -- hebra-mcp serve`.
6. **Sin terminal interactiva** (p. ej. lanzado con el prefijo `!` de Claude Code): `pair`
   comprueba `stdin` ANTES de cualquier llamada a Lumbre y falla con `no_tty` sin abrir el
   navegador ni crear nada. Si la confirmación del paso 3 falla por otra causa (la entrada
   se cierra a mitad, EOF) DESPUÉS de haber creado la conexión, el error (`confirm_failed`)
   avisa de que quedó una conexión huérfana en Lumbre y cómo revocarla.

## 8. Ejecución y concurrencia

- **Escritor único**: stdio lanza **un proceso por sesión de Claude**, y dos sesiones abiertas serían
  dos escritores sobre la misma SQLite.
  - Solución de v1: un fichero de bloqueo `writer.lock` en el directorio de datos, con PID y
    comprobación de vida. El proceso que lo tiene sincroniza y escribe.
  - Los demás abren la SQLite en solo lectura (WAL) y sirven las lecturas.
  - `syncLeaseAcquire` del motor solo coordina dentro de un proceso, así que no basta.
- **Escrituras desde cualquier sesión** (medido en la QA del 26 sep 2026: solo escribía la primera
  sesión; David pidió que escriba cualquiera):
  - El escritor escucha en un socket Unix `writer.sock` del directorio de datos (0700), con el
    socket en 0600. Hace `bind` en una ruta temporal y la renombra a `writer.sock`: así sustituye de
    forma atómica el socket de un escritor muerto, y al cerrar no se lleva el de un escritor nuevo
    (libuv borra la ruta del `bind` sin mirar de quién es; `writer.sock` solo lo borra quien lo
    creó, comprobado por inodo).
  - Protocolo: JSON por líneas con `id` de petición. `createNote {body, folderId, privacy}`,
    `appendToNote {id, text, privacy}` (responde `{outcome, copyId?}` con la ronda de sync ya
    esperada en el escritor, igual que `hebra_append_to_note`), `editNote {id, edits,
    expectedRevision, operationId, privacy}`, `organize {action, …, privacy}` (también
    `trashNote`/`restoreNote`; ninguna acción de purga) y `restoreVersion {id, versionId,
    expectedRevision, operationId, privacy}` (responden el resultado completo de
    `hebra_edit_note`, de la organización o de `hebra_restore_version`, con la ronda ya esperada y
    `sync`), `fetchAttachment {noteId, sha256, privacy}` (baja al disco compartido los bytes de
    un adjunto de una nota visible y responde `{available}`, nunca los bytes; decisión 7 de D2) y
    `status` (el estado de sync del escritor). `privacy` es la configuración de privados del
    lector y es obligatoria en las cinco escrituras y en `fetchAttachment`: sin ella,
    `invalid_request`.
    Errores con código cerrado, nunca con el mensaje; los rechazos de una sustitución llevan su
    índice (`edit`). Una línea de más de `MAX_MESSAGE_BYTES` (el cuerpo máximo de §5 con el peor
    escape JSON, más 64 KiB; las sustituciones de `editNote` suman como mucho lo mismo) se rechaza
    sin leerla entera. El escritor vuelve a comprobar los límites de §5.
  - Un lector reenvía `hebra_create_note`, `hebra_append_to_note`, `hebra_edit_note`, las tres de
    organización de notas, las dos de la papelera y `hebra_restore_version` al escritor (las
    lecturas de la papelera y de las versiones las sirve él mismo), y le pide que baje los bytes de
    un adjunto que no esté en el disco (`hebra_read_attachment`), que después lee él. El filtro de privados y los
    límites se aplican en la herramienta del lector, **antes** de reenviar y con su configuración, y el escritor vuelve a aplicar esa misma
    configuración (la recibe en `privacy`) dentro del turno en que escribe: no la conoce ni la
    supone igual.
  - Si no hay socket, nadie escucha o no responde a tiempo, el lector intenta tomar el bloqueo en ese
    momento. Si lo consigue, pasa a escritor (SQLite en lectura-escritura, sync y socket) y escribe
    él; si no, `busy_other_instance`.
  - Si la conexión se corta **después** de enviar la petición y sin respuesta, el escritor pudo
    ejecutarla antes de morir: el lector no la repite (duplicaría el texto). Intenta el relevo para
    la siguiente y responde `busy_other_instance`. Una edición se puede reintentar con el mismo
    `operationId` sin duplicar (§5).
  - `hebra_status` de un lector devuelve el estado de sync del escritor, pedido por el socket, con
    `writer: "other_instance"`. Si el escritor no responde, intenta el relevo y da el estado local.
  - Logs: `write.forward` (lector) y `writer.socket.request` (escritor) con operación, resultado y
    códigos cerrados. Sin cuerpos, textos ni ids de nota.
  - Límites conocidos: un timeout con el escritor vivo da `busy_other_instance` aunque el escritor
    llegue a escribir después. Si la ruta del socket supera el límite de un socket Unix (104 bytes en
    macOS), el escritor sigue sin socket (`writer.socket` `failed` en stderr) y los lectores
    responden `busy_other_instance`, como antes del reenvío.
- **Ritmo de sync**:
  - Al arrancar: una ronda, y las lecturas esperan como mucho 10 s a que termine.
  - Después, una ronda cada 30 s mientras el proceso vive.
  - Una ronda justo después de cada escritura. Excepción (§5): una escritura que no cambia nada (edición sin cambios, reintento con el mismo `operationId`, organización a un estado que la nota ya tiene) no pide ronda.
  - En reposo, cada ronda es 1 petición HTTP y 0 escrituras (A6 de Hebra).
- **Adjuntos** (decisión 7 de D2): se leen, nunca se escriben. Los bytes se bajan bajo demanda, al
  pedir `hebra_read_attachment` un adjunto que no esté en el disco, por `readBlob` del motor en el
  escritor (§5). Las rondas no los bajan; con el transporte de blobs ya conectado, subirían los
  blobs pendientes de este dispositivo, pero hebra-mcp no crea ninguno.

## 9. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | El proceso tiene la clave completa de la biblioteca; revocar no la rota. | Llavero del SO, permisos 0600, `unpair` borra todo. Rotación, petición P4 a Hebra. |
| R2 | El submódulo fija un SHA; un cambio de Hebra en el contrato del almacén o del sync deja a hebra-mcp desfasado, y un dispositivo desfasado podría escribir registros que las apps nuevas no esperan. | Mover el submódulo es un paso explícito con los casos compartidos en verde. Petición P5: Hebra avisa cuando cambie el formato del sobre o el esquema. |
| R3 | `node:sqlite` no es `@sqlite.org/sqlite-wasm`: tipos de enlace (`undefined`, booleanos, BigInt) y `exec` con varias sentencias se comportan distinto. | L0 cierra con `cases/library-cases.json` en verde sobre el adaptador. Si no se puede, alternativa: la build de Node de sqlite-wasm que ya usan los tests de Hebra. |
| R4 | Dos procesos escritores sobre la misma SQLite. | Bloqueo de §8: solo escribe el proceso que lo tiene. Los demás le reenvían sus escrituras por `writer.sock` (0600) y toman el relevo si el escritor ya no responde; nunca escriben en la SQLite sin el bloqueo. |
| R5 | Una configuración de privados mal escrita expone notas. | Cerrado ante la duda (§6.3) y tests de subárbol, etiqueta anidada, backlinks, fragmentos y recuentos. |
| R6 | Un fallo de hebra-mcp en el emparejado o en las escrituras ensucia la biblioteca de David. | BEAR-22 está cerrada, así que L4 no espera a nada más que a L2 y L3. Aun así, L2 y L3 se prueban primero contra una bóveda de pruebas propia, creada en el relé de producción por la misma vía que `createTestVaultState` de Hebra (`test-vault.ts:178-189`): bóveda y credencial propias, aisladas de la biblioteca de David. No existe relé de staging. La biblioteca actual es de prueba y David la reimporta desde Obsidian, así que el riesgo es para la medición, no para los datos. |
| R10 | Adjuntos (decisión 7 de D2): la caché de adjuntos del motor crece con cada adjunto leído y no se purga sola; y un adjunto sin fila en `blobs` (un `sha256:` de otro dispositivo) se baja entero antes de saber si pasa de 5 MiB (hasta los 25 MiB de Hebra, `MAX_ATTACHMENT_BYTES`). | Solo se baja lo que se pide, de una nota visible, uno cada vez; `unpair` borra la caché con el resto del directorio de datos. Un tope de caché o una petición de tamaño antes de bajar serían un cambio en Hebra (Blob V2 no guarda el tamaño). |
| R7 | Lumbre no admite hoy devolver el código de emparejado a un CLI (P2). | L2a: redirección loopback con PKCE obligatorio, pedida a la sesión de Lumbre. L2 no empieza sin ella. |
| R9 | Aprobar exige que el dispositivo que aprueba tenga `recoveryExported` (`identity-vault.ts:151`) (P7). | **Cerrado**: David confirmó el 26 sep 2026 que exportó el código de recuperación en el Mac. Es un dato dicho por él, no medido en el contenedor: si la aprobación falla en L4 con ese motivo, se revisa esto primero. |
| R8 | **Cerrado** (L5, 26 sep 2026): Hebra (`035db7e6`) añadió `agent` a `DEVICE_LINK_PLATFORMS` (`device-link.ts:54`) y el relé de Lumbre en producción ya lo acepta. hebra-mcp declara `agent` (`LINK_PLATFORM`, `device-link.ts:38`); Hebra lo muestra como «Claude», no como «Mac». | v1 usa `agent` con la etiqueta «Claude (hebra-mcp)», saneada por `sanitizeDeviceLabel`. Petición P3 cerrada. |

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
| **L3** Sync, escritor único y escrituras | Bucle de sync de §8; bloqueo; `hebra_create_note` y `hebra_append_to_note`; reenvío de las escrituras de los lectores al escritor por `writer.sock`. | 🟢 en tests (transporte en memoria de Hebra, `memory-transport.ts`) · 🟡 en vivo | Tests: nota creada visible en un segundo motor; añadir con edición concurrente produce copia de conflicto con los dos textos; ninguna herramienta llama a mutaciones fuera de D2 (test de la superficie importada). Con procesos `serve` reales: crear y añadir desde un lector, visible en los dos; tras un SIGKILL del escritor, la siguiente escritura del lector toma el bloqueo, y un `serve` nuevo recupera bloqueo y socket huérfanos; socket en 0600; cebos fuera de stderr. En proceso: `conflict_copy` reenviado con su `copyId` y `hebra_status` del escritor visto desde el lector. Sin escritor que responda y con el bloqueo tomado, `busy_other_instance`. |
| **L4** Puesta en marcha con la biblioteca real | Emparejado real, configuración de privados de David, `claude mcp add`, QA de David. | 🟡 tras L2 y L3 | Los 7 puntos de §2 comprobados por David en su biblioteca. |
| **L5** Plataforma propia del dispositivo (opcional) | `agent` en el relé, en Ajustes y en `conflictDevice` para que Hebra diga «Claude». La implementó la sesión de Hebra (`035db7e6`) y el relé, la de Lumbre; hebra-mcp cambió la plataforma que declara (`LINK_PLATFORM` y `deviceLabel`). | ✅ cerrado el 26 sep 2026 | Hebra la muestra; P3 cerrada. `LINK_PLATFORM = 'agent'`, `deviceLabel = 'Claude'` en `serve`/`pair`/`node-port.ts`, con los 68 casos compartidos, `tsc` y `npm test` en verde. |
| **L6** Punto de entrada estable de Hebra (P1) | Hebra exporta `node.ts` o una subruta de `exports` con motor, almacén, transporte, vínculo y derivados; esquema sin `?raw`. La implementa la sesión de Hebra; hebra-mcp cambia su empaquetado para usarlo. | 🔴 sesión de Hebra, en curso desde el 26 sep 2026 | hebra-mcp compila sin alias `$lib` ni plugin de `?raw`, y los casos compartidos siguen en verde. |
| **C1-C6** Conector remoto | Conector remoto de claude.ai en el servidor de Lumbre (D6, D7). Detalle y criterios en §12.8. | C1-C5 con login Lumbre se desplegaron el 28 sep 2026 (Hebra MCP `e36e72a`, broker Lumbre `dfdc34f`); el inicio OAuth público DCR + PKCE llegó al consentimiento. C6 sigue pendiente de QA de David desde Claude. | §12.7. |
| **Después de v1** | Escribir adjuntos, recursos sueltos (`files`), más escrituras. | Fuera de v1 (leer adjuntos entró el 30 sep 2026, decisión 7 de D2) | Nueva decisión de David. |

## 11. Pendiente

- **Peticiones a la sesión de Hebra**, enviadas el 26 sep 2026:
  - Aceptadas: P1 (L6, en curso) y P3 (L5, después de L6); P5, avisar de cambios de contrato.
  - Medidas el 26 sep 2026: P2 exige un cambio en Lumbre (L2a, aceptado y en curso por la sesión de Lumbre); P4 no
    hay rotación (R1); P6 bóveda de pruebas propia en el relé de producción (R6); P7 confirmada por
    David (R9 cerrado).
  - L2 no empieza sin L2a.

## 12. Conector remoto (D6, D7)

Diseño del 26 sep 2026 medido sobre hebra-mcp `5290cd1`, lumbre-mcp `186baec` y lumbre `031031807`.

### 12.1 Transporte

- Subcomando nuevo `serve-http`: Streamable HTTP sin estado, un `McpServer` nuevo por petición sobre el
  mismo `ServerContext` (`build-server.ts`), igual que lumbre-mcp (`http.ts:44-51`).
- En el contenedor corre un único proceso que atiende a todas las sesiones de claude.ai y siempre es el
  escritor. `writer.sock` y el bloqueo siguen existiendo por el Mac (§8), donde hay un proceso por sesión.
- `serve`, `pair` y `unpair` por stdio no cambian.
- Implementado en C2 (`src/http/`):
  - `POST /mcp` con credencial, que se comprueba antes de leer el cuerpo. `GET` y `DELETE /mcp`
    responden 405, como lumbre-mcp. Nada bajo `/mcp/…`: el token no va nunca en la URL.
  - Tope de cuerpo de 664 KiB (el cuerpo máximo de §5 con el peor escape JSON, más 64 KiB), con 413.
  - `Host` y `Origin` tienen que ser el host público. Un host de loopback solo vale si la conexión
    viene de loopback (healthcheck, tests).
  - `GET /healthz`: 204 sin cuerpo ni autenticación.
  - Entorno, sin secretos: `HEBRA_MCP_HTTP_PORT` (8787), `HEBRA_MCP_HTTP_LISTEN` (`127.0.0.1`; en
    el contenedor, `0.0.0.0`) y `HEBRA_MCP_PUBLIC_URL` (`https://mcp.hebra.pro`, issuer y base del
    recurso `<origen>/mcp`).
  - Si otro proceso vivo tiene `writer.lock`, `serve-http` no arranca (`writer_lock_held`) en vez de
    servir como lector. Sigue escuchando en `writer.sock` como cualquier escritor.
  - Logs `http.request` con método, una etiqueta de ruta de un conjunto cerrado y el estado; nunca la
    ruta real, la query, las cabeceras ni el cuerpo.
  - Express entra como dependencia directa (ya lo traía el SDK, misma versión): el router OAuth del
    SDK es de Express. `check:bundle` exime `debug` y `object-inspect`, cuyas referencias al DOM no se
    ejecutan en Node.

### 12.2 Autenticación (D7, revisada el 28 sep 2026)

- Hebra MCP conserva el OAuth público del SDK: issuer `https://mcp.hebra.pro`, recurso
  `https://mcp.hebra.pro/mcp`, scope `hebra:mcp`, CIMD/DCR, callback de Claude, PKCE S256,
  state, códigos de un uso, access de una hora y refresh rotatorio con familia de 30 días
  absolutos. Un refresh reutilizado fuera de la ventana de gracia revoca su familia.
- `/authorize` reserva una solicitud y pide consentimiento a Lumbre mediante el backchannel
  `/api/integrations/hebra-mcp/requests`. Lumbre usa su login y su sesión web para mostrar
  cliente, biblioteca y alcance. La respuesta aprobada vuelve a
  `/oauth/lumbre/callback`; Hebra canjea la transacción autenticada y solo entonces emite
  su código OAuth. El callback público por sí solo no concede acceso; un `denied` falsificado
  no consume la solicitud pendiente.
- La solicitud y la concesión incluyen `pairedCredentialId`, `syncVaultId` y el
  `opaqueDeviceId` real del dispositivo Blob V2. Lumbre comprueba propietario, bóveda
  activa y la fila exacta `hebraBlobDevices` no revocada, vinculada a esa credencial.
  Hebra compara los tres campos con su emparejado actual al canjear, acceder y refrescar.
  Consulta introspección en Lumbre al canjear y en cada refresh; en `/mcp` reutiliza en
  memoria, por familia y durante 30 s (`INTROSPECTION_CACHE_MS`), un resultado positivo
  y coherente con la concesión guardada, o hasta el `expiresAt` de la concesión si llega
  antes (decisión D8). Nunca se guarda un `active: false`, un desajuste ni un error, y una
  entrada caducada no se alarga si Lumbre no responde. Revocar solo esa fila Blob V2 corta
  el refresh al momento y los access en un máximo de 30 s, aunque sobreviva la credencial
  de emparejado.
- Lumbre devuelve un `accountId` opaco, nunca `users.id`. La concesión upstream no se
  acepta directamente en `/mcp`, ni el token OAuth de Hebra autentica las APIs de Lumbre.
  Access/refresh de Claude quedan como hashes en `oauth-tokens.json` v2; el bearer de la
  concesión vive en el almacén de secretos existente. Los códigos pendientes y las
  concesiones sin familia se limpian o revocan al caducar/reiniciar. La marca de
  promoción se retira solo después de persistir la familia; si el proceso cae antes,
  el siguiente arranque revoca la concesión upstream.
- `HEBRA_MCP_BACKCHANNEL_SECRET` es exclusivo de Hebra MCP, distinto del secreto de
  Lumbre MCP. Se envía como Bearer solo por TLS; ausencia o valor inválido impide arrancar
  la autenticación. Los errores de red/introspección rechazan el acceso temporalmente sin
  revocar por ello una familia válida. `active: false` la invalida localmente. La
  recuperación mutable de OAuth ocurre solo después de tomar `writer.lock`, para que
  un segundo proceso rechazado no toque concesiones del escritor.
- `oauth-revoke-all` corta todas las familias locales mediante
  `oauth-revocations-v2.json`. El antiguo `oauth-owner.json` no es puerta de acceso.
  Familias v1 del owner secret no se cargan como v2: Claude debe reconectar. Esta
  transición conserva el emparejado, la clave, la SQLite y las notas. El comando antiguo
  `oauth-set-secret` devuelve un error claro.
- El formato v2 y la revocación local son independientes de la revocación visible en la
  página de Lumbre. Revocar una familia por OAuth corta primero su acceso local y luego
  pide la revocación upstream. Revocar la concesión en Lumbre deja la introspección
  inactiva y cierra la familia en el siguiente refresh o, en `/mcp`, en el primer acceso
  tras caducar la introspección guardada (30 s como máximo); no borra notas ni el dispositivo.
  El cambio de emparejado local, la revocación OAuth de la familia y `oauth-revoke-all` no
  pasan por esa espera: cortan en la petición siguiente.
- Los tests sintéticos comprueban el contrato local. Falta acreditar en producción el
  recorrido real Claude → login Lumbre → consentimiento → lectura → revocación → rechazo.

### 12.3 Secretos

- En Linux sin Secret Service, `@napi-rs/keyring` cae en silencio a keyutils, que no persiste tras
  reiniciar (`node_modules/@napi-rs/keyring/README.md:23-25`). En el contenedor no se usa.
- `FileSecretStore` (`src/secrets/file-secret-store.ts`) implementa la interfaz de `secret-store.ts`:
  un único JSON (`secrets.json`) en 0600, dentro del directorio de datos
  (`src/privacy/data-dir.ts`), que queda en 0700, con escritura atómica (fichero temporal 0600 +
  `fsync` + `rename`). Los permisos se corrigen en cada apertura si los encuentra más abiertos, en
  vez de fallar cerrado.
- Se elige por `HEBRA_MCP_SECRET_STORE=file|keychain` (por defecto `keychain`), leída en `serve`,
  `pair` y `unpair` (`src/server/main.ts`); nunca un fallback automático de uno a otro. La variable
  solo lleva el modo, jamás un secreto, y un valor desconocido falla con un error claro
  (`SecretStoreModeError`, `src/secrets/store-mode.ts`). En modo `file` no se importa
  `@napi-rs/keyring`.
- No se cifra: la SQLite ya está en claro en el mismo volumen.

### 12.4 Emparejado

- El listener tiene que estar en `127.0.0.1` de la máquina del navegador (§7), así que no se empareja
  dentro del contenedor.
- Se empareja en el Mac como dispositivo **nuevo**: `pair` con `HEBRA_MCP_DATA_DIR` temporal, almacén de
  ficheros y `--label "Claude remoto"`. David aprueba en Hebra > Ajustes > Sincronización. El directorio
  se copia al volumen por `scp` y se borra del Mac.
- Nunca se copia la identidad del llavero del Mac: serían dos motores con el mismo dispositivo.
- No hace falta cambiar Lumbre ni Hebra.

### 12.5 Despliegue

- Contenedor en el servidor de Lumbre, red externa `edge`, sin puertos publicados y con volumen de estado
  (patrón de lumbre-mcp `deploy/compose.yml`). Imagen `node:24-alpine` fijada por digest y sin root.
- `dist/` se compila en el Mac y se sube por `rsync`: el servidor no puede clonar el submódulo privado
  `vendor/hebra`. No se publica en ningún registro porque lleva código de Hebra.
- Host propio `mcp.hebra.pro` (elegido por David el 26 sep 2026), porque la metadata OAuth va en la raíz
  del host. El sitio Caddy se comprobó operativo el 28 sep 2026.
- Fragmento de Caddy versionado en `deploy/`, con límite de cuerpo, HSTS y `flush_interval -1`.
- Los comandos de mantenimiento van por `compose exec`, nunca por `run`: dentro de un contenedor el PID
  se repite y `writer-lock.ts` tomaría el bloqueo de otro como huérfano.
- `config.json` de privados vive en el volumen y se lee al arrancar: editarlo exige reiniciar.

### 12.6 Límites de protección

- Quien tenga root en el servidor, o escape de otro contenedor de ese host, lee y escribe toda la
  biblioteca, incluidas las notas privadas. El filtro de §6.3 solo actúa sobre la salida.
- Revocar en Lumbre la concesión Hebra MCP, su biblioteca o el dispositivo Blob V2 exacto
  invalida el acceso OAuth de Claude mediante introspección, con hasta 30 s de retraso en
  `/mcp` por la caché de §12.2. Retirar la credencial de
  emparejado también invalida la concesión y corta el sync; `oauth-revoke-all` corta
  todas las familias locales.
- Sin rotación de clave (§6.2), retirar el dispositivo no invalida la clave que ya tuvo.
- Se mantienen: sobres del relé cifrados, la app Lumbre sin la clave (volumen y entorno aparte), D2, el
  filtro y los logs cerrados.
- Por medir: si `backup-db.sh` del servidor copia el volumen.

### 12.7 Aceptación

1. Desde claude.ai web, móvil y una sesión en la nube, las veintiuna herramientas de §5
   responden; lo creado, añadido, editado, organizado, mandado a la papelera o restaurado aparece
   en Hebra.
2. Las notas privadas no llegan por ninguna herramienta.
3. `grep` de las notas-cebo en `docker logs` y en el log de Caddy da 0.
4. `/mcp` sin token responde 401 y `oauth-revoke-all` corta el acceso.
5. La suite stdio sigue en verde.

### 12.8 Lotes

| Lote | Qué | Criterio de cierre | Depende de |
|---|---|---|---|
| **C1** Secretos en fichero | `FileSecretStore` y selección explícita en `serve`, `pair` y `unpair`. | Tests: 0600/0700, escritura atómica, `unpair` lo deja vacío, valor corrupto = ausente, en modo fichero no se carga `@napi-rs/keyring`. | — |
| **C2** `serve-http` | Streamable HTTP sin estado: `POST /mcp`, límite de cuerpo, `allowedHosts`, `/healthz`; no arranca sin auth. | Las herramientas de lectura y creación de ese momento por el cliente HTTP del SDK; cebos fuera de stderr; dos `append` concurrentes correctos; suite stdio en verde. | — |
| **C3** OAuth y consentimiento Lumbre | §12.2. | Sin token 401 con `resource_metadata`; vínculo exacto de dispositivo/bóveda, callback y PKCE, código de un uso, refresh/revocación y reconexión tras formato v1. El recorrido real con Claude queda en C6. | C2 y broker Lumbre |
| **C4** Despliegue | Dockerfile, compose, Caddy y runbook para `mcp.hebra.pro`. Toca `/srv/edge`, compartido. | Contenedor sano; `/mcp` sin token 401; metadata PRM/AS accesible; ningún puerto en el host. | C1, C2, C3 |
| **C5** Emparejado remoto | §12.4. | Dispositivo nuevo en Hebra con `opaqueDeviceId` distinto del del Mac; `hebra_status` con `linked: true`. | C4 |
| **C6** QA real | §12.7 en la biblioteca de David. | Aceptación de David. | C5 |

C1 y C2 van en paralelo.
