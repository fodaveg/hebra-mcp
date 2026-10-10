# hebra-mcp: SPEC v1

Estado: borrador, 26 sep 2026. Tareas en Lumbre: proyecto «hebra-mcp» (anidado en «21.13 Hebra»).
Hechos de Hebra medidos en `~/code/hebra` en `cf883cb9` (26 sep 2026), solo lectura.

## 1. Objetivo

Dar a Claude (Claude Code y Claude Desktop) acceso a la biblioteca de notas de Hebra mediante un
servidor MCP que **lee** la biblioteca y **crea, edita y organiza** contenido sin riesgo de perder
texto (D2, ampliada el 28 sep 2026 y, con la papelera y las versiones anteriores, el 30 sep 2026;
D9, crear y renombrar carpetas y añadir adjuntos, el 3 oct 2026; D10, listar los ficheros sueltos
y mandarlos a la papelera, el 9 oct 2026; D11, leer y escribir una nota por apartados, el 9 oct 2026;
D13, buscar texto exacto línea a línea y leer una nota por líneas, el 10 oct 2026).

## 2. Aceptación de v1

1. David vincula `hebra-mcp` a su biblioteca desde el flujo de aprobación de Hebra
   (Ajustes > Sincronización) y el proceso descarga la biblioteca completa.
2. Desde Claude Code, las veintinueve herramientas de §5 responden con el esquema de §5.
3. Una nota creada o ampliada desde Claude aparece en Hebra (Mac e iPhone) tras un ciclo de sync.
4. Si Claude añade texto a una nota que David está editando a la vez, aparece una copia de
   conflicto visible en Hebra y ningún texto se pierde.
5. Ninguna nota de una carpeta o etiqueta privada llega a Claude por ninguna herramienta
   (títulos, cuerpos, fragmentos de búsqueda, enlaces, backlinks ni recuentos).
6. Los logs no contienen títulos, cuerpos, consultas ni argumentos de herramientas.
7. Al revocar la conexión en Lumbre, el proceso deja de sincronizar y lo dice en `hebra_status`.

El conector remoto (D6) añade su propia aceptación en §12.7.

## 3. Decisiones de David (26 sep–10 oct 2026, cerradas; D12, ficheros de trabajo, y D13, `hebra_grep` y lectura por líneas, el 10 oct 2026)

| # | Decisión | Motivo / descartes |
|---|---|---|
| D1 | **Dispositivo propio**: proceso Node que se vincula a la biblioteca como un dispositivo más por el flujo de aprobación, con su propia SQLite y el MISMO motor de sync de Hebra. Transporte MCP: **stdio** primero; conector remoto más adelante (D6). | El sync va cifrado de punta a punta: el relé de `app.lumbre.pro` no puede leer notas. Descartados: leer la SQLite del contenedor del Mac y un MCP en el servidor de Lumbre (este último, revocado por D6). |
| D2 | **v1 = leer y crear**: listar, buscar (FTS), leer notas, etiquetas, carpetas, enlaces y backlinks; crear nota nueva y añadir texto al final de una existente (**ampliado el 10 oct 2026**, decidido por delegación de David tras el audit de robustez del escritor, que vio un append duplicado al reintentar tras un despliegue o un SIGKILL del escritor: `hebra_append_to_note` acepta un `operationId` **opcional** y con él es idempotente, en el mismo registro y con la misma maquinaria que `hebra_edit_note` y `hebra_add_attachment`; sin él, cada llamada añade, como siempre). **Ampliada el 28 sep 2026** («me parecen ok tus decisiones del mcp. adelante con ellas»): 1) el MCP puede modificar notas existentes; 2) por **sustituciones puntuales** `{find, replace}` sobre la revisión leída, nunca reescribiendo el cuerpo entero (renombrar = editar el H1); 3) primer lote = edición + organización (mover nota, favorita, archivar/desarchivar; las carpetas, ver 5); papelera y versiones entraron el 30 sep (ver 6), y los adjuntos, en solo lectura, también (ver 7), y **nunca** purga nada irreversible; 4) nunca mueve una nota a una carpeta privada ni le pone una etiqueta privada, por ninguna vía: se rechaza sin escribir y con el mismo error que un destino inexistente; 5) **opción A** (28 sep 2026): crear, renombrar y mover carpetas quedan **fuera** del MCP, porque sus errores revelarían carpetas privadas (`folder_name_taken` delataba una hermana privada; renombrar o mover una carpeta con una privada dentro respondía distinto); las carpetas se crean desde la app Hebra, y el MCP solo mueve notas a carpetas que ya existen (**sustituido en parte por D9**, 3 oct 2026: crear y renombrar carpetas visibles sí, con un error único decidido desde la configuración; mover y borrar carpetas siguen fuera); 6) **papelera y versiones** (30 sep 2026, «acepto tus recomendaciones»; **ampliada por D10**, 9 oct 2026: también los ficheros sueltos van a la papelera y salen de ella, con su propia regla de privacidad): el MCP manda una nota visible a la papelera, la saca y lista la papelera, pero **nunca** purga, vacía la papelera ni borra nada de forma irreversible; en la papelera rige el mismo filtro (una nota de carpeta privada o subcarpeta, también si la carpeta ya se borró, o con etiqueta privada o descendiente no aparece, y mandarla o sacarla responde `not_found`, igual que una inexistente), y restaurar nunca deja una nota en una carpeta que el cliente no ve. Lista y lee las versiones anteriores de una nota visible, y restaurar una versión es una **edición nueva** con el mismo control de concurrencia que `hebra_edit_note` (revisión leída; choque = copia de conflicto visible); una versión cuyo cuerpo lleva una etiqueta privada no se devuelve ni se restaura (misma respuesta que una inexistente, regla 4). Las demás herramientas siguen sin devolver notas de la papelera; 7) **adjuntos en solo lectura** (30 sep 2026, tercer lote de D2; **sustituido en parte por D9**, 3 oct 2026: añadir un adjunto a una nota visible sí; borrar y cambiar adjuntos siguen fuera): el MCP lista y lee los adjuntos de una nota visible y **nunca** añade, borra ni modifica ninguno; una nota oculta o un adjunto de una nota oculta responde `not_found`, igual que uno inexistente; como mucho **5 MiB** descifrados por adjunto (si no, `attachment_too_large` con el tamaño, sin bajar más de lo necesario cuando el tamaño se sabe antes); solo PNG, JPEG, GIF, WebP, PDF, texto plano, Markdown, CSV y JSON, decidido por el contenido y el descriptor del motor, no solo por la extensión (si no, `attachment_type_not_allowed`); las imágenes salen como contenido `image`, el texto como texto y el PDF como recurso embebido, nunca con rutas locales, URLs de blob ni URLs permanentes. Un choque con una edición produce una copia de conflicto visible, como en Bear. | El motor ya hace la copia de conflicto (§7 de la spec de Hebra) y ya permitía editar (`noteSave` con `expectedLocalSeq`/`baseBodySha256`). |
| D3 | **Ve toda la biblioteca salvo** carpetas o etiquetas marcadas como privadas en la configuración del MCP. El filtro vive en el MCP y se aplica antes de devolver nada a la IA. | |
| D4 | **Cuándo** (revisada el 26 sep 2026): **BEAR-22 queda cerrada** por decisión de David (la biblioteca actual es de prueba y la va a reimportar desde Obsidian). Se hacen **todos los lotes ya**, en orden L0 → L1 → L2 (en cuanto Lumbre despliegue L2a) → L3 → L4. Objetivo: que David use Hebra en serio con el MCP cuanto antes. | La versión anterior esperaba a BEAR-22 para todo lo que cambiara el sync o el vínculo en Hebra. |
| D5 | **Repo**: hebra-mcp es público y consume Hebra (privado, sin licencia) por submódulo fijado a un SHA, sin versionar código de Hebra. | Descartados: hacer hebra-mcp privado y publicar el núcleo de Hebra con licencia. |
| D6 | **Conector remoto** (26 sep 2026): hebra-mcp tiene que funcionar como conector remoto de claude.ai (web, móvil, sesiones en la nube), y **corre en el servidor de Lumbre**, en un contenedor aparte. stdio sigue funcionando en local. Diseño en §12. | Revoca el descarte de D1: ese servidor guarda las claves de la biblioteca y puede leer las notas (quien tenga root en él). Descartados: una máquina de casa (Fedora o Mac) publicada con Tailscale Funnel, que mantenía el cifrado de punta a punta pero solo funcionaba con esa máquina encendida. |
| D7 | **Autenticación del conector remoto** (revisada el 28 sep 2026): conservar el OAuth público de Hebra MCP y usar login y consentimiento de Lumbre para aprobar la biblioteca ya emparejada. | Sustituye la decisión del 26 sep de usar un secreto del dueño. El login no entrega la clave de biblioteca ni reasocia otra biblioteca. |
| D8 | **Mejoras de paginación y adjuntos** (2 oct 2026): 1) caché de introspección de 30 s (por familia de token); 2) paginación de versiones (limit 1-200, def. 50) y adjuntos (limit 1-200 opcional); 3) lectura de adjuntos de texto por tramos (offset, maxChars 1–100 000, def. 100 000, con totalChars, truncated y nextOffset). Riesgo aceptado: la ventana de 30 s vale para toda revocación hecha en Lumbre (concesión, biblioteca o dispositivo Blob V2), y con Lumbre caído una entrada vigente sigue dando acceso hasta 30 s. El refresh nunca usa la caché. | Medidas de escala y usabilidad. |
| D9 | **Carpetas y adjuntos** (3 oct 2026, «te autorizo a hacer todo lo que te pida hebra», a petición de la sesión de Hebra, que necesita replicar la estructura de carpetas de Obsidian y subir capturas PNG de audits). Sustituye en parte los puntos 5 y 7 de D2: 1) el MCP **crea y renombra carpetas** visibles (`hebra_create_folder`, `hebra_rename_folder`); **mover y borrar carpetas siguen fuera**; 2) la privacidad de una carpeta se decide **con la configuración, antes de mirar el motor**: una ruta resultante que es una carpeta privada configurada (o queda debajo de una), renombrar una carpeta que tiene una privada configurada debajo, o cualquier choque de nombre con algo no visible responden el mismo `folder_unavailable`, exista o no esa carpeta; `folder_name_taken` solo sale con una hermana VISIBLE; crear es idempotente (una visible con ese nombre bajo ese padre se devuelve con `created: false`) y renombrar al nombre que ya tiene no escribe; 3) el MCP **añade un adjunto** a una nota visible (`hebra_add_attachment`), con los MISMOS tipos y el mismo tope de 5 MiB que la lectura (decisión 7), guardado con `blobPut` del motor y referenciado al final del cuerpo como `![[sha256:H\|nombre]]` por la vía de `hebra_append_to_note` (copia de conflicto si choca) con la idempotencia de `hebra_edit_note` (`operationId`); sube al relé con la ronda de sync (Blob V2), así que nunca queda un blob sin una nota que lo referencie; **borrar y cambiar adjuntos siguen fuera**. | La opción A sacaba las carpetas del MCP porque sus errores revelaban carpetas privadas; con un error único decidido desde la configuración ya no las revelan. |
| D10 | **Ficheros sueltos** (9 oct 2026, «adelante con las tres»; antes, por la sesión de Hebra de Fedora, que necesitaba mandar ficheros sueltos a la papelera: «pidele a la sesión en el mac de hebra-mcp que lo haga»). Amplía la decisión 6 de D2 a los ficheros sueltos de la biblioteca (la tabla `files` de Hebra: un `.base`, un PDF que no cuelga de una nota): 1) el MCP **lista** los ficheros sueltos (`hebra_list_files`), **manda uno a la papelera** (`hebra_trash_file`) y **lo saca** (`hebra_restore_file`); 2) **nunca purga** un fichero ni lo borra de forma irreversible, y **leer su contenido, crearlo, renombrarlo, moverlo o reemplazarlo siguen fuera**; 3) privacidad (decisión técnica del orquestador, que aplica a los ficheros las reglas 4 y 6 de D2 y cierra ante la duda): un fichero está oculto **(a)** si su carpeta es privada o subcarpeta, también si la carpeta ya se borró (se sube por las lápidas como en la papelera de notas), o **(b)** si lo enlaza alguna nota oculta, viva o de la papelera, por su nombre o por el SHA-256 de sus bytes; la regla es la misma para los vivos y para los de la papelera, se aplica en la herramienta y otra vez en el escritor, y un fichero oculto responde `not_found`, igual que uno inexistente; restaurar nunca deja un fichero en una carpeta que el cliente no ve; 4) sin `operationId`: mandar y sacar son idempotentes por estado, como `hebra_trash_note`. | Los ficheros sueltos estaban fuera de v1 (§10, «Después de v1»). Coste asumido de la regla (b): oculta de más con homónimos (un fichero visible que se llama igual que otro enlazado desde una nota oculta tampoco sale). |
| D11 | **Notas por apartados** (9 oct 2026; alcance de David en la tarea de Lumbre «hebra-mcp: leer y escribir una nota por apartados, sin traer la nota entera», con la orden «haz […] y sube»; el diseño, de Claude). Motivo: una nota de decisiones real ocupa 43 700 bytes y 8 apartados, y registrar una decisión costaba tres llamadas con la nota entera en el contexto (leerla, `hebra_edit_note` y un `hebra_search` para comprobar que el texto entró, porque la escritura respondía «saved» sin prueba). Criterio: registrar una decisión en un apartado con DOS llamadas pequeñas (esquema de la nota y añadir al apartado), sin que el cuerpo entero pase por el contexto del cliente y con la respuesta de la escritura como prueba de lo guardado. 1) **Apartado** = un encabezado ATX y todo lo que sigue hasta el siguiente de nivel igual o menor o el final (subapartados incluidos); no cuentan las líneas del frontmatter inicial ni de los bloques de código cercados, y los encabezados Setext (subrayados con `===` o `---`) **no** son apartados (límite deliberado: menos falsos positivos al escribir). Títulos comparados como `normalizedHeading` de Hebra (NFKC, recortados, espacios colapsados, minúsculas); el analizador es código propio de hebra-mcp (`src/store/sections.ts`), no importa el de Hebra. 2) `hebra_read_note` y `hebra_append_to_note` aceptan `heading?` y `headingOccurrence?`; la herramienta nueva `hebra_note_outline` da el esquema (títulos, niveles, líneas y tamaños, sin cuerpo). 3) Un título ambiguo no se adivina: `ambiguous_heading` con los candidatos, y se elige con `headingOccurrence`. 4) Las escrituras devuelven **prueba de lo guardado** leída del cuerpo guardado, no un eco de la entrada (`appended`, `applied`, `totalChars`, `revision`). 5) `hebra_search` devuelve el apartado más interno del fragmento (`heading`). 6) Privacidad sin cambios: ninguna regla nueva; una nota oculta responde `not_found` también con `heading`, y ningún título de apartado ni texto de nota entra en un log. 7) **Ampliada el 10 oct 2026** (decidido por delegación de David, con la ampliación de D2 del mismo día): con `operationId`, el reintento de `hebra_append_to_note` devuelve la prueba de lo guardado anotada en el registro (la de la primera vez) con `replayed: true`, sin volver a escribir; si el registro se quedó a medias (`started`) y el cuerpo es el que se iba a guardar, `revision` y `totalChars` del cuerpo actual, sin `appended` (no consta dónde quedó el texto). | Descartado: partir la nota en varias o reservar marcadores de apartado (cambiaría el contenido del usuario). Descartado: Setext y apartados por HTML o negritas (ambiguos y fáciles de escribir sin querer). Coste asumido: una nota con dos apartados del mismo título obliga a elegir por `headingOccurrence`. |
| D12 | **Ficheros de trabajo con vuelta** (10 oct 2026, decidido por David; tarea D de Lumbre c4f2fd52, sobre la sonda de la opción D del audit `2026-10-10-sqlite-o-markdown.md` de Hebra): `hebra-mcp checkout`, `apply` y `undo`, más `status` y `diff` de consulta, como subórdenes LOCALES del mismo dispositivo emparejado que `serve` (§13). 1) SQLite sigue mandando: los `.md` son una copia de trabajo y vuelven solo con `apply`. 2) **Excepción a D2 solo en esta vía local**: `apply` y `undo` reescriben el cuerpo entero comprobando la base (`baseBodySha256` del motor; en la rama de conflicto, con un `expectedLocalSeq` que nunca coincide, §13.4), con instantánea forzada antes y el cuerpo base guardado por lote. Las herramientas MCP, por stdio y en el conector remoto, siguen por sustituciones y no ganan ninguna escritura nueva. 3) D3 se aplica: lo privado no sale en `checkout` ni se puede devolver una nota que lo sea o lo pasaría a ser. | Coste para un agente local igual al de editar ficheros sueltos (AC7 de la sonda, ronda 2: 0,95× en tokens) sin cambiar quién manda. Descartado para la vía local: traducir el diff a sustituciones como la vía remota (frágil al mover apartados, y una reescritura grande serían varias llamadas sin atomicidad por nota). |
| D13 | **`hebra_grep` y lectura por líneas** (10 oct 2026, decidido por David; tarea F1 de Lumbre 0cc70688, la fase F1 del plan del audit `2026-10-10-sqlite-o-markdown.md` de Hebra). **Reabre el descarte de D11**, que solo dejaba leer una parte de una nota por apartados. Motivo: buscar un texto exacto o un patrón en toda la biblioteca y leer solo lo que rodea cada coincidencia, sin traer notas enteras al contexto (una nota de 1 MB son unos 290 000 tokens y la biblioteca, millones: el grep se hace donde están los datos). Aceptación: grep sobre unos 20 MB en el servidor por debajo de 1 s, y una nota privada nunca sale en resultados ni en recuentos. 1) `hebra_grep` (§5): literal o expresión regular de JavaScript, línea a línea, sobre el cuerpo de las notas visibles; por coincidencia, la nota, el número de línea, la columna, la línea (recortada a un tope), las líneas de contexto pedidas y `heading` (el apartado más interno, con el analizador de D11); filtros de carpeta (con subcarpetas), etiqueta y mayúsculas; paginación con cursor; topes de resultados, de tiempo y de tamaño, con un corte explícito (`cutoff`) y un cursor para seguir. 2) `hebra_read_note` acepta `lines: {from, to?}` con la numeración de la nota entera, la de `hebra_grep` y `hebra_note_outline`; con `heading`, `invalid_input`. 3) D3 sin reglas nuevas, y además sin delatar nada por los números: solo se lee el cuerpo de las notas visibles y sin bloquear, y ninguna salida lleva un recuento, ni el plazo ni el corte dependen de las ocultas (§6.3). 4) Expresiones regulares en un hilo aparte que se mata al agotarse el plazo; si no termina ni una nota, `pattern_too_slow`. 5) Prefiltro con el índice de subcadena de Hebra (H5, §8) cuando el patrón tiene un trozo literal obligatorio de tres caracteres o más y el índice está completo; se comprueba siempre sobre el cuerpo. Medido (10 oct 2026, este Mac, `npm run perf:grep`): 4 064 notas y 20 976 723 caracteres de cuerpo, la peor de tres llamadas por consulta entre 8 y 118 ms en dos pasadas, con índice y sin él (§5). | Descartado: restringir la sintaxis de las expresiones regulares (no hay una regla que aparte las catastróficas sin rechazar expresiones normales) y el motor lineal de V8 (experimental y con una bandera de todo el proceso). Descartado: líneas relativas al apartado con `heading` (no casarían con las de `hebra_grep` ni con `line` de `hebra_note_outline`). Coste asumido: el plazo puede cortar una página aunque queden coincidencias (con `cutoff` y cursor), y una nota editada entre dos páginas puede repetir o saltarse líneas. |

