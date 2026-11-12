# Errores: tabla completa

Todos los códigos que puede devolver una herramienta, con qué significan y qué hacer. Un error
llega como `{error: "<código>", ...}` con los datos extra que se indican. Salvo que la fila
diga otra cosa, un error de escritura no ha escrito nada.

## Acceso, espacios y servidor

| Código | Qué significa | Qué hacer |
|---|---|---|
| `space_access_denied` | `space` no es `personal` ni un UUID válido y autorizado para esta cuenta (inexistente, sin membresía, sin concesión o sin permiso del agente: la respuesta no los distingue), el espacio está apagado o revocado, la credencial está revocada, o se intentó abrir la base de un espacio con los ficheros de trabajo. | No pruebes variantes ni otros IDs ni busques el mismo título en otras bibliotecas. Di que ese espacio no está disponible; `hebra_list_spaces` da los autorizados, y sin `space` se trabaja en la biblioteca personal. |
| `space_unavailable` | El relé de Lumbre no atiende ahora por falta de cupo (429) al consultar el catálogo de espacios o registrar la clave del agente. Trae `reason: "rate_limited"` y `retryAfterSeconds` (el que diga Lumbre, o 5). Puede salir en `hebra_list_spaces` y en cualquier herramienta llamada con un `space`. No es una denegación. | Espera esos segundos y reintenta una vez la misma llamada. Si sigue, díselo al usuario con la espera. No cambies de espacio ni lo des por perdido. |
| `space_not_ready` | Escritura en un espacio cuya copia en este servidor aún no tiene un vínculo válido con el relé. Solo en escrituras sobre un espacio; leer puede funcionar. | Reintenta una vez un poco más tarde; si persiste, díselo al usuario. No escribas lo mismo en la biblioteca personal para suplirlo. |
| `client_outdated` | Escritura en un espacio cuya copia está en solo lectura para este servidor: el espacio ya usa un formato de registro posterior al que entiende esta versión de hebra-mcp (u otra causa que deja la copia en solo lectura). Leer sigue funcionando. | No reintentes ni busques otra vía. Díselo al usuario: hace falta actualizar hebra-mcp (el conector remoto, el administrador del servidor). Ofrece el texto para que lo escriba él en Hebra. |
| `space_not_supported` | Se pidió un espacio compartido a una herramienta `hebra_jd_*`. | Esas operaciones solo van en la biblioteca personal (sin `space`). |
| `organizations_unavailable` | `hebra_list_organizations` no puede leer el directorio; `reason` dice por qué: `not_available`, `rate_limited` (con `retryAfterSeconds` si se conoce), `relay_unavailable`, `invalid_response` o `credential_revoked`. | Dilo tal cual. Los espacios con concesión de `hebra_list_spaces` y la biblioteca personal siguen funcionando, salvo con `credential_revoked`: ahí no hay espacios hasta que la credencial vuelva a valer (mira `revokedReason` en `hebra_status` y [espacios y organizaciones](espacios-y-organizaciones.md)). |
| `history_unavailable` | El historial del espacio en el servidor no dio la versión: `hebra_restore_version` con `space` sin `source: "local"`, o `hebra_read_version` con `source: "server"`. Trae `sourceReason` (`not_found`: el servidor aún no tiene historial; `offline`, `rate_limited`, `failed`, `locked`). No se escribió nada: nunca se restaura en su lugar la versión de este dispositivo con el mismo número, que es otra. | Con `rate_limited` u `offline`, reintenta una vez más tarde con un `operationId` nuevo. Si no, lista otra vez con `hebra_list_versions`: si da `source: "local"`, elige de esa lista, enséñasela al usuario con `hebra_read_version` y restaura con `source: "local"`. |
| `privacy_config_unresolved` | Una carpeta privada de la configuración del servidor ya no existe. | Todo el MCP queda cerrado hasta que el usuario la corrija en el `config.json` del servidor. Díselo. |
| `busy_other_instance` | Otro proceso de hebra-mcp tiene el escritor y esta instancia no puede escribir. | Reintenta una vez más tarde (con el mismo `operationId` si la herramienta lo lleva); si persiste, díselo. |
| `writer_outdated` | El proceso que escribe es de una versión anterior de hebra-mcp y no admite esa operación. Sale en cinco casos: `hebra_add_attachment` con `heading` (solo con `heading`), `hebra_rename_file`, `hebra_set_hidden`, `hebra_clear_conflict`, y `hebra_move_note`, `hebra_trash_note` o `hebra_restore_note` con `expectedRevision`. No se escribió nada. | Adjunto con `heading`: añádelo sin `heading` y mueve la referencia con `hebra_edit_note` (ver "Reglas al escribir" en `SKILL.md`). Renombrar un fichero suelto: no hay alternativa segura desde aquí (renombrar sin arreglar las notas que lo incrustan las rompería); díselo y que lo renombre en Hebra. Ocultar del listado o quitar la marca de conflicto: díselo y que lo haga en Hebra. Mover, tirar o sacar con `expectedRevision`: relee la nota justo antes y, si sigue como la leíste, repite sin `expectedRevision`; si no puedes aceptar esa ventana, díselo. En todos los casos vuelve a funcionar cuando el proceso escritor antiguo se cierre o se actualice. |

