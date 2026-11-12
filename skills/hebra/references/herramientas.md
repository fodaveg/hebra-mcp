# Herramientas: entradas, salidas y límites

Lo que la descripción de cada herramienta en el MCP no dice: campos de entrada y salida, topes y
casos límite. Léelo cuando necesites un campo concreto o no sepas por qué una respuesta trae lo
que trae. Los topes vigentes también salen en `hebra_status`, en `capabilities.limits`. Los
ficheros sueltos, `hebra_replace_in_notes` y las de Johnny.Decimal tienen su propia referencia:
[ficheros sueltos](ficheros-sueltos.md), [sustituir en varias notas](sustituir-en-varias-notas.md)
y [Johnny.Decimal](johnny-decimal.md).

## Reglas comunes

- `space`: todas lo aceptan salvo `hebra_list_spaces` y `hebra_list_organizations` (ver
  [espacios y organizaciones](espacios-y-organizaciones.md)). Las tablas no lo repiten.
- Paginación: pasa el `nextCursor` recibido en la siguiente llamada; `null` es el final. Un
  cursor ilegible, de otra herramienta o de un elemento que ya no existe da `invalid_input`.
- Fuera de `hebra_trash_note`, `hebra_restore_note` y `hebra_list_trash`, ninguna devuelve notas
  de la papelera.
- `isConflictCopy: true` marca una copia de conflicto en `hebra_search`, `hebra_grep`,
  `hebra_list_notes`, `hebra_list_trash`, `hebra_read_note` y en las notas del plan de
  `hebra_replace_in_notes` (`simulate` y `preview`). `conflictOf` (el id de la original) solo
  sale en `hebra_read_note`, y solo si la original se ve. Los backlinks de `hebra_links` no
  marcan conflictos.
- Los límites de los parámetros los rechaza ya el esquema del cliente MCP.

## Buscar y leer

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_search` | `query` (FTS5), `limit` 1-50 (20), `cursor?`, `folder?`, `subfolders?`, `tag?`, `props?` (`[{key, value}]`: el valor entero, o `null` para pedir que tenga la clave), `linksTo?` (títulos enteros, no ids), `titleOnly?`, `fields?` (subconjunto de `title`, `folderPath`, `tags`, `snippet`, `heading`, `updatedAt`, `isConflictCopy`) | `{results: [{id, title, folderPath, tags, snippet, heading, updatedAt, isConflictCopy}], nextCursor}`. `heading` es el apartado más interno del fragmento (o `null`) y vale tal cual como `heading` de `hebra_read_note`. Ignora tildes y encuentra por prefijo. Con `folder`, `subfolders` incluye el subárbol. |
| `hebra_grep` | `pattern` (literal; con `regex: true`, expresión regular de JavaScript), `caseSensitive?` (def. `false`), `folder?`, `subfolders?`, `tag?`, `contextLines?` 0-5, `limit` 1-100 (20), `cursor?` | `{matches: [{id, title, isConflictCopy, line, column, text, before?, after?, heading, headingOccurrence}], nextCursor, cutoff}`, una por línea que casa, sin recuentos. `heading` y `headingOccurrence` van tal cual a `hebra_read_note`; `line` vale para su `lines`. Las tildes cuentan. `cutoff: "time"` o `"size"`: se paró antes, sigue con `nextCursor`. `skipped: {id, fromLine}`: esa nota se saltó sin buscar en ella; dilo si importa. `pattern_too_slow`: ver [errores](errores.md). |
| `hebra_list_notes` | `folder?`, `subfolders?`, `tag?`, `archived?`, `cursor?`, `limit` 1-100 (50), `fields?` | `archived: true` lista solo las archivadas (la última archivada primero); con `folder` o `tag` es `invalid_input`. |
| `hebra_read_note` | `id` **o** `title` (exactamente uno), `heading?`, `headingOccurrence?`, `lines?: {from, to?}` (no con `heading`) | Cuerpo íntegro, `revision` y el estado: `favorite`, `archivedAt`, `generalHidden`. Con `heading`, `body` es solo ese apartado y salen `section` y `totalChars`; con `lines`, solo esas líneas (hasta 2 000) y salen `lines`, `totalLines` y `totalChars`. Título ambiguo: `ambiguous_title` con hasta 50 candidatas visibles; apartado repetido: `ambiguous_heading` con `candidates`. |
| `hebra_note_outline` | `id` **o** `title`, `maxLevel?` 1-6, `limit?` 1-500 (200), `cursor?` | `{id, title, revision, totalChars, sections: [{heading, level, line, chars, occurrence?}], nextCursor}`, sin cuerpo. `chars` es lo que devolvería la lectura de ese apartado. `occurrence` solo sale en los títulos repetidos: es el `headingOccurrence` que hay que pasar. |
| `hebra_list_tags` | `limit?` 1-500, `cursor?` | Anidadas como `a/b`, con recuento. |
| `hebra_list_folders` | `limit?` 1-500, `cursor?` | `{folders: [{id, path, count}]}`. `path` para el `folder` de las demás; `id` para `hebra_move_note` y `parentId`. |
| `hebra_links` | `id`, `limit?` 1-200, `cursor?` | `outgoing` (con `resolvedId` si resuelve) y `backlinks`. |

### `hebra_grep` o `hebra_search`

- `hebra_grep` para una cadena exacta (un id, una ruta, una cita, `TODO:`), un patrón o todas las
  apariciones con su línea; `hebra_search` para buscar por palabras.
- Después, `hebra_read_note` con `lines` (unas líneas alrededor de la `line` encontrada) o con
  `heading` (el apartado que da `heading`), sin traer la nota entera.
- `hebra_search` con `props` con valor comprueba el valor nota a nota sobre los aciertos de
  texto: si casan muy pocas de una biblioteca grande, tarda más que sin él. Para listar por una
  propiedad sin buscar texto, mejor `hebra_query_properties`.
- Las notas que enlazan a otra: `hebra_links` con su id; dentro de una búsqueda por texto,
  `hebra_search` con `linksTo` y el título entero.

## Propiedades del frontmatter

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_list_properties` | `key?`, `limit?` 1-500 (100), `cursor?` | Sin `key`, `{keys: [{key, count}], nextCursor}`; con `key` (en minúsculas), `{values: [{value, count}], nextCursor}`. Una página puede traer menos que `limit` si es muy larga: sigue su `nextCursor`. |
| `hebra_query_properties` | `filters?` (hasta 32: `[{key, op, value?}]`, `op` = `equals`, `not-equals`, `contains`, `not-contains`, `greater-than`, `greater-or-equal`, `less-than`, `less-or-equal`, `exists`, `missing`; los dos últimos sin `value`, los demás con él), `folder?`, `subfolders?`, `sort?: {key?, direction?, empty?}`, `properties?`, `limit` 1-100 (50), `cursor?`, `fields?` (`title`, `folderPath`, `properties`) | `{notes: [{id, title, folderPath, properties: {clave: [valores]}}], nextCursor}`. `properties`: las claves cuyos valores quieres; sin él, las de `filters` y `sort`. Sin `sort.key`, por título; con él, por su valor (numérico si todos lo son), y las notas sin ella al final, o al principio con `empty: "first"`. Una página puede traer menos que `limit`. `invalid_input` con un cursor que valía: la clave cambió entre número y texto; vuelve a empezar sin él. |