## 4. Arquitectura

```
Claude Code / Desktop ──stdio(MCP)──► hebra-mcp (Node 24)
                                        ├─ servidor MCP: 29 herramientas + filtro de privados
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
  Es el almacén de adjuntos del motor: guarda lo que baja `readBlob` al leer un adjunto (decisión 7
  de D2) y lo que añade `hebra_add_attachment` (`blobPut`, D9), que la ronda de sync sube al relé;
  hebra-mcp no crea otro.
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
- Los ficheros sueltos (D10) solo salen por sus tres herramientas (`hebra_list_files`,
  `hebra_trash_file`, `hebra_restore_file`), con su propio filtro (§6.3). Ninguna devuelve su
  contenido, su SHA-256 ni un recuento.
- `isConflictCopy: true` sale en `hebra_search`, `hebra_list_notes`, `hebra_list_trash` y `hebra_read_note`. `conflictOf` (el id de la nota original) solo en `hebra_read_note`. Los backlinks de `hebra_links` no marcan conflictos.
- Toda salida pasa por el filtro de privados (§6.3).
- Los identificadores son los `id` de nota del almacén.
- Las fechas van en ISO 8601.

| Herramienta | Entrada | Salida |
|---|---|---|
| `hebra_search` | `query` (texto, FTS5), `limit` (1-50, def. 20), `cursor?`, `folder?` (ruta), `subfolders?` (con `folder`, incluye su subárbol según el árbol de carpetas, igual que `hebra_list_notes`; def. `false`), `tag?`, `fields?` (subconjunto de `title`, `folderPath`, `tags`, `snippet`, `heading`, `updatedAt`, `isConflictCopy`; `id` siempre) | `{results: [{id, title, folderPath, tags, snippet, heading, updatedAt, isConflictCopy}], nextCursor}`. `heading` (D11): el título, tal como está en la nota, del apartado MÁS INTERNO que contiene el fragmento que enseña `snippet`; sirve tal cual como `heading` de `hebra_read_note`. `null` si el fragmento cae antes del primer encabezado, si no se logra localizar o si la nota está bloqueada. Solo se lee el cuerpo de los resultados visibles que se devuelven y solo si `heading` está entre los campos pedidos. |
| `hebra_grep` (D13) | `pattern` (1-1 000 caracteres, sin saltos de línea), `regex?` (def. `false`: literal; con `true`, expresión regular de JavaScript con la bandera `u`), `caseSensitive?` (def. `false`; las tildes cuentan siempre), `folder?`, `subfolders?`, `tag?` (como en `hebra_search`), `contextLines?` (0-5, def. 0), `limit` (1-100, def. 20), `cursor?` | `{matches: [{id, title, isConflictCopy, line, column, text, textStart?, lineChars?, before?, after?, heading, headingOccurrence}], nextCursor, cutoff}`. Una entrada por línea que casa (la primera coincidencia de la línea), en orden de id de nota y de línea. `line` y `column`, 1-based (la columna en unidades UTF-16); `line` es la de `hebra_read_note` con `lines`. `text`: la línea sin su terminador; si pasa de 300 caracteres, un trozo de 300 alrededor de la coincidencia, con `textStart` (columna donde empieza) y `lineChars` (longitud de la línea). `before`/`after`, solo con `contextLines`: las líneas de alrededor dentro de la nota, cortadas a 300 caracteres con `…`. `heading`: el apartado más interno que contiene la línea (D11), o `null` antes del primer encabezado; `headingOccurrence`: cuál de los encabezados con ese título es (1-based, como `occurrence` de `hebra_note_outline`, `null` con `heading` `null`), para pasar los dos tal cual a `hebra_read_note` aunque el título se repita. `cutoff`: `time` (se agotó el plazo de recorrido, 2 s, o se interrumpió el hilo de la expresión regular) o `size` (la respuesta llegó a 100 000 caracteres), con `nextCursor` para seguir justo ahí; `null` si no. `skipped?: {id, fromLine}`: solo si la página se saltó una nota en la que la expresión regular se interrumpió dos veces seguidas sin avanzar (§5, «Búsqueda línea a línea»). Errores: `invalid_input` (patrón vacío, largo, con un salto de línea o con la sintaxis mal; `contextLines` o `cursor` que no valen), `pattern_too_slow` (una expresión regular que no termina ni una nota en el plazo; lleva `nextCursor`, que la reintenta una vez y, si vuelve a fallar, la salta). |
| `hebra_list_notes` | `folder?`, `subfolders?` (con `folder`, incluye su subárbol; def. `false`), `tag?`, `cursor?`, `limit` (1-100, def. 50), `fields?` (subconjunto de `title`, `folderPath`, `tags`, `excerpt`, `updatedAt`, `isConflictCopy`; `id` siempre); orden por favoritas primero y `updatedAt` descendente | `{notes: [{id, title, folderPath, tags, excerpt, updatedAt, isConflictCopy}], nextCursor}` |
| `hebra_read_note` | `id` o `title` (exactamente uno), `heading?` (título de un apartado, D11), `headingOccurrence?` (entero ≥ 1; solo con `heading`, si no `invalid_input`), `lines?: {from, to?}` (D13: enteros ≥ 1, `to` ≥ `from`; no con `heading`) | `{id, title, body, folderPath, tags, createdAt, updatedAt, isConflictCopy, conflictOf?, revision}`. `revision`: opaca, la versión leída (para `hebra_edit_note`). Con `title` ambiguo: error `ambiguous_title` con los candidatos `[{id, title, folderPath}]`, como mucho 50 y solo visibles. **Con `heading`**: `body` es SOLO el apartado (desde su línea de encabezado, incluida, hasta su final, subapartados incluidos) y se añaden `section: {heading, level, line, occurrence}` y `totalChars` (tamaño del cuerpo entero); `revision` sigue siendo la de la NOTA entera. Errores nuevos: `heading_not_found`, `ambiguous_heading` (con `candidates: [{heading, level, line, occurrence}]`, como mucho 50) y, en una nota bloqueada, `note_locked`. **Con `lines`** (D13): `body` es SOLO ese tramo, tal como está (desde el principio de la línea `from` hasta el de la siguiente a `to`, terminadores incluidos), y se añaden `lines: {from, to}` (el tramo devuelto: `to` recortado a la última línea y a 2 000 líneas por lectura; sin `to`, hasta ese tope), `totalLines` y `totalChars`; `revision` sigue siendo la de la nota entera. Líneas como en D11 (`\n` y `\r\n`; un salto final no abre una línea vacía de más), las mismas de `hebra_grep` y de `line` de `hebra_note_outline`. `from` más allá de la última línea (una nota vacía no tiene ninguna), `to` < `from` o `lines` con `heading`: `invalid_input`. Nota bloqueada: `note_locked`. |
| `hebra_note_outline` | `id` o `title` (exactamente uno, con la misma resolución y los mismos errores que `hebra_read_note`), `maxLevel?` (1-6: solo encabezados de ese nivel o menor), `limit?` (1-500, def. 200), `cursor?` | `{id, title, revision, totalChars, sections: [{heading, level, line, chars, occurrence?}], nextCursor}`. `chars`: el tamaño del apartado tal como lo devuelve `hebra_read_note` con ese `heading` (subapartados incluidos). `occurrence` solo sale en los encabezados cuyo título se repite en la nota, y es el valor para `headingOccurrence` (se cuenta sobre TODOS los encabezados, no sobre los filtrados por `maxLevel` ni sobre la página). Sin cuerpo. Errores: `not_found` (oculta, en la papelera o inexistente), `note_locked`, `invalid_input` (también un `cursor` de otra revisión: la nota cambió entre páginas). |
| `hebra_list_tags` | `limit?` (1-500; sin él, todas), `cursor?` | `{tags: [{tag, count}], nextCursor}` (anidadas como `a/b`) |
| `hebra_list_folders` | `limit?` (1-500; sin él, todas), `cursor?` | `{folders: [{id, path, count}], nextCursor}` |
| `hebra_links` | `id`, `limit?` (1-200; sin él, todo), `cursor?` | `{outgoing: [{ref, resolvedId?, title?}], backlinks: [{id, title}], nextCursor}` |
| `hebra_create_note` | `body` (Markdown; el primer H1 es el título, como en Hebra; si existe, el `title:` del frontmatter manda sobre el H1), `folder?` (ruta existente; por defecto, la raíz) | `{id, title, folderPath}` |
| `hebra_append_to_note` | `id`, `text` (≤ 20 000 caracteres), `heading?` y `headingOccurrence?` (D11: con `heading`, el texto va al FINAL de ese apartado, subapartados incluidos; sin él, al final de la nota, como siempre), `operationId?` (≤ 200; opcional, 10 oct 2026, ampliación de D2 y D11) | `{id, outcome: "saved" \| "conflict_copy", copyId?, revision?, totalChars?, appended?: {chars, tail, line, heading?}, replayed?}`. Con `saved`, prueba de lo guardado leída del cuerpo guardado: `revision` (la nueva, válida como `expectedRevision`), `totalChars` (tamaño del cuerpo guardado) y `appended`: `chars` (tamaño del texto insertado), `tail` (sus últimos 200 caracteres como quedaron en la nota), `line` (línea, 1-based, donde empieza) y `heading` (el título del apartado, solo si se pidió). Con `conflict_copy` no hay prueba: el texto fue a la copia. Con `operationId`, un reintento con la misma petición (mismo `id`, `text`, `heading` y `headingOccurrence`) devuelve lo anotado en el registro con `replayed: true` y sin volver a escribir ni esperar ronda (una copia de conflicto de la ronda, también anotada); recuperado del estado `started`, sin `appended`. Errores nuevos: `heading_not_found`, `ambiguous_heading` (con `candidates`), `operation_id_reused` (mismo `operationId` con otra petición o de otra herramienta), y los de siempre (`not_found`, `note_locked`; `invalid_input` con un `operationId` vacío o de más de 200). |
| `hebra_edit_note` | `id`, `edits: [{find, replace}]` (1-50; `find` no vacío; `find` + `replace` de todas ≤ 100 000 caracteres), `expectedRevision`, `operationId` (≤ 200) | `{id, outcome: "saved" \| "conflict_copy", revision?, totalChars?, applied?: [{chars, tail?, moved?}], copyId?, replayed?, sync, syncError?}`. Con `saved` (D11), prueba de lo guardado: `totalChars` (tamaño del cuerpo guardado) y `applied`, una entrada por sustitución en el orden de `edits`: `chars` (tamaño de su `replace`) y `tail` (sus últimos 200 caracteres leídos del cuerpo guardado); `moved: true` en lugar de `tail` si el reordenado de tareas desplazó la línea y el `replace` ya no está donde le tocaba. Un `replace` vacío da `{chars: 0, tail: ""}`. Con `conflict_copy`, sin prueba. Un reintento (`replayed`) devuelve lo que se guardó en el registro; una entrada anterior a D11 o recuperada del estado `started` no trae `applied`. Errores: `revision_conflict`, `no_match` / `ambiguous_match` / `overlapping_edits` (con `edit`: índice), `note_locked`, `operation_id_reused`, `not_found`. |
| `hebra_move_note` | `id`, `folderId` (`"root"` = raíz) | `{id, folderPath, favorite, archived, sync, syncError?}` |
| `hebra_set_favorite` | `id`, `favorite` | igual que `hebra_move_note` |
| `hebra_set_archived` | `id`, `archived` | igual que `hebra_move_note` |
| `hebra_trash_note` | `id` (nota visible, o ya en la papelera y visible allí) | `{id, trashed: true, sync, syncError?}`. Idempotente. Reversible con `hebra_restore_note` o desde Hebra. |
| `hebra_restore_note` | `id` (nota de la papelera visible, o viva y visible) | igual que `hebra_move_note`: a su carpeta si sigue viva; si no, a la raíz (como Hebra). Idempotente. |
| `hebra_list_trash` | `cursor?`, `limit` (1-100, def. 50); orden: la última en entrar primero | `{notes: [{id, title, folderPath, tags, excerpt, trashedAt, updatedAt, isConflictCopy}], nextCursor}`. `folderPath`: donde quedará al restaurarla. Sin recuento. |
| `hebra_list_files` | `folder?` (ruta, como en `hebra_list_notes`), `subfolders?` (con `folder`, incluye su subárbol; def. `false`), `name?` (subcadena del nombre, sin distinguir mayúsculas, 1–255 caracteres), `trashed?` (`true` lista los de la papelera; def. `false`, los vivos), `limit` (1-100, def. 50), `cursor?`; orden: los vivos por nombre normalizado (NFC y en minúsculas, comparado por unidades de código) y después por id; los de la papelera, el último en entrar primero y, a igual fecha, por id descendente (como el motor de Hebra y `hebra_list_trash`). La lista se recalcula en cada página: un fichero que se renombra en Hebra entre dos páginas puede salir dos veces o no salir | `{files: [{id, name, folderPath, mimeType, byteLength, updatedAt, trashedAt}], nextCursor}`. `folderPath`: donde está o, en la papelera, donde volverá al restaurarlo; `mimeType` y `byteLength`: `null` si el almacén no los sabe; `trashedAt`: `null` en los vivos. Sin recuento, sin SHA-256 y sin contenido. Errores: `invalid_input` (el `name` o el `cursor`). |
| `hebra_trash_file` | `id` (fichero suelto visible, vivo o ya en la papelera) | `{id, trashed: true, sync, syncError?}`. Idempotente: uno que ya está en la papelera se queda como está, sin escribir. Reversible con `hebra_restore_file` o desde Hebra. Errores: `not_found` (oculto, inexistente o un id que no es de un fichero suelto, todos igual). |
| `hebra_restore_file` | `id` (fichero suelto visible, de la papelera o vivo) | `{id, folderPath, sync, syncError?}`: a su carpeta si sigue viva; si no, a la raíz (como Hebra). Idempotente: uno vivo se queda como está, sin escribir. Errores: `not_found`, igual que `hebra_trash_file`. |
| `hebra_list_versions` | `id`, `limit?` (1-200, def. 50), `cursor?` | `{id, versions: [{versionId, createdAt, byteLength}], nextCursor}`, la más reciente primero, sin cuerpo ni `cause`. Un `cursor` cuya versión ya no existe: `invalid_input`. |
| `hebra_read_version` | `id`, `versionId` | `{id, versionId, createdAt, byteLength, body}`. |
| `hebra_restore_version` | `id`, `versionId`, `expectedRevision`, `operationId` (≤ 200) | igual que `hebra_edit_note`, con los mismos errores salvo los de las sustituciones, y sin `totalChars` ni `applied` (D11: la prueba de lo guardado es solo de `hebra_append_to_note` y `hebra_edit_note`). |
| `hebra_list_attachments` | `id`, `limit?` (1-200; sin él, todos), `cursor?` | `{id, attachments: [{attachmentId, name, mimeType, byteLength}], nextCursor}` en el orden del cuerpo. `attachmentId`: el SHA-256 del adjunto; `name`: el alias `\|nombre` del cuerpo o `null`; `mimeType` (orientativo) y `byteLength`: `null` si no se saben sin bajarlo. Errores: `not_found`, `note_locked`, `invalid_input` (un `cursor` cuyo adjunto ya no está). |
| `hebra_read_attachment` | `id`, `attachmentId`, `offset?` (carácter por el que empezar, def. 0), `maxChars?` (1–100 000, def. 100 000). Solo cambian el resultado en los adjuntos de texto, pero se validan siempre: fuera de rango, `invalid_input`, también con imágenes y PDF. `attachmentId` acepta mayúsculas y el prefijo `sha256:`; si no es un SHA-256 en hexadecimal, `not_found`. | Imagen, PDF: un bloque `{id, attachmentId, name, mimeType, byteLength}` y el contenido íntegro como `image` (base64 + `mimeType`) o `resource` embebido (blob base64 + URI opaca `hebra-attachment:<sha256>`). Texto, Markdown, CSV, JSON: bloque `{id, attachmentId, name, mimeType, byteLength, totalChars, truncated, nextOffset}` y el texto. Para leer el resto: `offset = nextOffset`. Errores: `invalid_input`, `not_found`, `note_locked`, `attachment_too_large` (`byteLength`, `maxBytes`), `attachment_type_not_allowed` (`mimeType?`), `attachment_unavailable`. |
| `hebra_create_folder` | `name` (1–255 caracteres tras recortar los espacios de los extremos; sin `/`, caracteres de control ni de formato invisibles, categoría Cf), `parent?` (ruta existente, como `path` de `hebra_list_folders`) **o** `parentId?` (id; `"root"` = raíz), como mucho uno; sin ninguno, la raíz | `{id, path, created, sync, syncError?}`. Idempotente: si bajo ese padre ya hay una carpeta VISIBLE con ese nombre (NFC, sin espacios en los extremos y sin distinguir mayúsculas, como compara Hebra), la devuelve con `created: false`. Errores: `not_found` (padre oculto o inexistente), `folder_unavailable` (D9: ruta privada o choque con algo no visible), `invalid_input`. |
| `hebra_rename_folder` | `folderId`, `name` (las mismas reglas) | `{id, path, renamed, sync, syncError?}`. Idempotente: el nombre que ya tiene responde `renamed: false` sin escribir. Errores: `not_found` (oculta o inexistente), `folder_name_taken` (hermana VISIBLE con ese nombre), `folder_unavailable` (D9), `invalid_input` (también la raíz). |
| `hebra_add_attachment` | `id`, `name` (1–255 caracteres tras recortar; sin `\|`, `[`, `]`, `\`, `#`, saltos de línea, caracteres de control ni de formato invisibles, Cf), `dataBase64` (base64 estándar; se ignoran espacios y saltos de línea), `mimeType?` (decide entre los tipos de texto, como en la lectura), `operationId` (≤ 200) | `{id, outcome: "saved" \| "conflict_copy", attachmentId, markdown, revision?, copyId?, replayed?, sync, syncError?}`. `attachmentId`: el SHA-256 de los bytes; `markdown`: la referencia añadida, `![[sha256:<attachmentId>\|<name>]]`. Errores: `not_found`, `note_locked`, `attachment_too_large` (`byteLength`, `maxBytes`), `attachment_type_not_allowed` (`mimeType?`), `operation_id_reused`, `invalid_input`. |
| `hebra_status` | nada | `{linked, lastSyncAt, lastSyncOutcome, pendingUpload, errorsByCode, writer: "this" \| "other_instance", revoked, capabilities}`. Sin contenido de notas. |