## Notas, edición y apartados

| Código | Qué significa | Qué hacer |
|---|---|---|
| `not_found` | No existe, está en la papelera (fuera de las herramientas de papelera), está oculta por privacidad, la carpeta o la versión no existe, o el resultado dejaría la nota en una carpeta o con una etiqueta privada. En ficheros sueltos: no existe, no está disponible, está en la papelera o el `id` no es de un fichero suelto (el de una nota o el `attachmentId` de un adjunto no valen). | Busca de nuevo (en la papelera, con `hebra_list_trash`; un fichero, con `hebra_list_files` y `trashed`). Si sigue, díselo sin suponer cuál de las causas es. |
| `ambiguous_title` | Varias notas con ese título. Trae `candidates: [{id, title, folderPath}]`, hasta 50 visibles. | Elige por carpeta si el encargo lo deja claro; si no, enseña los candidatos y pregunta. |
| `invalid_input` | Entrada mal formada: `revision` de otra nota o ilegible, cursor ilegible, de otra herramienta o de un elemento que ya no existe, `offset`/`maxChars` fuera de rango, base64 mal formado, nombre de carpeta o de adjunto que no vale, renombrar la raíz, instancia sin escritura, `operationId` vacío o de más de 200, extensión cambiada al renombrar o duplicar un fichero, `archived: true` con `folder` o `tag`, `lines` junto con `heading`, `headingOccurrence` sin `heading`, `lines.from` más allá de la última línea. | Revisa longitudes (100 000 / 20 000 caracteres, 1-50 sustituciones, `operationId` hasta 200, nombres hasta 255) y caracteres prohibidos. |
| `revision_conflict` | La nota cambió desde que la leíste (solo cuenta el texto). | Vuelve a leerla, rehaz las sustituciones sobre el cuerpo nuevo y usa un `operationId` nuevo. |
| `no_match` | Un `find` no aparece en el cuerpo leído (`edit` = su índice, desde 0). | Cópialo exacto del cuerpo; no lo reescribas de memoria. |
| `ambiguous_match` | Un `find` aparece más de una vez (`edit` = su índice). | Amplíalo con texto vecino hasta que sea único en la nota entera. |
| `overlapping_edits` | Dos sustituciones tocan el mismo tramo (`edit` = índice). | Fúndelas en una. |
| `heading_not_found` | Ningún apartado con ese título (o esa aparición). | `hebra_note_outline` y copia el título exacto; si no está, añade al final o crea el encabezado en el texto que añades. |
| `ambiguous_heading` | Varios apartados con ese título. Trae `candidates` (`heading`, `level`, `line`, `occurrence`). Lo dan `hebra_read_note`, `hebra_append_to_note` y `hebra_add_attachment` con `heading`; `hebra_note_outline` nunca. | Elige uno y pasa su `occurrence` como `headingOccurrence`. |
| `note_locked` | La nota está bloqueada en Hebra: no se edita, y su esquema, un apartado o unas líneas suyas tampoco se leen. | No se edita desde aquí; díselo. Moverla, favorita y archivar sí funcionan (mover con `expectedRevision`, no: quítalo). |
| `operation_id_reused` | Ese `operationId` ya se usó con otra petición (u otra herramienta). | Genera un UUID nuevo. |
| `pattern_too_slow` | `hebra_grep`: la expresión regular no termina una nota dentro del tope de tiempo. (En la simulación de `hebra_replace_in_notes` no es un error: la nota sale en `skipped` con `too_slow`.) | Simplifica la expresión, o reintenta con el `nextCursor` del error: si esa nota vuelve a fallar, se salta. |