## Espacios y organizaciones

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_list_spaces` | sin argumentos | `{spaces: [{spaceId, name, organization: {orgId, name} \| null, granted}], organizationsAvailable}`. Detalle en [espacios y organizaciones](espacios-y-organizaciones.md). |
| `hebra_list_organizations` | `limit?` 1-100, `cursor?` | `{organizations: [{orgId, name, members: [{accountId, role, name, isSelf}], spaces: [{spaceId, name, granted}]}], nextCursor}`. No abre contenido. |
| `hebra_note_authors` | `id` | `lastEditor`, `declaredAuthorId`, `mismatch`, `namesResolved`. Solo hay autores en un espacio; detalle en [espacios y organizaciones](espacios-y-organizaciones.md). |

## Escribir notas

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_create_note` | `body` (hasta 100 000 caracteres), `folder?` (ruta) | El título sale del cuerpo (ver "Título de una nota" en `SKILL.md`). No devuelve `sync`. |
| `hebra_append_to_note` | `id`, `text` (hasta 20 000 caracteres), `heading?`, `headingOccurrence?`, `operationId?` | Sin `heading`, añade `\n\n` + texto al final de la nota; con él, al final de ese apartado (subapartados incluidos). `outcome: "saved" \| "merged" \| "conflict_copy"`. Con `saved` o `merged`: `revision` nueva, `totalChars` y `appended: {chars, tail, line, heading?}` (`tail` = el final del texto, leído de la nota guardada). Con `conflict_copy` no hay prueba. Con `operationId`, reintentar con el mismo no lo añade dos veces (24 h): devuelve lo mismo con `replayed: true`. No devuelve `sync`. |
| `hebra_edit_note` | `id`, `edits: [{find, replace}]` (1-50; suma de todos los `find` y `replace` hasta 100 000), `expectedRevision`, `operationId` | `outcome`, `revision` nueva, `totalChars`, `applied`, `copyId?`, `sync`, `replayed`. Ver "Cómo se edita" en `SKILL.md`. |