Anotaciones MCP (2 oct 2026, decision D8; 3 oct 2026, D9; 9 oct 2026, D10):
- Las 29 herramientas declaran `annotations` en el esquema. **Lectura** (`readOnlyHint: true`): `hebra_search`, `hebra_grep` (D13), `hebra_list_notes`, `hebra_read_note`, `hebra_note_outline`, `hebra_list_tags`, `hebra_list_folders`, `hebra_links`, `hebra_status`, `hebra_list_trash`, `hebra_list_files`, `hebra_list_versions`, `hebra_read_version`, `hebra_list_attachments`, `hebra_read_attachment`.
- **Escritura no destructiva** (`destructiveHint: false`): `hebra_move_note`, `hebra_set_favorite`, `hebra_set_archived`, `hebra_trash_note`, `hebra_restore_note` (ambas idempotentes); `hebra_trash_file` y `hebra_restore_file` (`idempotentHint: true`: repetirlas no vuelve a escribir); `hebra_edit_note` y `hebra_restore_version` (con `idempotentHint: true` por el control de concurrencia y la revocación de `operationId`); `hebra_create_folder` y `hebra_rename_folder` (`idempotentHint: true`: repetirlas no crea otra carpeta ni vuelve a escribir) y `hebra_add_attachment` (`idempotentHint: true` por su `operationId`).
- **Escritura con consecuencias** (`destructiveHint: false`, `idempotentHint: false`): `hebra_create_note` y `hebra_append_to_note` (las escrituras iniciales, no idempotentes sin `operationId`; `hebra_append_to_note` lo admite opcional desde el 10 oct 2026, así que la anotación sigue siendo la del caso sin él).
- Todas `openWorldHint: false`.

Paginación, campos y capacidades (30 sep 2026, «Recursos y escala»):
- **Paginación común** (`src/server/pagination.ts`): `hebra_search`, `hebra_grep` (D13), `hebra_list_notes`, `hebra_links`,
  `hebra_list_tags`, `hebra_list_folders`, `hebra_list_trash`, `hebra_list_files`, `hebra_list_versions`, `hebra_list_attachments` y `hebra_note_outline` (D11) aceptan `limit` y `cursor` y devuelven `nextCursor`, que es
  `null` al final. Los valores por defecto son búsqueda 20, `hebra_grep` 20, notas 50, papelera 50, ficheros sueltos 50, versiones 50, esquema de una nota 200, adjuntos todo si no hay `limit`; etiquetas, carpetas y
  enlaces, todo si no hay `limit`. El cursor es opaco y lleva un prefijo por herramienta: el de una
  no vale en otra (`invalid_input`). En las listas de notas es la clave del último resultado
  devuelto (reanuda exactamente tras él); en etiquetas y carpetas, la clave del último elemento; en versiones, el id de la última versión devuelta, y en adjuntos, su `attachmentId`. Si ese elemento ya no está, el cursor da `invalid_input`. En `hebra_note_outline` (D11) lleva la `revision` de la nota y la posición de la página siguiente: si la nota cambió entre dos páginas, `invalid_input`. En `hebra_grep` (D13) es la posición por la que seguir, `[id, línea]` (la línea de esa nota por la que empezar, o 0 si ya está entera), siempre de una nota visible ya mirada; no exige que esa nota siga ahí (sigue por las de id mayor).
  En `hebra_list_notes` se sigue aceptando el cursor sin envolver de versiones anteriores.
- **Cursor de `hebra_list_files`** (D10): lleva la clave de orden del último fichero devuelto (para
  los vivos, los primeros 200 caracteres de su nombre en NFC y en minúsculas, y su id; para la papelera, la
  fecha en que entró y su id, los dos en descendente: borrar una carpeta manda todos sus ficheros
  con la misma fecha) y la página siguiente empieza en el primero que va después de esa
  clave. No exige que ese fichero siga en la lista: listar, mandar a la papelera el último de la
  página y pedir la siguiente funciona, que es el uso previsto. Un cursor de la lista de vivos no
  vale con `trashed: true`, ni al revés (`invalid_input`).
- **Las ocultas no se notan** (§6.3): una página se rellena hasta `limit` solo con notas visibles;
  `nextCursor` existe solo si hay otra nota VISIBLE detrás (se mira una por delante), así que ni el
  tamaño de la página ni la presencia del cursor dependen de cuántas notas privadas hay ni de dónde
  están. El cursor lleva la clave de una nota ya devuelta, nunca la de una oculta. Lo mismo vale
  para los ficheros sueltos de `hebra_list_files`. En `hebra_grep` (D13) también: la página llena
  mira una coincidencia más, y solo recorre notas visibles (§6.3).
- **`hebra_links`**: `limit` vale para `outgoing` y para `backlinks` a la vez y hay UN `cursor` para las
  dos listas; `nextCursor` existe si a alguna le queda algo, y la que ya terminó sale vacía en las
  páginas siguientes.
- **Filtros comunes**: `folder` (ruta), `subfolders` y `tag` se llaman y se comportan igual en
  `hebra_search`, `hebra_grep` (D13) y `hebra_list_notes` (`subfolders` es nuevo en la búsqueda). Una carpeta o etiqueta
  privada o inexistente da lista vacía en ambas. No hubo renombrados, así que no hay alias.
- **`fields?`** (`hebra_search`, `hebra_list_notes`): cada elemento lleva `id` y solo los campos pedidos,
  en el orden de siempre; un nombre desconocido lo rechaza el esquema. Ausente, salida completa.
- **Capacidades**: el `initialize` lleva `instructions` fijas (qué hace el servidor, cómo paginar, cómo
  editar, qué no permite) y `hebra_status.capabilities` da `{server: {name, version}, tools, pagination,
  limits, notAllowed, privacyConfigured}`. `limits` recoge los máximos de `limit` por herramienta (`listNotes`, `listTags`, `listFolders`, `links`, `search`, `listTrash`, `listFiles`, `listVersions`, `listAttachments`, `noteOutline`), `grep` (D13: `default` 20, `max` 100, `contextLines` 5, `patternChars` 1 000, `lineChars` 300, `timeBudgetMs` 2 000 y `responseChars` 100 000), `readNoteLines` (2 000, D13: líneas por lectura con `lines`), los tamaños de las escrituras (también `folderNameChars` y `attachmentNameChars`, 255, y `addAttachmentBytes`, 5 MiB, D9), `attachmentBytes` (5 MiB) y `attachmentTextChars` (100 000) y `writeProofTailChars` (200, D11: los caracteres finales de la prueba de lo guardado); `notAllowed` lista lo que no hace (purgar o vaciar la
  papelera, mover o borrar carpetas, cambiar o borrar adjuntos, y purgar, crear, renombrar, mover,
  reemplazar o leer el contenido de un fichero suelto, D10);
  `privacyConfigured` es solo un booleano: ni nombres de carpetas o etiquetas privadas ni contenido.