## Adjuntos y carpetas

| Código | Qué significa | Qué hacer |
|---|---|---|
| `attachment_too_large` | El adjunto pasa de 5 MiB (`byteLength`). | No se puede leer ni añadir desde aquí; díselo con el tamaño. |
| `attachment_type_not_allowed` | Tipo fuera de la lista (imágenes PNG, JPEG, GIF, WebP, PDF, texto, Markdown, CSV, JSON), decidido por el contenido. | Díselo; que lo abra o lo adjunte en Hebra. |
| `attachment_unavailable` | Los bytes no están aquí ni se pudieron bajar (sin sync, sin red, o el relé no lo tiene). | `hebra_status` para ver el sync; reintenta una vez más tarde. |
| `folder_unavailable` | Ese nombre de carpeta no se puede usar ahí, esa carpeta no se puede renombrar así, o (en `hebra_jd_move`) esa carpeta no se puede mover así o ese nombre o subcarpeta no se pueden usar en el destino, por la configuración de privacidad del dueño. | No insistas con variantes del nombre ni especules por qué: díselo y ofrece otro nombre u otra carpeta. |
| `folder_name_taken` | Al renombrar: ya hay una carpeta hermana con ese nombre. | Otro nombre, o mover las notas a la que ya existe. |

## Ficheros sueltos

| Código | Qué significa | Qué hacer |
|---|---|---|
| `file_changed` | `hebra_replace_file_text`: el fichero ya no tiene el contenido de `expectedSha256` (alguien lo cambió desde la lectura) o, al deshacer, ya no es el que dejó el reemplazo que se deshace. | Vuelve a leerlo con `hebra_read_file`, rehaz el cambio sobre el texto nuevo y repite con su `sha256` y un `operationId` nuevo. Si era deshacer, no lo fuerces: díselo, porque se perdería lo cambiado después. |
| `file_too_large` | Al leer, el fichero pasa de 5 MiB; al reemplazar o crear, el texto nuevo o el fichero que se reemplaza pasan de 1 000 000 bytes; al duplicar, el original pasa de 5 MiB (`byteLength`, `maxBytes`). | Díselo con el tamaño; que lo cambie en Hebra. |
| `file_type_not_allowed` | Al leer, un tipo fuera de la lista (decidido por el contenido); al reemplazar, un fichero que no es de texto; al crear, una extensión que no se puede crear. | Díselo; que lo abra o lo cambie en Hebra. Un `.md` se crea como nota (`hebra_create_note`). |
| `file_unavailable` | Los bytes del fichero no están aquí ni se pudieron bajar. | `hebra_status` para ver el sync; reintenta una vez más tarde. |
| `file_exists` | En la carpeta de destino ya hay un fichero suelto visible con ese nombre (sin distinguir mayúsculas); trae su `id`. Al renombrar, también si otro fichero visible de otra carpeta ya tiene el nombre nuevo y hay notas que arreglar. | Elige otro nombre o trabaja sobre ese fichero. |
| `file_name_unavailable` | Al crear: ese nombre no se puede usar (por la configuración de privacidad del dueño). Sin más detalle. | No insistas con variantes; dile al usuario que elija otro nombre o lo haga desde la app. |
| `too_many_linked_notes` | `hebra_rename_file`: más de 5000 notas incrustan ese fichero. | No se puede renombrar desde aquí; díselo al usuario. |