## Organizar y papelera

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_move_note` | `id`, `folderId` (`"root"` = raíz), `expectedRevision?` | Solo a carpetas que ya existen. `{folderPath, favorite, archived, sync}`. |
| `hebra_set_favorite` | `id`, `favorite` | Idempotente. Misma salida que mover. |
| `hebra_set_archived` | `id`, `archived` | Idempotente. Misma salida que mover. |
| `hebra_set_hidden` | `id`, `hidden` | Idempotente. Misma salida que mover, más `hidden`. |
| `hebra_clear_conflict` | `id` (una copia, `isConflictCopy: true`) | Misma salida que mover, más `cleared`; sobre otra nota, `cleared: false` sin escribir. |
| `hebra_trash_note` | `id`, `expectedRevision?` | Idempotente. `{id, trashed: true, sync}`. |
| `hebra_restore_note` | `id` (de `hebra_list_trash`), `expectedRevision?` | Misma salida que mover. `expectedRevision`: solo la que leíste antes de mandarla a la papelera. |
| `hebra_list_trash` | `kind?` (`notes` por defecto o `folders`), `cursor?`, `limit` 1-100 (50) | La última en entrar primero; `folderPath` = donde volverá. Con `kind: "folders"`, `{folders: [{id, name, path, trashedAt}]}`. |

## Versiones anteriores

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_list_versions` | `id`, `limit?` 1-200 (50), `cursor?` | `{id, versions: [{versionId, createdAt, byteLength}], nextCursor}`, la más reciente primero. Un cursor cuya versión ya no existe da `invalid_input`. |
| `hebra_read_version` | `id`, `versionId`, `authors?`, `source?` | El cuerpo de esa versión. Con `space` y `authors: true`, también `authorRuns`: el texto en tramos con su autor. |
| `hebra_restore_version` | `id`, `versionId`, `expectedRevision`, `operationId`, `source?` | Como `hebra_edit_note` pero con el cuerpo entero de la versión (sin `applied`). Lo que había queda como versión. En un espacio puede volver `merged`. |

Para "recupera cómo estaba la nota": `hebra_list_versions`, `hebra_read_version` para enseñarle
la que elija, `hebra_read_note` (por la `revision`) y `hebra_restore_version` con un
`operationId` nuevo. En la biblioteca personal las versiones son las de este dispositivo: si la
que busca no está (las de otros dispositivos no llegan aquí), que la restaure desde Hebra. Con
`space` son las del historial del espacio en el servidor, las que ven todos los miembros, con
quién editó cada una (`editedBy`; un agente sale como "<nombre> (agente)"). Si la respuesta dice
`source: "local"` (el servidor no las dio), son las de este dispositivo: pasa ese mismo `source`
a `hebra_read_version` y `hebra_restore_version`.

## Adjuntos de una nota

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_list_attachments` | `id`, `limit?` 1-200 (sin él, todos), `cursor?` | `{id, attachments: [{attachmentId, name, mimeType, byteLength}], nextCursor}` en el orden del cuerpo. `mimeType`/`byteLength` pueden ser `null` hasta leerlo. |
| `hebra_read_attachment` | `id`, `attachmentId`, `offset?` (0), `maxChars?` (1-100 000, def. 100 000; se validan también con imagen y PDF, que salen íntegros) | Imagen o PDF: contenido íntegro. Texto plano, Markdown, CSV, JSON: bloque con `{totalChars, truncated, nextOffset}` y el texto; para leer el resto, `offset = nextOffset`. Hasta 5 MiB descifrados. |
| `hebra_add_attachment` | `id`, `name` (con extensión; sin `\|`, `[`, `]`, `\`, `#`, saltos de línea ni caracteres invisibles como U+200B; hasta 255), `dataBase64`, `mimeType?`, `heading?`, `headingOccurrence?`, `operationId` | Añade `![[sha256:H\|name]]` al final (separado por una línea en blanco) y lo sube con el sync; con `heading`, al final de ese apartado, y un guardado nuevo trae `placed` (`line`, `heading`). PNG, JPEG, GIF, WebP y PDF se reconocen por su contenido; texto, Markdown, CSV y JSON por `mimeType` o extensión. Devuelve `outcome`, `attachmentId`, `markdown`, `revision`, `sync`; `conflict_copy` como un append. Si la nota termina dentro de un bloque de código sin cerrar, lo cierra antes (con `heading`, solo si ese apartado es el último de la nota); si termina en otra cosa sin cerrar (un `<!--`), `invalid_input`. |

## Carpetas

| Herramienta | Entrada | Salida y notas |
|---|---|---|
| `hebra_create_folder` | `name` (hasta 255, sin `/`), `parent?` (ruta) **o** `parentId?` (`"root"` = raíz); sin ninguno, la raíz | `{id, path, created, sync}`. Si ya hay una con ese nombre ahí (sin distinguir mayúsculas), la devuelve con `created: false`: sirve para replicar una estructura sin comprobar antes. Para anidar, encadena con el `id` devuelto (`parentId`), de arriba abajo. |
| `hebra_rename_folder` | `folderId`, `name` | `{id, path, renamed, sync}`. El mismo nombre: `renamed: false`. Lo que el MCP no ve dentro de la carpeta se queda dentro, oculto. |

## Estado

`hebra_status` (sin argumentos aparte de `space`) devuelve el vínculo y el sync, sin contenido:
`linked`, `revoked` (y `revokedReason`), `lastSyncAt`, `lastSyncOutcome` y `pendingUpload`; y
`capabilities`: `server.version`, `tools` (las herramientas que tiene este servidor), `limits`
(máximos de `limit` y tamaños de escritura, adjuntos, nombres...), `notAllowed` y
`privacyConfigured`. `lastSyncAt: null` puede querer decir que la primera ronda de sync aún no
terminó: una lectura la espera como mucho 10 s y después responde con lo local.