Detalle de las escrituras (D2):
- **Escrituras que no escriben nada** (edición sin cambios, reintento con el mismo `operationId`, organización a un estado que la nota ya tiene, mandar a la papelera un fichero suelto que ya está en ella o sacar uno que ya está vivo) no piden ni esperan ronda de sync, y responden `sync` según la fila: `not_linked` sin sync; `uploaded` si la nota no está sucia; `pending` si lo está (la sube la siguiente ronda periódica). Organizar a un estado que la nota ya tiene no la marca sucia ni sube su `local_seq`, y lo mismo un fichero suelto.
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

  **Con `operationId`** (10 oct 2026, ampliación de D2 y D11 por delegación de David): la
  idempotencia de `hebra_edit_note`, en el mismo registro `hebra_mcp_operations` y en el mismo
  turno, con huella propia (`appendToNote`, `id`, `text`, `heading`, `headingOccurrence`: un
  `operationId` de una edición o de un adjunto da `operation_id_reused`, y el mismo texto en otro
  apartado es otra petición). `started` con el SHA-256 del cuerpo resultante → `noteSave` →
  `done` con la respuesta entera (prueba de lo guardado incluida). El reintento: `done`, la
  respuesta anotada con `replayed: true`, sin escribir ni pedir ronda; `started` con el cuerpo
  actual igual al resultante, se dio por guardado (se cierra el registro; `revision` y
  `totalChars` del cuerpo actual, sin `appended`); `started` con otro cuerpo, se añade (murió
  antes de guardar). Una copia de conflicto que llega con la ronda de después queda anotada
  (`recordEditConflict`), como en una edición. **Límites**: los de la edición (24 h, un registro
  por directorio de datos); además, si murió tras guardar y antes de cerrar el registro y otra
  escritura o el sync cambió la nota antes del reintento, el SHA-256 ya no casa y el texto se
  añade otra vez (la ventana es la de dos sentencias del mismo turno). Si el apagado empieza
  mientras la escritura espera su ronda, la respuesta sale sin esperarla (§12.1) y una copia de
  conflicto de esa ronda no llega a la respuesta ni al registro. Un lector de esta versión que
  reenvía a un escritor anterior (§8) no puede contar con la idempotencia: ese escritor ignora
  `operationId`; lo guarda igual y el lector lo registra (`forward.operation_id_ignored`), pero
  un reintento lo duplicaría. Sin `operationId`, todo como antes: cada llamada añade.
- **Notas por apartados** (D11, 9 oct 2026): el analizador (`src/store/sections.ts`, código propio, sin importar el de Hebra) trabaja con offsets sobre el cuerpo y nunca lo reserializa.
  - **Apartado**: una línea ATX (`^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$`, título sin los `#` de cierre) y todo hasta el siguiente encabezado de nivel igual o menor, o el final. No cuentan como encabezado las líneas del frontmatter inicial (`---` … `---` al principio) ni las de un bloque de código cercado (``` o ~~~; un cercado sin cerrar llega al final). Se peca de detectar cercados de más y nunca de menos (un encabezado real no visto da `heading_not_found`, que es seguro; uno falso escribiría donde no es): la apertura es una línea que, tras quitar del principio cualquier combinación de espacios, tabuladores, marcadores de cita `>` y marcadores de lista (`-`, `+`, `*`, `1.`, `1)`, con su espacio), empieza por tres o más acentos graves o virgulillas (un cercado de acentos graves no admite acentos graves en su información); el cierre es una línea que, tras quitar espacios, tabuladores y `>`, es solo el mismo carácter repetido al menos tantas veces como la apertura, más espacios finales, sin tope de indentación. Un `#` sin espacio es una etiqueta, no un encabezado. Los encabezados Setext **no** cuentan (límite deliberado). Terminadores `\n` y `\r\n`. Tamaños y posiciones en unidades UTF-16.
  - **Selección**: el título se compara como `normalizedHeading` de Hebra (NFKC, recortado, espacios y tabuladores colapsados, minúsculas). `headingOccurrence` es la posición 1-based entre los encabezados con el mismo título normalizado, en orden de documento y sea cual sea su nivel. Sin `headingOccurrence`: 0 coincidencias, `heading_not_found`; más de una, `ambiguous_heading` con `candidates: [{heading, level, line, occurrence}]` (como mucho 50). El `heading` de un candidato se corta a 200 caracteres (sin partir un par suplente y sin puntos suspensivos), igual que `appended.heading`, porque ambos cruzan `writer.sock`; `section.heading` de la lectura y `sections[].heading` del esquema no se cortan. `tail` no empieza a mitad de un par suplente. Con él, la n-ésima, o `heading_not_found`.
  - **Lectura** (`hebra_read_note` con `heading`, `hebra_note_outline`): sobre el cuerpo leído; una nota bloqueada da `note_locked`; una oculta, en la papelera o inexistente, `not_found`, también con `heading`. `chars` del esquema es el tamaño que devuelve la lectura de ese apartado.
  - **Escritura** (`hebra_append_to_note` con `heading`): el apartado se resuelve EN EL ESCRITOR, dentro del turno, sobre el cuerpo de ese momento y después de las comprobaciones de visibilidad y de bloqueo; `heading_not_found` y `ambiguous_heading` salen de ahí sin escribir y cruzan `writer.sock` con sus `candidates`. El texto se inserta justo antes del siguiente encabezado de nivel igual o menor (o al final): una línea en blanco exacta entre el último contenido no en blanco del apartado y el texto, y al menos una entre el texto y el encabezado siguiente; el resto del cuerpo no cambia ni un byte (los blancos de más que había al final del apartado quedan detrás del texto), y en el último apartado se conserva el final que tuviera la nota. El terminador de línea que se escribe es el de la nota. Sin `heading`, el cuerpo resultante es el de siempre (`body + "\n\n" + text`). Límite conocido: si el apartado termina dentro de un cercado sin cerrar, el texto cae dentro de ese cercado, igual que al añadir al final de la nota.
  - **Prueba de lo guardado**: tras `noteSave`, y en el mismo turno, se vuelve a leer la nota con `noteRead` y `tail`, `totalChars` y `revision` salen de esa lectura, no de la entrada. La prueba de `hebra_edit_note` ubica cada `replace` por las posiciones de `applyEdits`; si el reordenado de tareas movió líneas, si el `replace` sigue en su sitio se lee de ahí, si aparece una sola vez en el cuerpo guardado se lee de esa aparición y, si no, `{chars, moved: true}`. Los `applied` se guardan en el registro de idempotencia junto con `totalChars`; `isEditNoteSaved` sigue aceptando las entradas anteriores.
- **Búsqueda línea a línea** (`hebra_grep`, D13, 10 oct 2026; `src/server/tools/grep.ts`,
  `src/store/grep.ts`, `src/store/grep-sql.ts`, `src/store/regex-worker.ts`):
  - **Qué se mira**: las notas vivas (ni papelera ni lápida), visibles para el filtro de §6.3,
    sin bloquear (su cuerpo va cifrado) y de la carpeta y la etiqueta pedidas. Eso se decide
    con id, carpeta, etiquetas y la columna `locked`, sin leer ningún cuerpo; después solo se
    lee el cuerpo de esas, por lotes de 64, y en el MISMO turno (una transacción de lectura)
    se vuelve a comprobar cada una con su fila de ese momento: viva, sin bloquear y visible
    con el filtro rehecho (`PrivacyFilter.fromSnapshot`, como el escritor), con la carpeta
    efectiva y las etiquetas (`note_tags`) de la misma sentencia que el cuerpo. El árbol de
    carpetas se vuelve a pedir si cambió desde el lote anterior. Así, una nota que una
    ronda de sync oculta a mitad de una llamada no sale. Las copias de conflicto visibles salen, con `isConflictCopy`, como
    en `hebra_search`.
  - **Cómo casa**: el literal se escapa y se compila como la expresión regular, con la bandera
    `u` (y `i` sin distinguir mayúsculas: el plegado simple de Unicode; «canción» no casa con
    «cancion»). Línea a línea, con la convención de líneas de D11; nada casa a través de un
    salto de línea, y `^`/`$` son el principio y el final de la línea. Una entrada por línea,
    con la columna de la primera coincidencia.
  - **Orden y cursor**: por id de nota (comparado por unidades de código) y por línea; el
    cursor (`g1`) es `[id, línea]`, la posición por la que seguir (`[id, línea, 1]` si la
    expresión regular ya se interrumpió una vez en esa nota, abajo). La página llena mira una
    coincidencia más para no dar un `nextCursor` sin nada detrás. Lo que cambie entre dos
    páginas se ve en la siguiente: una nota editada puede repetir o saltarse líneas.
  - **Topes**: `limit`; el plazo de recorrido (2 s, desde el primer cuerpo leído; la primera
    nota de cada llamada se termina siempre, así que un cursor siempre avanza, salvo con una
    expresión regular que no termina ni esa, abajo), comprobado
    entre nota y nota (con una expresión regular, también a mitad de una); y 100 000 caracteres de respuesta (la primera coincidencia sale
    siempre). Al llegar a uno de los dos últimos, lo que haya, `cutoff` y el cursor de la
    primera nota sin recorrer (o de la línea siguiente a la última devuelta).
  - **Expresiones regulares** (riesgo «una expresión que cuelga el servidor» del audit): V8
    hace retroceso, así que una expresión de aspecto inocente (`(a+)+$`) puede tardar un
    tiempo exponencial. Se recorren en un `worker_thread` con 256 MiB, por lotes de notas y
    devolviendo cada nota al terminarla; al agotarse el plazo, `Worker.terminate()` lo mata
    en seco (medido: un milisegundo con `(a+)+$` sobre 40 `a` y un `!`) y el bucle de eventos
    del servidor no se bloquea en ningún momento. Lo mismo si el hilo falla (una excepción
    de la expresión, quedarse sin memoria). En los dos casos, lo encontrado hasta ahí vale y
    la nota que estaba recorriendo queda sin terminar: (1) si la llamada ya había terminado
    alguna nota, sale lo que haya con `cutoff: "time"` y un cursor EN esa nota, marcado como
    ya interrumpido (`[id, línea, 1]`); (2) si no había terminado ninguna y el cursor de
    entrada no la marcaba, `pattern_too_slow` con `nextCursor` en el error (el mismo cursor
    marcado), para reintentarla una vez; (3) si el cursor de entrada la marcaba y vuelve a
    interrumpirse sin avanzar, se SALTA: `matches` vacío, `cutoff: "time"`, `skipped: {id,
    fromLine}` (de esa nota, desde esa línea, no se sabe si casa) y un cursor que sigue en la
    nota siguiente. Así una nota catastrófica nunca bloquea las páginas de detrás, y saltarla
    siempre se dice. Un hilo por llamada (arrancarlo, unos 12 ms) que se
    cierra al terminar, y como mucho tres vivos a la vez en todo el proceso
    (`REGEX_WORKERS_MAX`): la cuarta llamada espera un hueco, y esa espera no cuenta para su
    plazo, que empieza con el hilo ya arrancado. El hilo y el hilo principal recorren las líneas con la misma función
    (`scanBody`, que el hilo recibe como código fuente). Un literal se recorre en el hilo
    principal: es lineal.
  - **Prefiltro de subcadena** (índice `notes_trigram` de Hebra, H5, §8): si el patrón tiene un
    trozo que toda coincidencia contiene (el literal entero; en una expresión regular, el
    trozo literal más largo fuera de grupos, clases y alternancias, `requiredLiteral`) de tres
    caracteres o más, `notes_trigram MATCH 'body : "…"'` da las candidatas y solo se leen esas.
    El índice no guarda texto: se comprueba siempre sobre el cuerpo. Es un superconjunto
    exacto porque: el índice guarda el texto visible del cuerpo plegado carácter a carácter
    (sin mayúsculas ni tildes), y a las candidatas se suman siempre las notas aún en la cola
    del índice (`notes_trigram_pending`) y las que tienen algo que el índice no guarda tal cual
    (un enlace con alias, `[[id:…]]`, `sha256:…`, `hebra://…`; eso sí lee su cuerpo, solo el
    de las que se miran); con `[`, `]`, `|` o `!` en el trozo, o con un carácter fuera de los
    tramos medidos (latín, griego, cirílico, puntuación y monedas, menos 28 que sin distinguir
    mayúsculas JavaScript iguala con otro y FTS5 no; `test/store/grep.test.ts` lo vuelve a medir
    contra SQLite), no se usa el índice. Sin el índice completo (relleno a medias, o un lector
    sobre una base sin él), se recorren todas. Esas reglas de lo que el índice no guarda tal
    cual son de la versión 1 del índice (`SUBSTRING_INDEX_VERSION` de Hebra), contrastadas
    con los vectores `cases/substring-index-text.json` del submódulo: el test recorre, para cada
    uno, toda subcadena de tres caracteres o más sin `[`, `]`, `|` ni `!` que no esté en el texto
    visible y comprueba que la nota sale como candidata. El índice solo se usa si la versión
    del submódulo y la marca de la base son EXACTAMENTE 1 (`GREP_AUDITED_SUBSTRING_INDEX_VERSION`);
    con otra, recorrido completo y, una vez por proceso, el evento `grep.substring_index`
    (`unaudited_version`, con las dos versiones).
  - **Medida** (`npm run perf:grep`, `test/perf/grep-20mb.perf.ts`, fuera de `npm test`; 10 oct
    2026, este Mac, Node 24.19, SQLite 3.53): biblioteca sintética de 4 064 notas y 20 976 723
    caracteres de cuerpo hecha con el motor (una de cada veinte en una carpeta privada), la peor
    de tres llamadas a `runGrep` por consulta, en dos pasadas seguidas. Con índice: 25-69 ms
    los literales y las expresiones con trozo literal, 63-85 ms las expresiones sin trozo
    literal (recorrido completo). Sin índice: 8-73 ms y 61-118 ms. En esta biblioteca casi
    todas las notas tienen un enlace con alias o un `hebra://`, así que el prefiltro apenas
    descarta y cuesta su consulta: es el peor caso para él, y aun así todo queda muy por
    debajo del segundo de la aceptación.