## Planes (sustituir en varias notas y Johnny.Decimal)

| Código | Qué significa | Qué hacer |
|---|---|---|
| `plan_not_found` | `hebra_replace_in_notes` (`preview`, `apply` o `undo`), `hebra_jd_new_id` (`apply`) o `hebra_jd_move` (`apply` o `undo`): el plan no existe, es de otra biblioteca o de la otra herramienta, o se simuló con otra configuración de privacidad (en `hebra_replace_in_notes`, solo en `preview` y `apply`; `undo` vale con la configuración de ahora). En `hebra_jd_new_id`, también un plan de más de 24 h. En `hebra_jd_move` con `undo`, también un plan sin aplicar o aplicado hace más de 7 días. | Para aplicar: simula otra vez. Para deshacer un `hebra_jd_move` pasado de plazo: díselo; se deshace moviendo a mano. |
| `plan_expired` | Pasó la hora para aplicar el plan (o para reanudar uno cortado); en `hebra_replace_in_notes`, también los 7 días para deshacerlo. En `hebra_jd_move`, también aplicar un plan ya aplicado (o ya deshecho) con otro `operationId`. | Para aplicar: simula otra vez y revisa el plan nuevo; lo que ya entró se deshace con `undo`. Para deshacer: díselo; quedan las versiones anteriores de cada nota. |
| `plan_already_applied` | `hebra_replace_in_notes`: ese plan ya se aplicó (o se está aplicando) con otro `operationId`. | Si se perdió la respuesta, repite con el `operationId` de la primera vez; si no, simula otro plan. |
| `plan_stale` | `hebra_jd_new_id` o `hebra_jd_move`: algo cambió desde la simulación (otro dispositivo creó ese número, una nota bloqueada que no se mueve...). No se escribió (o no se movió) nada, aunque `hebra_jd_move` puede dejar una carpeta creada. | Simula otra vez y revisa el plan nuevo. |
| `jdex_not_found` / `templates_not_found` | `hebra_jd_new_id`, `hebra_jd_audit` o `hebra_jd_move`: no hay JDex (`00.00`) visible, o el id indicado de JDex o de plantillas no es de una carpeta visible (el JDex tiene que ser una carpeta `00.00`). | Pregunta dónde está el JDex y pasa su id; si no lo hay, el sistema no es Johnny.Decimal. |
| `category_not_found` / `category_folder_not_found` | La categoría no existe, o no tiene carpeta (con `createFolder: false` no hace falta). | Díselo; crear categorías no se hace desde aquí. |
| `category_has_hidden` | La categoría tiene algo que el MCP no ve. | No insistas, no especules ni pruebes otros números: que cree el ID en Hebra. |
| `category_full` / `id_taken` / `invalid_title` | Sin números libres; el número ya está usado; título vacío, con `/` o que no vale como nombre de carpeta. | Díselo; con `invalid_title`, otro título. |
| `source_not_found` / `id_not_found` | `hebra_jd_move`: lo que se mueve no existe, no se ve o es una carpeta de primer nivel; el ID no está en el JDex. | Díselo; comprueba el id y el número. |
| `destination_unavailable` / `destination_taken` | `hebra_jd_move`: esa nota o ese fichero no se pueden dejar ahí con ese nombre (por la privacidad); en el destino ya hay algo con ese nombre. | Otro nombre (`as`) u otra subcarpeta, sin especular. |
| `invalid_name` / `invalid_subfolder` / `already_in_destination` / `destination_inside_source` | `hebra_jd_move`: nombre o subcarpeta que no valen; ya está ahí; el destino está dentro de la carpeta que se mueve. | Díselo y corrige la petición. |
| `invalid_pattern` / `folder_has_hidden` | Códigos del motor Johnny.Decimal que el servidor no deja llegar a una herramienta: `invalid_pattern` es de un patrón de subcarpetas que `hebra_jd_new_id` no pide, y una carpeta con algo oculto responde `folder_unavailable`. | Si alguno apareciera, díselo al usuario tal cual y no reintentes. |