- `hebra_edit_note` (D2 ampliada, 28 sep 2026):
  - **Revisión**: `r1.` + base64url de `[library_id, id, local_seq, body_sha256]` de la fila leída.
    `updatedAt` no vale (mover o archivar no lo cambia). La edición se certifica contra la base que
    trae el agente, no contra la nota actual: el SHA-256 del cuerpo de la revisión tiene que ser el
    de ahora (si no, `revision_conflict` sin escribir) y `noteSave` recibe `expectedLocalSeq` y
    `baseBodySha256` de la revisión. Una revisión de otra nota o ilegible: `invalid_input`.
  - **Sustituciones**: cada `find` se busca en el cuerpo leído (no en el resultado de las
    anteriores) y tiene que aparecer exactamente una vez, contando solapes consigo mismo. Dos no
    pueden tocar el mismo tramo. Cualquier fallo rechaza todas, sin escribir.
  - **Tareas marcadas y desmarcadas** (David, 4 oct 2026: «el orden tiene que ser el mismo venga de
    donde venga el cambio»; desmarcar incluido por decisión del coordinador, por delegación suya):
    una tarea que las sustituciones pasan de `[ ]` a `[x]` sin tocar nada más de su línea baja al
    final de su lista con sus hijas, y una que pasan de `[x]` a `[ ]` sube detrás de la última
    pendiente (al principio si todas están hechas), como en el editor de Hebra, en el MISMO
    guardado (`reorderToggledTasks` de `node.ts`, la misma lectura de bloques que el editor). Varias
    en una edición se colocan una a una, de arriba abajo. Las que no cambian de estado o se movieron
    a propósito se quedan donde estén, y también las que cambian además el texto de su línea (se
    tratan como reescritas): para moverlas, primero la casilla y luego el texto, en dos ediciones. El MCP no tiene el ajuste por dispositivo de Hebra: mueve
    siempre (el defecto de Hebra).
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
- **Carpetas** (D9, 3 oct 2026; sustituye la opción A de David del 28 sep 2026, que las dejaba
  fuera porque sus errores revelaban carpetas privadas): `hebra_create_folder` y
  `hebra_rename_folder`, sobre `folderCreate`/`folderRename` del motor, en un turno de la cola del
  escritor único (ops `createFolder`/`renameFolder` de `writer.sock`), con la configuración de
  privados de quien pide. Mover y borrar carpetas siguen fuera: no hay herramienta, ni el socket
  acepta esas acciones, y llamar a `hebra_move_folder` da el error genérico del SDK de herramienta
  inexistente. Reglas, en este orden, en la herramienta y otra vez en el escritor:
  1. Nombre: lo recortado tiene entre 1 y 255 caracteres, sin `/`, caracteres de control,
     separadores de línea ni caracteres de formato invisibles (Unicode Cf: U+200B, U+202E…, con
     los que dos nombres que se ven iguales serían distintos); si no, `invalid_input` (lo que el
     motor rechace, `invalid_name`, también).
  2. Carpeta de partida visible (el padre al crear; la propia carpeta al renombrar, nunca la raíz):
     oculta o inexistente, `not_found`, igual que hoy al mover una nota. Al renombrar, además, si
     su propia ruta es privada o queda debajo de una, `folder_unavailable`, mirado en la
     configuración y no solo en el índice de carpetas ocultas (con el índice bien, una así ya es
     oculta y sale como `not_found`).
  3. **Desde la configuración, antes de mirar el motor**: si la ruta resultante (la del padre más el
     nombre, en minúsculas y sin espacios en los extremos, como la compara el filtro) es una carpeta
     privada configurada o queda debajo de una, `folder_unavailable`; al renombrar, también si la
     carpeta tiene debajo una carpeta privada (renombrarla cambiaría la ruta por la que se oculta) o
     si alguna descendiente quedaría en una ruta privada. La respuesta es la misma exista o no la
     carpeta privada y sea cual sea la causa.
  4. Hermanas con el mismo nombre (NFC, sin espacios en los extremos y en minúsculas,
     `folderNameKey` de Hebra): al crear, una VISIBLE se devuelve con `created: false` sin escribir;
     al renombrar, una VISIBLE (que no sea ella) da `folder_name_taken`. Si solo choca con una que
     no es visible, `folder_unavailable`; un `folder_name_taken` del motor que se escape de esta
     comprobación también sale como `folder_unavailable` (cerrado ante la duda).
  5. Renombrar al nombre exacto que ya tiene no escribe (`renamed: false`).
  `privacy_config_unresolved` va antes que todo, como en las demás escrituras: si fuera al revés, una
  configuración rota delataría qué rutas tiene configuradas.
- **Privacidad de las escrituras** (decisión 4): toda escritura (crear, añadir, editar, organizar,
  papelera, restaurar una versión, crear y renombrar carpetas, añadir un adjunto y mandar a la papelera o sacar un fichero suelto) lleva la configuración de privados de quien la pide (también
  la del lector por `writer.sock`, que la exige) y el escritor la aplica dentro del turno en que
  escribe y sobre el resultado: origen visible, destino visible, cuerpo resultante sin etiquetas
  privadas ni descendientes. Lo que no, `not_found`, igual que una nota o carpeta inexistente
  (§6.3 «Escrituras»): una nota con etiqueta privada ya no se crea ni se amplía (antes,
  `hidden: true`).
- **Estado de sync** (edición, organización, papelera, restaurar una versión, carpetas, añadir un
  adjunto y ficheros sueltos): se espera la
  ronda como mucho 10 s y `sync` dice `uploaded` (ronda `ok` y fila ya limpia; en un adjunto,
  además, el blob ya subido; en un fichero suelto, su fila de `files`), `pending` (guardado; sin ronda a tiempo o aún sucio),
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
- **Ficheros sueltos** (`hebra_list_files`, `hebra_trash_file`, `hebra_restore_file`; D10, 9 oct
  2026): los recursos de la tabla `files` de Hebra, que tienen carpeta propia y no cuelgan de una
  nota (un `.base`, un PDF suelto). Leer su contenido, crearlos, renombrarlos, moverlos,
  reemplazarlos y purgarlos siguen fuera: no hay herramienta, ni el socket acepta esas acciones.
  - **Lista**: sale de un índice propio en SQL (`filesIndex` del puerto: los ficheros que no son
    lápida, con el tamaño y el tipo de su fila de `blobs` si la hay, y qué notas los enlazan), no de
    `filesPage` ni `filesFindByName` del motor, cuyo aviso de que quedan más delataría una cola de
    ficheros ocultos. Se filtra y se ordena en memoria, y se pagina con el cursor de clave de orden
    de arriba. `folder` privado o inexistente da lista vacía en los dos casos, como en
    `hebra_list_notes`.
  - **Mandar y sacar**: `fileTrash`/`fileRestore` del motor, en un turno de la cola del escritor
    único (op `organizeFile` de `writer.sock`, acciones `trashFile`/`restoreFile`), con la
    configuración de privados de quien pide y el filtro rehecho dentro del turno. Son idempotentes
    por estado y no llevan `operationId`: uno que ya está en el estado pedido se devuelve tal cual,
    sin llamar al motor (que subiría su `local_seq` y lo dejaría sucio sin nada nuevo que subir) y
    sin ronda. El motor no toca el nombre, la fecha de modificación ni la carpeta del fichero.
  - **Restaurar**: a su carpeta si sigue viva y, si se borró, a la raíz, como las notas. La ruta de
    la salida sale de un filtro recalculado después de escribir; si para entonces el fichero no
    fuera visible, `not_found` en vez de enseñar una ruta privada, y si la configuración de
    privados ya no se pudiera aplicar (la ronda de después trajo el renombrado de una carpeta
    privada), `privacy_config_unresolved` en vez de una ruta sin filtrar. En los dos casos el
    fichero ya está restaurado y la escritura ya está registrada en el log (§6.3).
  - **Sync**: la ronda de después sube la fila de `files` como cualquier otro registro del motor,
    y `hebra_status.pendingUpload` ya cuenta los ficheros sucios. No hay `expectedRevision` (un
    fichero no tiene revisión local): un cambio a la vez en otro dispositivo lo resuelve la tabla
    de conflictos del sync de Hebra.
  - Logs: `file.organize` con el id (opaco), la acción y el estado de sync, emitido en cuanto el
    escritor responde y antes de recalcular nada. Nunca el nombre.
- **Versiones anteriores** (`hebra_list_versions`, `hebra_read_version`, `hebra_restore_version`;
  decisión 6 de D2): son las instantáneas **locales** del almacén de hebra-mcp (`note_versions` de
  Hebra: el cuerpo que sustituyó un guardado o un cambio bajado por el sync, una cada 5 minutos
  como mucho); no viajan por sync, así que no son las del Mac. No se devuelve `cause`
  (en un renombrado de etiquetas en lote nombra las etiquetas y podría nombrar una privada).
  Caducidad: las 5 versiones más recientes de cada nota no caducan nunca y las demás caducan a
  los 7 días. Las caducadas se retiran así: tras guardar una instantánea, solo las de esa nota;
  las de toda la biblioteca, una vez al arrancar el escritor (`SqliteLibraryEngine.open`); los
  lectores (`openReadOnly`) no purgan. Por eso, en un servidor que lleva días arrancado, una
  versión caducada de una nota que nadie edita se sigue listando hasta el siguiente arranque.
  El motor no tiene una operación de restaurar: como «Restaurar» en Hebra
  (`LibraryEditor.svelte`), es `noteVersionSnapshot` (instantánea ya del cuerpo actual, para
  que lo que había se pueda recuperar) + `noteSave` normal. Va por la vía de `hebra_edit_note`:
  un turno de la cola en el escritor (op `restoreVersion` de `writer.sock`), la base de
  `expectedRevision`, idempotencia en el mismo registro (con huella propia: un `operationId` de
  una edición no vale para restaurar) y la copia de conflicto de la ronda anotada para el
  reintento.
- **Añadir un adjunto** (`hebra_add_attachment`; D9, 3 oct 2026). Borrar y cambiar adjuntos siguen
  fuera.
  - La herramienta valida antes de tocar el almacén: `operationId`, el nombre, el base64 (estándar y
    estricto una vez quitados espacios y saltos de línea; si no, `invalid_input`), el tamaño
    decodificado (más de 5 MiB, `attachment_too_large` con `byteLength` y `maxBytes`, sin
    decodificar si la longitud ya lo dice) y el tipo, con la MISMA detección que la lectura (firma
    de PNG, JPEG, GIF, WebP o PDF; texto plano, Markdown, CSV o JSON en UTF-8 sin NUL si
    `mimeType` o la extensión del nombre lo declaran; si no, `attachment_type_not_allowed`). La
    nota tiene que ser visible y viva (`not_found`) y no estar bloqueada (`note_locked`).
  - El escritor lo repite todo en un turno de la cola (op `addAttachment` de `writer.sock`, con
    los bytes en base64): idempotencia en `hebra_mcp_operations` como `hebra_edit_note` (huella
    propia con el SHA-256 de los bytes, el nombre y el tipo; mismo `operationId` con la misma
    petición, `replayed: true` sin volver a escribir; con otra, `operation_id_reused`), filtro de
    privados, nota bloqueada, `blobPut(bytes, {mime})` del motor (el tipo detectado, no el
    declarado) y `noteSave` de `body + "\n\n" + ![[sha256:H|nombre]]` con `expectedLocalSeq` y
    `baseBodySha256` de lo leído, como `hebra_append_to_note`. Un `redirected` o una copia de
    conflicto de la ronda dan `conflict_copy` con `copyId` (anotada en el registro, como una
    edición). El blob se guarda antes que la nota: si el proceso muere entre los dos, el blob queda
    en el almacén local sin referencia y no se sube (el motor solo sube blobs referenciados por un
    registro vivo, `syncBlobsPending`); el reintento lo reutiliza.
  - **La referencia tiene que contar como adjunto**: el escritor lo comprueba con `deriveNote`
    (lo mismo que llena `note_blob_refs`). Si el cuerpo termina dentro de un bloque de código sin
    cerrar, el texto añadido sería código (la misma semántica que `hebra_append_to_note`, que no
    lo corrige): se cierra el bloque antes (`\n` + la primera marca que lo cierre, de tres a cinco
    acentos graves o virgulillas) y se vuelve a comprobar. Si ni así cuenta (otra construcción sin cerrar, como
    un comentario HTML `<!--`, se la traga), `invalid_input` sin guardar el blob.
  - **Reintento tras una caída**: con el registro a medias (`started`), se da por guardado si el
    cuerpo actual de la nota es el que se iba a guardar o si ya contiene esa referencia (otra
    escritura o el sync pudo cambiarla después); se cierra el registro y responde `replayed: true`
    sin volver a añadirla. En `started` no consta la copia de conflicto de un `redirected` dentro
    del turno (solo pasa con una lápida). **Límite**: el registro caduca a las 24 h; pasado ese
    plazo, un reintento con el mismo `operationId` es una petición nueva y, a diferencia de una
    edición (cuya revisión ya no casaría), puede duplicar la referencia (el blob es el mismo).
  - Sube al relé en la ronda de después, como cualquier adjunto de Hebra: `planBlobUploads` y
    `uploadBlobs` de `LibrarySyncEngine` (Blob V2, `HttpBlobRelayV2` del `SyncRunner`) suben en
    paralelo con el registro de la nota los blobs referenciados, presentes y sin subir.
- **Leer adjuntos** (`hebra_list_attachments`, `hebra_read_attachment`; decisión 7 de
  D2, 30 sep 2026, cuando entraron en solo lectura):
  - **Qué es un adjunto**: lo que la nota adjunta con `![[sha256:H|nombre]]` (`note_blob_refs` de
    Hebra, en el orden del cuerpo). Así quedan también los de Obsidian: el importador de Hebra
    reescribe sus enlaces a `sha256:` (`library/import.ts`). Los recursos sueltos (`files`,
    `![[plano.pdf]]` por nombre, con carpeta propia) no son adjuntos y estas dos herramientas no
    los devuelven. Desde D10 (9 oct 2026) tienen las suyas, que los listan y los mandan a la
    papelera; su contenido sigue sin leerse.
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
  - **Lectura de adjuntos de texto por tramos** (decisión 2b, 2 oct 2026): para texto plano, Markdown, CSV y JSON, `hebra_read_attachment` acepta `offset?` (carácter por el que empezar, def. 0) y `maxChars?` (1–100 000, def. 100 000). La respuesta lleva `totalChars`, `truncated` y `nextOffset` (`null` al final). Para leer el resto, repetir con `offset = nextOffset`. Imágenes y PDF no cambian: siempre íntegros, aunque `offset` y `maxChars` se validan igual (fuera de rango, `invalid_input`).
- No se exponen `notePurge`, `trashEmpty`, `trashCounts` (contaría las privadas),
  `noteVersionsPurgeExpired`, `folderMove`, `folderTrash`, `tagRename` ni ningún `file*` del motor
  salvo los dos de D10 (`filePurge`, `fileCreate`, `fileRename`, `fileMove` y `fileReplace` siguen
  fuera, y también `filesPage` y las búsquedas de ficheros del motor): el servidor ni
  siquiera las importa en su capa de herramientas (`test/store/surface.node.test.ts`).
  `folderCreate`, `folderRename` y `blobPut` (D9) solo están en el turno de escritura del almacén
  (`NodeLibraryPort.writeExclusive`) y solo los llama `NoteWriter` (`src/store/writes.ts`); `blobPut`
  está además en la vista de sync, para que el motor guarde lo que baja. `fileTrash` y
  `fileRestore` (D10) están igual: solo en el turno de escritura y solo para `NoteWriter`. Ni el
  puerto de las herramientas ni la instancia tienen ninguno.
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
  Una ruta privada oculta **todas** las carpetas vivas que la tienen: el sync puede traer
  hermanas homónimas (dos dispositivos crean la misma carpeta a la vez; el motor solo impide
  homónimas en local), que difieran en mayúsculas, en espacios de los extremos o en la forma
  NFC/NFD de una tilde (las rutas se comparan en minúsculas, recortadas y en NFC). Hasta la
  revisión de D9 (3 oct 2026) solo se ocultaba una de ellas, y las notas de las otras se veían.
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
- **Escrituras** (crear, añadir, editar, organizar, papelera, restaurar una versión, carpetas,
  adjuntos y ficheros sueltos): no pueden
  apuntar a una carpeta privada ni a una nota oculta, ni dejar una nota en una carpeta privada o con una etiqueta privada (o
  descendiente); responden `not_found` sin escribir, igual que un destino inexistente (decisión 4 de
  David, 28 sep 2026). Se comprueba en la herramienta y otra vez en el escritor, dentro del turno en
  que escribe, con la configuración de quien pide (§5, «Detalle de las escrituras»). Una nota con
  etiqueta privada ya no se crea ni se amplía.
- **Carpetas** (D9, 3 oct 2026; sustituye la opción A, que las dejaba fuera del MCP): crear y
  renombrar solo parten de una carpeta visible (oculta o inexistente, `not_found`) y nunca dejan una
  carpeta en una ruta privada configurada ni debajo de ella, ni cambian la ruta de una carpeta
  privada (renombrar una carpeta que tiene una debajo). Todo eso, y cualquier choque de nombre con
  una carpeta que no es visible, responde `folder_unavailable`, decidido desde la configuración antes
  de mirar el motor: la misma respuesta exista o no la carpeta privada y sea cual sea la causa, así
  que no delata ni cuál es ni si está. `folder_name_taken` solo nombra hermanas visibles. Lo que sí
  dice `folder_unavailable` es que esa ruta no se puede usar, sin el motivo; es inevitable (crear la
  carpeta la dejaría oculta o revelaría la privada) y está aceptado en D9. Mover y borrar carpetas no
  están en el MCP.
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
- **Ficheros sueltos** (D10, 9 oct 2026; `src/privacy/file-filter.ts`): un fichero no tiene
  etiquetas, así que se oculta por su carpeta y por las notas que lo enlazan. La regla es la misma
  para los vivos y para los de la papelera:
  - **(a) Por carpeta**: se parte de la carpeta guardada en el fichero y se aplica la regla de la
    papelera de notas. Si esa carpeta está viva y es privada (o subcarpeta), oculto. Si ya se borró,
    se sube por las lápidas hasta una carpeta viva o la raíz: oculto si esa carpeta viva es privada
    o si alguna ruta intermedia es una ruta privada configurada, y también si falta una fila, no
    tiene nombre o hay un ciclo. Lo que queda es la carpeta donde el fichero está o quedaría al
    restaurarlo (una viva y visible, o la raíz), que es la única que se enseña.
  - **(b) Por referencia**: oculto si lo enlaza alguna nota oculta, sea una viva (el filtro de
    siempre) o una de la papelera que su filtro no deja ver. «Enlaza» es una de estas tres cosas,
    todas de lo que guarda el motor de Hebra: un enlace de `links` con el nombre del fichero
    (`![[plano.pdf]]`, así se incrustan los dibujos); un enlace de `links` con el SHA-256 de sus
    bytes (`![[sha256:…]]`, así adjuntan las notas importadas un fichero que también es un
    recurso suelto); o una fila de `note_blob_refs` con ese SHA-256. La tercera hace falta por las
    notas **bloqueadas**: de ellas el motor no deriva enlaces (saldrían del texto cifrado) y
    `links` queda vacía, pero sus adjuntos van en claro en la cabecera y constan en
    `note_blob_refs`; sin ella, el adjunto de una nota bloqueada y oculta no ocultaba el fichero
    suelto con esos mismos bytes (revisión de D10, 9 oct 2026). No mira la ruta del enlace, así
    que oculta de más con homónimos: coste asumido en D10.
  - **Sin delatar nada**: `hebra_list_files` no da recuento, rellena la página solo con ficheros
    visibles y su `nextCursor` solo existe si detrás queda otro visible; el cursor lleva la clave
    de un fichero ya devuelto. `hebra_list_folders.count` sigue contando solo notas. Un fichero
    oculto, uno inexistente, una lápida, el id de una nota y un SHA-256 responden el mismo
    `not_found` en `hebra_trash_file` y `hebra_restore_file`, y el filtro se construye siempre,
    con las mismas consultas haya o no acierto. La salida nunca lleva el SHA-256 ni la carpeta
    guardada. Lo único que sí refleja lo oculto es `hebra_status.pendingUpload`, que cuenta las
    filas sucias de toda la biblioteca, también las de ficheros sueltos y también las ocultas
    (ya pasaba con las notas): es un número, sin nombres ni ids.
  - Se comprueba en la herramienta y otra vez en el escritor, dentro del turno en que escribe.
    Restaurar deja el fichero en su carpeta si sigue viva o en la raíz: con la regla (a), lo que
    se ve nunca acaba en una carpeta privada.
  - **La carrera de después de restaurar**: `hebra_restore_file` recalcula el filtro después de
    escribir para dar la ruta, y entre medias la ronda de sync puede haber traído un cambio de
    otro dispositivo. Si entonces el fichero ya no es visible, responde `not_found`; si la
    configuración de privados ya no se puede aplicar, `privacy_config_unresolved`. Es la opción
    cerrada: la respuesta es solo el código, sin ruta. La escritura no se deshace: el fichero
    quedó restaurado y el log `file.organize` ya salió, porque se emite en cuanto el escritor
    responde y no al final de la herramienta. Lo escrito consta siempre, aunque la respuesta sea
    un error.
- **Adjuntos** (decisión 7 de D2, 30 sep 2026): solo los de una nota visible (viva; oculta, en la
  papelera o inexistente, `not_found`), y solo los que ESA nota adjunta: un adjunto de una nota
  oculta pedido a través de otra nota que no lo adjunta, o un `attachmentId` que no es un SHA-256,
  responde `not_found`, igual que uno inexistente. El nombre sale del cuerpo de la nota visible,
  nunca de un recurso (`files`) que podría estar en una carpeta privada (los ficheros sueltos
  solo salen por sus herramientas, con la regla de arriba). Lo comprueba la
  herramienta y, si hay que bajar los bytes, otra vez el escritor dentro del turno, con la
  configuración de quien pide. Los bytes de una LECTURA nunca viajan por `writer.sock` y nunca
  salen rutas locales ni URLs. Añadir un adjunto (D9) solo vale sobre una nota visible, viva y no
  bloqueada, con la misma comprobación en el escritor; ahí los bytes sí viajan por el socket, del
  lector al escritor (nunca de vuelta), porque solo el escritor escribe.
- **Versiones** (decisión 6 de D2): solo de una nota visible (viva; oculta, en la papelera o
  inexistente, `not_found`). Una versión cuyo cuerpo lleva una etiqueta privada (o descendiente),
  con las etiquetas de `deriveNote` (las que Hebra guardaría al restaurarla), no se lista, no se
  lee y no se restaura: `not_found`, igual que una versión que no existe o que es de otra nota.
  La lista no dice cuántas se saltó ni devuelve `cause`. Restaurar lo vuelve a comprobar el
  escritor dentro del turno, sobre el cuerpo resultante, como cualquier edición.
- **`hebra_grep` y la lectura por líneas** (D13, 10 oct 2026; ninguna regla nueva de qué se
  oculta): una nota de carpeta privada o subcarpeta, con etiqueta privada o descendiente, en la
  papelera o bloqueada (esta, porque su cuerpo va cifrado), y la copia de conflicto de una
  oculta (hereda su carpeta), no se mira. Lo decide la herramienta ANTES de leer ningún
  cuerpo, con ids, carpetas, etiquetas y la columna `locked`, y otra vez en el turno en que
  lee cada lote, con el filtro rehecho sobre las filas de ese momento (§5, «Qué se mira»):
  una nota que pasa a oculta a mitad de la llamada tampoco sale. De una oculta nunca se
  devuelve nada del cuerpo (`test/tools/grep.test.ts` lo comprueba sobre las lecturas del almacén). Qué
  NO revela, porque la respuesta solo depende de las notas visibles: ningún recuento (ni de
  coincidencias, ni de notas con coincidencias, ni de notas recorridas), ni si «hay más»
  (`nextCursor` solo existe si queda otra coincidencia visible o si hubo un corte), ni dónde
  se corta: el plazo cuenta desde el primer cuerpo leído y solo recorre notas visibles, y el
  tamaño solo suma coincidencias visibles. El cursor lleva el id de una nota visible ya
  mirada. Lo único que toca todas las notas es la consulta del índice de subcadena
  (`notes_trigram`, como la de `hebra_search`), que devuelve solo `rowid` y no cuenta para el
  plazo. Una carpeta o etiqueta privadas en `folder`/`tag` dan lista vacía, como una
  inexistente. Lo comprueba el test comparando, página a página y también con cortes por
  tiempo, la respuesta de una biblioteca con siete notas ocultas (una de cada caso) llenas del
  término buscado con la de la misma biblioteca sin ellas: idénticas, cursores incluidos.
  `hebra_read_note` con `lines`, como sin él: una oculta, `not_found`; una bloqueada,
  `note_locked`.
- **Cerrado ante la duda**: si una carpeta de `privateFolders` no existe (renombrada o borrada), el
  servidor responde a toda herramienta con `privacy_config_unresolved` hasta que se corrija la
  configuración. No se sirve nada con un filtro que no se puede aplicar.

### 6.4 Logs

- **Qué se registra**: solo eventos cerrados en stderr, como en §11 de la spec de Hebra
  (`sync.round`, `sync.lease_lost`, `sync.record_error`, `sync.conflict_copy` y, desde el
  submódulo en `59b5d403`, `sync.blob_unreadable`, que solo lleva el tamaño del adjunto, y,
  desde `aea2181c`, `substring.index`, el relleno del índice de subcadena, §8), con ids opacos, códigos y recuentos.
- **Qué nunca se registra**: títulos, cuerpos, consultas de búsqueda ni argumentos de herramientas. Tampoco el título de un apartado (D11) ni el texto de la prueba de lo guardado; como mucho, `heading: true` en `note.append`. Ni el patrón de `hebra_grep` (D13): su `tool.call` lleva solo `count`, el número de coincidencias devueltas.
- Stdout es exclusivo del protocolo MCP.
- **Test**: un test ejecuta todas las herramientas con notas-cebo y comprueba que ningún texto de
  las notas aparece en stderr.

### 6.5 Contenido de notas como entrada a la IA

El texto de una nota puede contener instrucciones dirigidas al modelo. El daño posible está acotado
por D2 (ampliada el 28 y el 30 sep 2026): sin borrar, purgar ni vaciar la papelera, y sin poder
llevar nada a una carpeta o etiqueta privada, lo peor que puede hacer una instrucción inyectada es
crear notas, añadir texto, sustituir fragmentos de una nota visible o restaurarle una versión
anterior, mover (a carpetas que ya existen), archivar y marcar notas visibles, **mandar notas
visibles a la papelera** (o sacar de ella notas visibles), crear y renombrar carpetas visibles,
añadir adjuntos a notas visibles (D9) y **mandar ficheros sueltos visibles a la papelera** (o
sacarlos de ella, D10). Las carpetas no se mueven ni se borran, ningún adjunto se
cambia ni se borra, y de un fichero suelto no se lee el contenido ni se crea, renombra, mueve,
reemplaza o purga ninguno. Todo queda
visible en Hebra y es revertible, allí y desde el MCP: una nota mandada a la papelera se saca con
`hebra_restore_note` o desde Hebra (nada la purga), un fichero suelto se saca con
`hebra_restore_file` o desde Hebra, y las «Versiones anteriores» guardan el cuerpo
previo a una edición o a una restauración (en Hebra, las del dispositivo; en el MCP, las suyas);
una edición concurrente produce una copia de conflicto. Una carpeta renombrada se renombra de
vuelta, y una carpeta o un adjunto de más se quitan desde Hebra. Leer adjuntos (decisión 7) no
amplía ese daño, pero su contenido es entrada a la IA igual que el cuerpo: un
texto, un PDF o una imagen adjuntos pueden llevar instrucciones, y se tratan como datos.
`hebra_grep` y la lectura por líneas (D13) solo leen: devuelven trozos del mismo cuerpo, que son
entrada a la IA igual que la nota entera, y no amplían ese daño. Una expresión regular que una
instrucción inyectada pida para colgar el servidor la corta el plazo (§5, «Búsqueda línea a
línea»).

Los ficheros sueltos tienen un efecto que las notas no: los **dibujos** son ficheros sueltos que
las notas incrustan por nombre (`![[Dibujo 2026-10-09 10.30.png]]`), y cualquier otro fichero suelto
se puede incrustar igual. Mandar a la papelera uno que una nota visible incrusta rompe ese
incrustado mientras siga allí: la nota deja de enseñarlo, sin que su cuerpo cambie. Entra en el
daño acotado de una instrucción inyectada y es reversible con `hebra_restore_file` o desde Hebra,
que lo deja como estaba. Lo que no es reversible es un «Vaciar papelera» que el dueño haga a mano
en Hebra después: el MCP no purga nada, pero tampoco puede impedir que se purgue lo que él mandó a
la papelera. No hay tope de llamadas ni se comprueba antes si alguna nota visible incrusta el
fichero; la descripción de `hebra_trash_file` lo avisa.

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
    `appendToNote {id, text, heading?, headingOccurrence?, operationId?, privacy}` (responde `{outcome, copyId?, revision?, totalChars?, appended?, replayed?}` con la ronda de sync ya
    esperada en el escritor, igual que `hebra_append_to_note`; D11; `operationId` desde el 10 oct 2026), `editNote {id, edits,
    expectedRevision, operationId, privacy}`, `organize {action, …, privacy}` (también
    `trashNote`/`restoreNote`; ninguna acción de purga) y `restoreVersion {id, versionId,
    expectedRevision, operationId, privacy}` (responden el resultado completo de
    `hebra_edit_note`, de la organización o de `hebra_restore_version`, con la ronda ya esperada y
    `sync`), `createFolder {parentId, name, privacy}` y `renameFolder {id, name, privacy}` (D9:
    `{id, changed}` y el estado de sync, ronda ya esperada), `addAttachment {id, name, dataBase64,
    mimeType, operationId, privacy}` (D9: el resultado de `hebra_add_attachment` con la ronda ya
    esperada; los bytes van del lector al escritor, nunca de vuelta), `organizeFile {action, id,
    privacy}` (D10: `action` es `trashFile` o `restoreFile` y ninguna otra, tampoco de purga;
    responde `{id, folderId, trashed}` y el estado de sync, ronda ya esperada; es una op propia y
    no una acción de `organize`, que solo admite acciones de nota), `fetchAttachment {noteId,
    sha256, privacy}` (baja al disco compartido los bytes de
    un adjunto de una nota visible y responde `{available}`, nunca los bytes; decisión 7 de D2) y
    `status` (el estado de sync del escritor). `privacy` es la configuración de privados del
    lector y es obligatoria en las nueve escrituras y en `fetchAttachment`: sin ella,
    `invalid_request`. Los ficheros de trabajo (D12, §13.6) añaden `replaceBody`,
    `trashConflictCopies` y `syncRound`, que ninguna herramienta MCP usa; un escritor sin
    ellas (o de una versión anterior) responde `invalid_request`.
    Errores con código cerrado, nunca con el mensaje; los rechazos de una sustitución llevan su
    índice (`edit`) y `ambiguous_heading`, sus `candidates` (D11). Los títulos de `candidates` y de `appended.heading` llegan cortados a 200 caracteres y el lector rechaza los más largos; solo `ambiguous_heading` lleva `candidates` (en cualquier otro código se descartan). Una respuesta de más de 256 KiB se descarta (la prueba de `applied` de 50 sustituciones, con el peor escape JSON, pasa de 64 KiB). Una línea de más de `MAX_MESSAGE_BYTES` se rechaza sin leerla entera: lo mayor
    entre el cuerpo máximo de §5 con el peor escape JSON (las sustituciones de `editNote` suman como
    mucho lo mismo) y el base64 de un adjunto de 5 MiB (6 990 508 caracteres, que JSON no escapa),
    más un margen de 512 KiB para el sobre, la configuración de privados y los saltos de línea de
    un base64 partido cada 76 caracteres (hasta 367 924 bytes con `\r\n` escapados); hoy manda el
    adjunto, 7 514 796 bytes (D9). El escritor vuelve a comprobar los límites de §5. Cada
    conexión tiene como mucho UNA petición en vuelo: las líneas se atienden en orden y, mientras
    hay una en curso, la conexión deja de leer, para que no acumule varios mensajes de ese tamaño.
    Una conexión sin petición en curso que pasa 30 s sin mandar nada (conectó y calla, o dejó
    una línea a medias) se cierra sin responder (B4 del audit de robustez, 10 oct 2026); el plazo
    no corre mientras el escritor atiende una petición.
  - Un lector reenvía `hebra_create_note`, `hebra_append_to_note`, `hebra_edit_note`, las tres de
    organización de notas, las dos de la papelera, `hebra_restore_version`, las dos de carpetas,
    `hebra_add_attachment` y las dos de ficheros sueltos (`hebra_trash_file`,
    `hebra_restore_file`) al escritor (las
    lecturas de la papelera, de las versiones y de los ficheros sueltos las sirve él mismo), y le pide que baje los bytes de
    un adjunto que no esté en el disco (`hebra_read_attachment`), que después lee él. El filtro de privados y los
    límites se aplican en la herramienta del lector, **antes** de reenviar y con su configuración, y el escritor vuelve a aplicar esa misma
    configuración (la recibe en `privacy`) dentro del turno en que escribe: no la conoce ni la
    supone igual.
  - Si no hay socket, nadie escucha o no responde a tiempo, el lector intenta tomar el bloqueo en ese
    momento. Si lo consigue, pasa a escritor (SQLite en lectura-escritura, sync y socket) y escribe
    él; si no, `busy_other_instance`. Si el escritor se fue (nadie escucha, o cortó tras recibir la
    petición) y el primer intento no toma el bloqueo, se intenta otra vez a los 100 ms: tras un
    SIGKILL, hasta que el padre recoge al muerto, `kill(pid, 0)` lo da por vivo (B2 del audit de
    robustez, 10 oct 2026). Con un escritor vivo que no responde a tiempo, no.
  - Si el relevo no puede abrir la SQLite en lectura-escritura (otra conexión con una transacción
    abierta más de 2 s, el `busy_timeout` de `node:sqlite`, que antes era 0), suelta el bloqueo y
    sigue de lector: un proceso que no escribe no se lo queda (M2 del audit de robustez). Lo
    vuelve a intentar la siguiente escritura o la comprobación periódica. Al arrancar, el mismo
    fallo no deja el bloqueo cogido.
  - Si la conexión se corta **después** de enviar la petición y sin respuesta, el escritor pudo
    ejecutarla antes de morir: el lector no la repite (duplicaría el texto). Intenta el relevo para
    la siguiente y responde `busy_other_instance`. Una edición se puede reintentar con el mismo
    `operationId` sin duplicar (§5), y un `hebra_append_to_note` también si lleva `operationId`
    (10 oct 2026): el registro vive en la SQLite compartida, así que lo sirve el escritor que lo
    guardó o el que tomó el relevo. La respuesta de `appendToNote` devuelve el `operationId`
    que atendió; si el lector lo mandó y no vuelve (un escritor de una versión anterior, que lo
    ignora), registra `forward.operation_id_ignored` (sin texto ni id de nota) y responde lo
    que dijo el escritor: el texto se guardó, pero ese append no es idempotente.
  - **Apagado con señal** (M1 del audit de robustez, 10 oct 2026): `serve` y `serve-http`
    tienen su apagado (cerrar el transporte, esperar la ronda en vuelo, vaciar la cola y cerrar
    la SQLite) y, al registrarlo, se lo dicen a la instancia (`deferSignalRelease`). Desde
    entonces la primera SIGINT, SIGTERM o SIGHUP no suelta el bloqueo: lo suelta
    `LibraryInstance.close()` al terminar; antes se soltaba al llegar la señal y otro proceso
    podía hacerse escritor con el viejo aún escribiendo. Lo decide ese indicador, no cuántos
    oyentes tiene la señal: un `serve` que arranca de lector y toma el relevo después tiene su
    oyente delante del del bloqueo. Una segunda señal suelta el bloqueo y termina. Sin el
    indicador (otros usos de `WriterLock`), la señal lo suelta en el acto, como siempre. `SyncRunner.stop()` para también el motor
    (`LibrarySyncEngine.stop`), que corta las subidas de adjuntos en vuelo; la bajada y la subida de
    registros terminan con su propio plazo.
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
  - Una ronda justo después de cada escritura. Excepción (§5): una escritura que no cambia nada (edición sin cambios, reintento con el mismo `operationId`, organización a un estado que la nota o el fichero suelto ya tiene) no pide ronda.
  - En reposo, cada ronda es 1 petición HTTP y 0 escrituras (A6 de Hebra).
- **Adjuntos** (decisión 7 de D2 y D9): los bytes se bajan bajo demanda, al
  pedir `hebra_read_attachment` un adjunto que no esté en el disco, por `readBlob` del motor en el
  escritor (§5). Las rondas no los bajan. Sí suben los que añade `hebra_add_attachment`: la ronda
  de después de la escritura sube los blobs referenciados, presentes y sin subir de este
  dispositivo, con el transporte de blobs del `SyncRunner`.
- **Índice de subcadena de Hebra** (`notes_trigram`, H5 del audit de buscadores de Hebra;
  submódulo desde `aea2181c`): el motor crea la tabla al abrir, pero en una biblioteca que
  ya tenía notas la deja vacía y sin la marca de completo (`docs/FACHADA-NODE.md` §3 del
  submódulo). Cada vez que una instancia pasa a escritora, lanza en segundo plano
  `NodeLibraryPort.fillSubstringIndex`: `substringIndexPage` del motor, una página de
  como mucho 250 notas y unos 2 MiB de cuerpo (se corta en la nota que llega al tope,
  `substringFillPageSize`: el motor calcula el texto visible en JS dentro de la
  transacción de la página, y 250 notas grandes serían un turno de segundos) por turno de la
  cola y cediendo el hilo entre páginas, hasta dejar la marca. Si falla (un `SQLITE_BUSY` en
  un relevo, por ejemplo), lo reintenta `checkWriter` (cada 30 s) pasada una espera de 30 s
  que se dobla en cada fallo seguido, hasta 15 min. No retrasa el arranque ni las peticiones; con el índice ya completo cuesta una
  lectura. Si el escritor se cierra o se releva a medias, el siguiente sigue donde se
  quedó (el motor guarda el último `rowid`). Un lector no lo intenta. Lo de después lo
  mantiene el motor (disparadores y la cola `notes_trigram_pending`, que vacía cada
  transacción suya). Mientras no termina, `hebra_search` busca solo por prefijo y
  `hebra_grep` recorre todas las notas, sin prefiltro (D13). Log: `substring.index` con `result` (`done`,
  `paused` o `failed`) y el número de notas indexadas, nunca texto.

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
| R11 | Añadir adjuntos (D9) obliga a que un adjunto de 5 MiB en base64 quepa en `writer.sock`, en `POST /mcp` y en el borde (Caddy): los topes pasan de unos 650 KiB a unos 7,5 MB (8 MB en el borde), y una petición autenticada puede ocupar eso en memoria. Además, un modelo difícilmente escribe megabytes de base64 en una llamada: en la práctica cabrán imágenes pequeñas. | El tope sigue siendo exacto (lo mayor entre el cuerpo de §5 y el base64 de 5 MiB, más 512 KiB para el sobre y los saltos de línea), en HTTP se comprueba la credencial antes de leer el cuerpo, y en `writer.sock` cada conexión tiene como mucho una petición en vuelo. Una vía por ruta local (solo stdio) sería otra decisión. |
| R12 | `hebra_grep` (D13): una expresión regular catastrófica cuelga el servidor, o el grep delata notas privadas por sus números o su tiempo. | La expresión corre en un hilo que se mata al agotarse el plazo (el bucle de eventos no se bloquea); solo se lee el cuerpo de las notas visibles, sin recuentos, y el plazo y el corte dependen solo de ellas (§5 y §6.3, con tests de cada caso). Lo único que toca todas las notas es la consulta del índice de subcadena, como en `hebra_search`. |
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
| **Después de v1** | Cambiar o borrar adjuntos; leer el contenido de un fichero suelto (`files`), crearlo, renombrarlo, moverlo, reemplazarlo o purgarlo; mover o borrar carpetas; más escrituras. | Fuera de v1 (leer adjuntos entró el 30 sep 2026, decisión 7 de D2; crear y renombrar carpetas y añadir adjuntos, el 3 oct 2026, D9; listar los ficheros sueltos y mandarlos a la papelera, el 9 oct 2026, D10) | Nueva decisión de David. |

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
  - Tope de cuerpo con 413: el mismo `MAX_MESSAGE_BYTES` de `writer.sock` (§8), lo mayor entre el
    cuerpo máximo de §5 con el peor escape JSON y el base64 de un adjunto de 5 MiB, más 512 KiB.
    Hasta D9 eran 664 KiB; desde D9, 7 514 796 bytes. El borde (`deploy/mcp-hebra-pro.caddy`)
    admite 8 MB, por encima: el corte exacto con 413 es el de la app, y el borde solo para lo
    desmedido.
  - `Host` y `Origin` tienen que ser el host público. Un host de loopback solo vale si la conexión
    viene de loopback (healthcheck, tests).
  - `GET /healthz`: 204 sin cuerpo ni autenticación.
  - Entorno, sin secretos: `HEBRA_MCP_HTTP_PORT` (8787), `HEBRA_MCP_HTTP_LISTEN` (`127.0.0.1`; en
    el contenedor, `0.0.0.0`) y `HEBRA_MCP_PUBLIC_URL` (`https://mcp.hebra.pro`, issuer y base del
    recurso `<origen>/mcp`).
  - Si otro proceso vivo tiene `writer.lock`, `serve-http` no arranca (`writer_lock_held`) en vez de
    servir como lector. Sigue escuchando en `writer.sock` como cualquier escritor.
  - Apagado (A1 del audit de robustez, 10 oct 2026): con SIGTERM, primero las escrituras en
    curso dejan de esperar su ronda (`beginShutdown`) y responden ya (`sync: "pending"` donde lo
    llevan; una copia de conflicto que traiga esa ronda no llega a la respuesta ni al registro de
    idempotencia, aunque queda visible en Hebra). Después deja de aceptar conexiones, espera
    hasta 12 s (por encima de los 10 s de espera de ronda, que va dentro de la petición y ya no la
    retiene) a que respondan las peticiones en curso y solo entonces corta lo que quede; después
    cierra el contexto (ronda en vuelo, cola del almacén, SQLite y bloqueo, §8). Antes
    cortaba en el acto: la escritura en cola se guardaba igual, pero su respuesta se perdía y el
    reintento de un append lo duplicaba. Log `serve_http.closed` con `drained` (si no quedó
    ninguna a medias).
  - Logs `http.request` con método, una etiqueta de ruta de un conjunto cerrado y el estado; nunca la
    ruta real, la query, las cabeceras ni el cuerpo.
  - Express entra como dependencia directa (ya lo traía el SDK, misma versión): el router OAuth del
    SDK es de Express. `check:bundle` exime `debug` y `object-inspect`, cuyas referencias al DOM no se
    ejecutan en Node.

### 12.2 Autenticación (D7, revisada el 5 oct 2026)

- Hebra MCP conserva el OAuth público del SDK: issuer `https://mcp.hebra.pro`, recurso
  `https://mcp.hebra.pro/mcp`, scope `hebra:mcp`, CIMD/DCR para Claude y Codex, PKCE S256,
  state, códigos de un uso, access de una hora y refresh rotatorio con familia de 30 días
  absolutos. Un refresh reutilizado fuera de la ventana de gracia revoca su familia.
- Claude conserva su callback exacto `https://claude.ai/api/mcp/auth_callback` y CIMD
  HTTPS en `claude.ai`. Codex admite exclusivamente el CIMD oficial
  `https://chatgpt.com/oauth/codex/client.json` y callbacks HTTP `/callback` en
  `127.0.0.1` o `localhost`, con puerto dinámico válido, sin credenciales, query ni
  fragmento. Solo se relaja el puerto, nunca se equiparan los dos hosts: CIMD conserva
  los hosts admitidos publicados y DCR los solicitados. DCR devuelve clientes fijos
  `hebra-mcp-codex-127`, `hebra-mcp-codex-localhost` o `hebra-mcp-codex-loopback`;
  no almacena registros ilimitados. Los callbacks se validan antes de que el SDK
  normalice URL o redirija errores; el canje del código exige la URI exacta autorizada,
  incluido el puerto. CIMD se descarga sin redirecciones, con timeout de 5 s, límite de
  64 KiB y caché de 5 min/16 entradas. Identificar al cliente nunca concede acceso.
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
  antes (decisión D8). El plazo de 30 s se mide también con reloj monotónico: un retroceso
  del reloj de pared no lo prolonga. Nunca se guarda un `active: false`, un desajuste ni un
  error, y una entrada caducada no se alarga si Lumbre no responde. Revocar solo esa fila Blob V2 corta
  el refresh al momento y los access en un máximo de 30 s, aunque sobreviva la credencial
  de emparejado.
- Lumbre devuelve un `accountId` opaco, nunca `users.id`. La concesión upstream no se
  acepta directamente en `/mcp`, ni el token OAuth de Hebra autentica las APIs de Lumbre.
  Access/refresh de ambos clientes quedan como hashes en `oauth-tokens.json` v2; el bearer de la
  concesión vive en el almacén de secretos existente. Los códigos pendientes y las
  concesiones sin familia se limpian o revocan al caducar/reiniciar. La marca de
  promoción se retira solo después de persistir la familia; si el proceso cae antes,
  el siguiente arranque revoca la concesión upstream. Si una familia local desaparece,
  su bearer queda guardado solo para reintentar la revocación upstream al arrancar;
  se borra del almacén de secretos después de que Lumbre confirme la revocación.
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
  pide la revocación upstream. Reutilizar un refresh fuera de su margen, podar una familia
  caducada o revocar uno de sus access también retira su bearer local y pide esa revocación.
  Revocar la concesión en Lumbre deja la introspección
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
- `stop_grace_period: 50s` (10 oct 2026; antes, los 10 s por defecto de Docker). Las esperas van
  una detrás de otra así: primero el drenado de las peticiones en curso (hasta 12 s; la espera de
  ronda de una escritura, 10 s, va DENTRO de su petición y al empezar el apagado se corta, así
  que no se suma), después la ronda en vuelo, que con el relé colgado tarda hasta unos 30 s en
  soltarse, y el vaciado de la cola: 12 + 30 más el vaciado caben en 50. Con 10 s, el SIGKILL
  cortaba respuestas de escrituras ya guardadas.
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

1. Desde claude.ai web, móvil y una sesión en la nube, las veintinueve herramientas de §5
   responden; lo creado, añadido, editado, organizado, mandado a la papelera o restaurado (notas y
   ficheros sueltos), las carpetas creadas o renombradas y los adjuntos añadidos aparecen en Hebra.
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

## 13. Ficheros de trabajo con vuelta (D12, 10 oct 2026)

Decidido por David el 10 oct 2026 (tarea D de Lumbre c4f2fd52). Parte del contrato de la sonda
de Hebra (`docs/sondas/opcion-d-contrato.md`, en `59b5d403`) y de la aceptación AC1-AC7 del audit
`docs/audits/2026-10-10-sqlite-o-markdown.md`; el código es propio (D5): nada del prototipo
`scripts/sonda-d/hebra-d.ts` se copia. Código en `src/workdir/` y `src/store/body-writes.ts`.

### 13.1 Órdenes

- `hebra-mcp checkout --dir <carpeta> <selección> [--forzar]`: ronda de sync y saca las notas como
  `.md`. Selección: `--all`, `--consulta <texto>` (búsqueda FTS), `--titulo <título exacto>` y
  `--carpeta <ruta>` (con sus subcarpetas). `--consulta` y `--titulo` se repiten y se suman; con
  `--carpeta` además, solo entra lo de esas carpetas. Un título sin nota se lista. Imprime las
  rutas (hasta 60; con más, el patrón) y cómo devolverlas. Una nota ya sacada conserva su ruta; si
  su fichero tiene una edición sin devolver no se pisa (se lista), salvo con `--forzar` o si esa
  edición ya quedó en una copia de conflicto (§13.4). Un fichero que ya está en la ruta sin ser de
  la carpeta (sin metadatos) y con otro contenido tampoco se pisa sin `--forzar`.
  - Qué sale lo decide un filtro de privados hecho DESPUÉS de leer las notas, con la fila leída
    (carpeta efectiva y etiquetas de su cuerpo): una ronda de sync que vuelve privada una nota a
    mitad del `checkout` no la deja en disco.
  - Cada `checkout` repasa lo sacado antes: una nota que ya no puede salir (privada, en la
    papelera, bloqueada, archivada o borrada) se retira (fichero, base y metadatos) si su fichero
    no está editado; si lo está, se avisa con una cifra, sin nombrarla, y no se toca.
- `hebra-mcp apply [--conflicto copia|rechazar] [--simular|--dry-run]`: devuelve las cambiadas
  (§13.4), espera una ronda e imprime el resumen y un diff compacto (líneas cambiadas recortadas
  alrededor del cambio, 6 por nota y unos 3 000 caracteres en total). `--simular` imprime lo mismo
  sin abrir la biblioteca ni escribir nada: ni lote, ni metadatos, ni nota.
- `hebra-mcp undo --lote <lote>`: deshace un lote (§13.5).
- `hebra-mcp status [--rutas]` y `hebra-mcp diff [--stat] [ficheros…]`: consulta, sin abrir la
  biblioteca. `status` da cifras de lo editado sin devolver, en conflicto, lo que falta, lo que no
  tiene seguimiento y las bases dañadas (5 rutas por lista; todas con `--rutas`) y avisa si la
  sacada tiene más de 24 h. `diff` es el unificado base → editado de las cambiadas.
- Sin `--dir`, `apply`, `undo`, `status` y `diff` buscan la carpeta subiendo desde el directorio
  actual y, si no, en un subdirectorio inmediato cuando solo uno la tiene.
- Salida: 0 todo limpio; 1 si algo no entró limpio (copia de conflicto, rechazada, no disponible,
  bloqueada, base dañada, en conflicto de antes, demasiado grande, o la ronda trajo otra versión de
  una nota devuelta); 2 error de uso o de la carpeta. stdout es de quien lanza la orden (rutas y
  títulos, como en `pair`); stderr, los eventos cerrados de §6.4, sin títulos, cuerpos ni rutas.

### 13.2 Carpeta de trabajo

```
<carpeta>/
  <carpetas de Hebra saneadas>/<título saneado> (<8 primeros del id>).md   ← el cuerpo, byte a byte
  .hebra-d/
    checkout.json            { version: 1, biblioteca, sacadaEn, notas: [{ id, ruta }] }
    notas/<id>.json          { id, ruta, rev, sha, sacadaEn, conflicto? }
    base/<id>.base           el cuerpo base
    lotes/<lote>/diario.jsonl, base/<id>.base, cambios.diff
    cerrojo                  { pid, … } mientras corre checkout, apply o undo
```

- El `.md` es la nota tal cual, sin cabecera: los metadatos van aparte.
- `sacadaEn` va por nota (cuándo se tomó su base: `checkout`, o el `apply`/`undo` que la puso al
  día); el de `checkout.json` es el más antiguo. El aviso de 24 h de `status` mira el más antiguo:
  una sacada parcial reciente no rejuvenece las demás.
- Las `ruta` de los JSON se normalizan al leerlas (`\` → `/`, NFC). Una absoluta (también `C:`),
  con `..`, dentro de `.hebra-d` o sin `.md` es «base dañada»: ni se lee ni se escribe fuera de la
  carpeta (`safeRuta`, `src/workdir/layout.ts`).
- `cerrojo`: `checkout`, `apply` y `undo` lo crean en exclusiva con su PID y lo quitan al acabar.
  Una segunda orden sobre la misma carpeta sale con 2 y lo dice; uno de un proceso muerto se
  retira. `status`, `diff` y `apply --simular` no lo toman (no escriben).
- Las bases no terminan en `.md` (un `**/*.md` no las toca) y se comprueban contra su `sha`: una
  base tocada es «base dañada» y no se devuelve (`checkout --forzar` la rehace).
- Los JSON se escriben con temporal y `rename`. La base nueva se escribe como `<id>.base.next`,
  después los metadatos y después el `rename`: un corte entre los dos últimos se completa en la
  siguiente lectura.
- `biblioteca` es el `library_id`: `apply` y `undo` se niegan con otra biblioteca.
- La correspondencia fichero → nota vive en `checkout.json`: renombrar o mover un fichero no
  cambia el título (sale del cuerpo); el renombrado sale como «falta» y el nuevo como «sin
  seguimiento», y ninguno se devuelve.

### 13.3 Nombres y plataformas

- Título más los 8 primeros del id; carpetas de Hebra como directorios. Todo en NFC.
- `: * ? " < > | / \` y los caracteres de control pasan a `-`; sin espacios ni puntos al final;
  sin punto al principio (un directorio oculto se lo saltan `rg` y otros); los nombres de
  dispositivo de Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, también con `¹²³`, en
  cualquier caja y con cualquier extensión) llevan `_` delante. Título recortado a 150 bytes UTF-8
  sin partir un carácter; sin título, «Sin título».
- Dos rutas que solo difieren en mayúsculas o en NFC/NFD son la misma (en macOS y Windows lo
  serían): la segunda lleva el id entero. Al leer la carpeta, se compara en NFC y, si el sistema
  de ficheros no distingue mayúsculas (se mira en la propia carpeta), también sin ellas.
- Las rutas de `checkout.json` van con `/`; una ruta con `\` de Windows se lee igual.
- El diff es propio (`src/workdir/diff.ts`), no el `diff` del sistema: líneas comparadas byte a
  byte (un `\r` cuenta) y un tope de memoria (con más de 4 000 pasos de Myers sin terminar, el
  tramo central sale entero como quitado y añadido).

### 13.4 `apply`

Abre un lote y, por cada nota cuyo fichero difiere de su base (sin conflicto anterior), en orden
de ruta: anota «intento» en el diario (con los SHA de la base y del editado), guarda la base en el
lote y pide al escritor `replaceBody`, que en UN turno de la cola (`src/store/body-writes.ts`):

1. Aplica el filtro de privados (D3). Una nota borrada, en la papelera u oculta, o un cuerpo que la
   dejaría con una etiqueta privada: «no disponible», sin escribir y sin decir cuál de las cuatro.
2. Nota bloqueada (o cuerpo que lo parece): «bloqueada», sin escribir.
3. **«Ya estaba»**: si el cuerpo actual ya es el editado, no escribe. Es lo que hace repetible un
   `apply` cortado (§13.8).
4. Si el cuerpo actual es la base: instantánea forzada (`noteVersionSnapshot`) y `noteSave`.
5. Si cambió por debajo: con `copia` (por defecto), busca una copia de conflicto viva de esa nota
   con el mismo cuerpo editado y, si no la hay, `noteSave` con el SHA de la base vieja y un
   `expectedLocalSeq` de -1: el motor deja el texto en una copia visible (`conflictOf`) y no toca
   el original. El `local_seq` de la sacada no viaja: el motor escribe in situ si coincide aunque
   el cuerpo sea otro, y uno que coincidiera por casualidad (carpeta copiada de otra máquina,
   biblioteca re-emparejada) pisaría la edición ajena. Con `rechazar`, no escribe.
   En los dos casos la nota queda «en conflicto» y no se vuelve a devolver hasta otro `checkout`.

Después pone al día los metadatos, anota «hecho» con el resultado y añade su diff a
`cambios.diff`. Cada nota entra entera o no entra (una transacción del motor); el lote no es
atómico y repetir `apply` completa lo pendiente. Cada escritura pide su ronda sin esperarla (el
runner las encadena, §8); al final se espera una (`syncRound`) y se relee: si la ronda trajo otra
versión de una nota recién devuelta (otro dispositivo la editó a la vez), lo dice; el motor ya la
resolvió con una copia de conflicto. Si esa versión llega en una ronda ANTES de escribir la nota,
sale como copia de conflicto en el paso 5.

**Excepción a D2.** Es la única vía de hebra-mcp que reescribe el cuerpo entero, y solo existe
aquí, en local. El motivo de D2 (que nadie machaque a ciegas lo que no vio) lo cubren la
comprobación de base del motor, la instantánea forzada y la base guardada por lote.

### 13.5 `undo`, `status` y `diff`

`undo --lote` recorre el diario. Por cada nota que el lote escribió, o pudo escribir (un
«intento» sin «hecho», de un corte): si su cuerpo actual es el editado, vuelve a escribir la base
(instantánea forzada antes); si ya es la base, nada; si cambió después, no la toca y la lista. Una
copia de conflicto del lote va a la papelera (reversible) si sigue igual. En un lote cortado (sin
«hecho») decide la biblioteca, no las copias: si el original es el editado, se restaura; si no,
solo va a la papelera una copia de esa nota con ese cuerpo creada después del «intento» y que
ningún otro lote anotó como suya. Una copia oculta por los privados no se toca ni se cuenta, esté
o no en la papelera. La carpeta de trabajo
vuelve a la base si el fichero seguía como lo dejó el lote; si tenía otra edición, no se pisa y
queda «en conflicto». Repetir `undo` no hace nada.

### 13.6 Escritor único y sync

El CLI abre la biblioteca como `serve` (`openServeContext`: mismo directorio de datos, mismos
secretos de `pair`, mismo `config.json` de privados, mismo `writer.lock`), así que es el MISMO
dispositivo, no otro:

- **Si nadie tiene `writer.lock`**, el CLI es el escritor mientras dura la orden: escribe en la
  SQLite, sincroniza y atiende en `writer.sock` lo que le reenvíen otras sesiones; al cerrar,
  suelta el bloqueo.
- **Si otro proceso lo tiene** (un `serve` por stdio, `serve-http`), el CLI es lector: lee de la
  réplica en solo lectura y reenvía por `writer.sock` tres ops nuevas: `replaceBody` (el turno de
  §13.4, sin esperar la ronda; `{id, body, baseBodySha256, onConflict, privacy}`),
  `trashConflictCopies` (solo copias de esa nota con ese cuerpo; `copyId?`, `notBefore?` y
  `exclude?` para el lote cortado) y
  `syncRound` (pide una ronda y la espera hasta `AWAIT_ROUND_TIMEOUT_MS`). El escritor aplica la
  configuración de privados que recibe, como en las demás. Si el escritor no responde, el relevo
  de §8 (`routeWrite`). Un escritor de una versión anterior responde `invalid_request`: `apply`
  lo dice, se corta y no escribe.
- Por qué reenviar y no negarse: con Claude Code abierto casi siempre hay un `serve` vivo con el
  bloqueo, y negarse dejaría la orden inservible justo cuando se usa.
- Ronda de sync antes de `checkout` y después de `apply` y `undo`, en el escritor que sea. Si no
  responde a tiempo, la orden sigue: lo escrito ya está en la SQLite. Si el escritor es otro
  proceso, lo subirá su ronda; si era la propia orden, al salir no queda nadie sincronizando, y lo
  pendiente sube la próxima vez que un proceso de hebra-mcp abra la biblioteca (la salida lo dice
  así). Un escritor de una versión anterior que no conoce `syncRound` se dice como tal.

### 13.7 Límites

- **D no crea ni borra notas desde ficheros**: un `.md` nuevo sale «sin seguimiento» y uno borrado
  o renombrado, «falta»; ninguno se devuelve. Por eso no sirve como biblioteca de ficheros
  permanente: es una copia de trabajo que vuelve a Hebra y se tira.
- Sin adjuntos ni ficheros sueltos (`.base`, PDF, dibujos): solo cuerpos de nota. Un `![[…]]`
  editado viaja como texto.
- No salen: notas bloqueadas, papelera, copias de conflicto, archivadas y privadas (D3). Las
  ocultas del listado general sí salen con `--all` (es una preferencia de vista, no de
  privacidad).
- Un cuerpo de más de 1 000 000 de unidades UTF-16 no se devuelve (cabe en una línea del socket).
- Copia en claro de lo sacado en el disco del agente, como cualquier fichero suyo.
- Rutas largas de Windows (260 caracteres) sin tratar; tampoco se ha corrido en Windows.
- Sin vigilancia de cambios: lo editado y olvidado lo cuenta `status` (con el aviso de 24 h).

### 13.8 Pruebas

En `test/workdir/`, sobre bibliotecas temporales, nunca la de David:

- `checkout-apply.node.test.ts`: AC1 (selecciones; fuera bloqueadas, papelera, archivadas, copias
  y privadas; nada privado en disco ni en stderr), AC2 y AC3 (`status`, `diff`, `--simular` sin
  escribir), AC4 (copia y rechazo, sin reenviar en cadena), AC6 (`undo`), base dañada, fichero
  renombrado, nombres de Windows, NFC, otra biblioteca, bloqueada y etiqueta privada.
- `apply-corte.node.test.ts`: AC5, la H1 de la sonda con un proceso hijo real y `kill -9` dentro de
  una nota. Sabotaje: `HEBRA_MCP_TEST_SABOTAJE=sin-ya-estaba` se salta el paso «ya estaba» en el
  `apply` repetido y el test sale rojo (una copia de conflicto duplicada).
- `otro-escritor.node.test.ts`: otro escritor vivo con sync sobre el relé en memoria y una «app»
  como la monta Hebra: reenvío, ronda que trae otra versión y escritor antiguo.
- Sin verificar aquí: la ronda real con la app de Hebra (segunda mitad de AC4 contra el relé de
  producción) y AC7 (coste), que midió la sonda.
