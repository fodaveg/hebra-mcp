/**
 * Las llamadas del test de notas-cebo (SPEC.md §6.3, §6.4): todas las herramientas
 * (`./tool-names.ts`) con argumentos que casarían el cebo. Las comparten el test por `InMemoryTransport`
 * (`test/privacy-and-logs.test.ts`) y el de Streamable HTTP (`test/http/serve-http.test.ts`),
 * para que el cebo se pruebe igual por los dos transportes.
 */
import {
  ATTACHMENT_PNG,
  BAIT_ATTACHMENT,
  BAIT_FOLDER,
  BAIT_TAG,
  type TestLibrary
} from './test-library';

/** El texto que `hebra_append_to_note` añade a una nota VISIBLE en las llamadas-cebo. Desde
 *  D11 la respuesta lo devuelve como `appended.tail` (la prueba de lo guardado), así que
 *  puede salir en la salida; en los logs, nunca (SPEC.md §6.4). */
export const BAIT_APPEND_TEXT = 'CEBO_TEXTO_AÑADIDO_5d1c';

export interface BaitCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export function baitCalls(library: TestLibrary): BaitCall[] {
  return [
    { name: 'hebra_search', arguments: { query: BAIT_FOLDER } },
    { name: 'hebra_search', arguments: { query: BAIT_TAG } },
    // D13: el cebo como literal y como expresión regular, con contexto; antes de que
    // `hebra_create_note` (más abajo) cree una nota VISIBLE con el texto de los cebos.
    { name: 'hebra_grep', arguments: { pattern: BAIT_FOLDER, contextLines: 5 } },
    { name: 'hebra_grep', arguments: { pattern: `${BAIT_TAG}|${BAIT_FOLDER}`, regex: true } },
    { name: 'hebra_grep', arguments: { pattern: 'CEBO', folder: 'Diario', subfolders: true } },
    { name: 'hebra_grep', arguments: { pattern: 'CEBO', tag: 'secreto/personal' } },
    // D14: la simulación de un lote con el cebo como patrón, en la carpeta privada y en la
    // etiqueta privada: un plan vacío, sin recuentos que delaten nada; aplicar un plan que
    // no existe, `plan_not_found`. Ni el patrón ni el reemplazo llegan al log.
    { name: 'hebra_replace_in_notes', arguments: { mode: 'simulate', pattern: BAIT_FOLDER, replacement: BAIT_TAG } },
    {
      name: 'hebra_replace_in_notes',
      arguments: { mode: 'simulate', pattern: 'CEBO', replacement: 'x', folder: 'Diario', subfolders: true }
    },
    {
      name: 'hebra_replace_in_notes',
      arguments: { mode: 'simulate', pattern: `${BAIT_TAG}|${BAIT_FOLDER}`, regex: true, replacement: '$&', tag: 'secreto' }
    },
    {
      name: 'hebra_replace_in_notes',
      arguments: { mode: 'simulate', pattern: 'CEBO', replacement: 'x', ids: [library.privateFolderNoteId, library.privateTagNoteId] }
    },
    { name: 'hebra_replace_in_notes', arguments: { mode: 'apply', planId: library.privateFolderNoteId, operationId: 'bait-6' } },
    { name: 'hebra_read_note', arguments: { id: library.privateFolderNoteId, lines: { from: 1 } } },
    { name: 'hebra_list_notes', arguments: { limit: 100 } },
    { name: 'hebra_read_note', arguments: { id: library.privateFolderNoteId } },
    { name: 'hebra_read_note', arguments: { id: library.privateTagNoteId } },
    { name: 'hebra_read_note', arguments: { title: 'Nota oculta de carpeta' } },
    // Apartados (D11): las notas ocultas responden `not_found` también con `heading` y en
    // el esquema; el cebo como título de apartado no sale en ninguna salida ni log.
    { name: 'hebra_read_note', arguments: { id: library.privateFolderNoteId, heading: BAIT_FOLDER } },
    { name: 'hebra_read_note', arguments: { id: library.privateTagNoteId, heading: BAIT_TAG } },
    { name: 'hebra_note_outline', arguments: { id: library.privateFolderNoteId } },
    { name: 'hebra_note_outline', arguments: { id: library.privateTagNoteId } },
    { name: 'hebra_note_outline', arguments: { title: 'Nota oculta de carpeta' } },
    {
      name: 'hebra_append_to_note',
      arguments: { id: library.privateFolderNoteId, text: BAIT_TAG, heading: BAIT_FOLDER }
    },
    // Adjunto en un apartado (D11): sobre una nota oculta, `not_found` y el cebo como
    // título de apartado no sale en ninguna salida ni log.
    {
      name: 'hebra_add_attachment',
      arguments: {
        id: library.privateFolderNoteId,
        name: 'a.png',
        dataBase64: Buffer.from(ATTACHMENT_PNG).toString('base64'),
        heading: BAIT_FOLDER,
        operationId: 'bait-heading-1'
      }
    },
    { name: 'hebra_list_tags', arguments: {} },
    { name: 'hebra_list_folders', arguments: {} },
    { name: 'hebra_links', arguments: { id: library.publicNoteId } },
    { name: 'hebra_status', arguments: {} },
    { name: 'hebra_list_spaces', arguments: {} },
    // Las dos de escritura (L3b): el cebo va en `body`/`text`, que nunca se hace eco en el
    // log. En la salida de `hebra_append_to_note` sí: desde D11 trae el final del texto
    // guardado (`appended.tail`), que es del propio cliente; el cebo de privados no.
    { name: 'hebra_create_note', arguments: { body: `# Nota nueva\n${BAIT_FOLDER}\n${BAIT_TAG}\n` } },
    {
      name: 'hebra_append_to_note',
      arguments: { id: library.publicNoteId, text: BAIT_APPEND_TEXT }
    },
    // Edición (D2 ampliada): el cebo en `find` de una nota oculta (`not_found`) y en
    // `replace` de una pública con una revisión que no vale (`invalid_input`). Ninguna
    // salida ni ningún log hace eco de `find`/`replace`.
    {
      name: 'hebra_edit_note',
      arguments: {
        id: library.privateFolderNoteId,
        edits: [{ find: BAIT_FOLDER, replace: 'x' }],
        expectedRevision: 'r1.x',
        operationId: 'bait-1'
      }
    },
    {
      name: 'hebra_edit_note',
      arguments: {
        id: library.publicNoteId,
        edits: [{ find: 'Enlaza', replace: `${BAIT_FOLDER} ${BAIT_TAG}` }],
        expectedRevision: 'r1.x',
        operationId: 'bait-2'
      }
    },
    // Organización de notas (D2 ampliada): sobre las notas ocultas, todas `not_found`.
    { name: 'hebra_move_note', arguments: { id: library.privateFolderNoteId, folderId: 'root' } },
    { name: 'hebra_set_favorite', arguments: { id: library.privateTagNoteId, favorite: true } },
    { name: 'hebra_set_archived', arguments: { id: library.privateFolderNoteId, archived: true } },
    // Papelera y versiones (ampliación de D2, 30 sep 2026). La lista de la papelera tiene
    // cebos ocultos por carpeta, por etiqueta y por una carpeta privada ya borrada; mandar
    // o sacar notas ocultas es `not_found`; la versión con etiqueta privada de una nota
    // visible no sale por ninguna vía.
    { name: 'hebra_list_trash', arguments: { limit: 100 } },
    { name: 'hebra_trash_note', arguments: { id: library.privateTagNoteId } },
    { name: 'hebra_restore_note', arguments: { id: library.trashedPrivateFolderNoteId } },
    { name: 'hebra_restore_note', arguments: { id: library.trashedPrivateTagNoteId } },
    { name: 'hebra_restore_note', arguments: { id: library.trashedDeletedPrivateFolderNoteId } },
    { name: 'hebra_list_versions', arguments: { id: library.formerlyPrivateNoteId } },
    { name: 'hebra_list_versions', arguments: { id: library.privateTagNoteId } },
    {
      name: 'hebra_read_version',
      arguments: { id: library.formerlyPrivateNoteId, versionId: library.formerlyPrivateVersionId }
    },
    {
      name: 'hebra_restore_version',
      arguments: {
        id: library.formerlyPrivateNoteId,
        versionId: library.formerlyPrivateVersionId,
        expectedRevision: 'r1.x',
        operationId: 'bait-3'
      }
    },
    // Adjuntos en solo lectura (30 sep 2026): los de la nota privada, `not_found`; los de
    // la visible salen (su cebo `BAIT_ATTACHMENT` puede ir en la salida, nunca a stderr).
    { name: 'hebra_list_attachments', arguments: { id: library.privateAttachmentNoteId } },
    {
      name: 'hebra_read_attachment',
      arguments: { id: library.privateAttachmentNoteId, attachmentId: library.privateAttachmentSha }
    },
    {
      name: 'hebra_read_attachment',
      arguments: { id: library.attachmentsNoteId, attachmentId: library.privateAttachmentSha }
    },
    { name: 'hebra_list_attachments', arguments: { id: library.attachmentsNoteId } },
    {
      name: 'hebra_read_attachment',
      arguments: { id: library.attachmentsNoteId, attachmentId: library.attachments.text }
    },
    // Ficheros sueltos (D10, 9 oct 2026): la lista de vivos y la de la papelera tienen
    // cebos en el NOMBRE de ficheros ocultos por carpeta, por una carpeta privada ya
    // borrada y por referencia desde una nota oculta; buscarlos por el cebo o listar la
    // carpeta privada no los saca, y mandarlos a la papelera o sacarlos es `not_found`.
    { name: 'hebra_list_files', arguments: { limit: 100 } },
    { name: 'hebra_list_files', arguments: { name: BAIT_FOLDER } },
    { name: 'hebra_list_files', arguments: { name: BAIT_TAG } },
    { name: 'hebra_list_files', arguments: { folder: 'Diario/2026', subfolders: true } },
    { name: 'hebra_list_files', arguments: { trashed: true, limit: 100 } },
    { name: 'hebra_list_files', arguments: { trashed: true, name: BAIT_FOLDER } },
    { name: 'hebra_trash_file', arguments: { id: library.files.privateFolder } },
    { name: 'hebra_trash_file', arguments: { id: library.files.referencedByHash } },
    { name: 'hebra_trash_file', arguments: { id: library.files.referencedByName } },
    { name: 'hebra_trash_file', arguments: { id: library.files.referencedByLockedNote } },
    { name: 'hebra_restore_file', arguments: { id: library.files.trashedPrivateFolder } },
    { name: 'hebra_restore_file', arguments: { id: library.files.trashedDeletedPrivateFolder } },
    // D15: leer o reemplazar cualquiera de los ocultos (su contenido lleva el cebo) es
    // `not_found`; el visible `.base` se lee y su contenido sale, sin llegar al log. El
    // texto de un reemplazo nunca va al log.
    ...[
      library.files.privateFolder,
      library.files.referencedByHash,
      library.files.referencedByName,
      library.files.referencedByLockedNote,
      library.files.trashedPrivateFolder,
      library.files.trashedDeletedPrivateFolder,
      library.files.tombstone
    ].flatMap((id): BaitCall[] => [
      { name: 'hebra_read_file', arguments: { id } },
      {
        name: 'hebra_replace_file_text',
        arguments: {
          id,
          expectedSha256: library.privateAttachmentSha,
          text: `${BAIT_FOLDER} ${BAIT_TAG}`,
          operationId: `bait-file-${id}`
        }
      }
    ]),
    { name: 'hebra_read_file', arguments: { id: library.files.inventario } },
    // D17: crear en la carpeta privada (por ruta y por id) con el cebo en el nombre y en el
    // texto, y renombrar, mover o duplicar los ocultos o hacia la carpeta privada: todo
    // `not_found`, sin el cebo en la salida ni en el log (el texto nunca va al log).
    {
      name: 'hebra_create_file',
      arguments: {
        folder: 'Diario/2026',
        name: `${BAIT_FOLDER}.base`,
        text: `${BAIT_FOLDER} ${BAIT_TAG}`,
        operationId: 'bait-create-1'
      }
    },
    {
      name: 'hebra_create_file',
      arguments: {
        folderId: library.folders.diario,
        name: `${BAIT_TAG}.yaml`,
        text: BAIT_TAG,
        operationId: 'bait-create-2'
      }
    },
    ...[
      library.files.privateFolder,
      library.files.referencedByHash,
      library.files.referencedByName,
      library.files.referencedByLockedNote,
      library.files.trashedPrivateFolder,
      library.files.tombstone
    ].flatMap((id): BaitCall[] => [
      {
        name: 'hebra_rename_file',
        arguments: { id, name: `${BAIT_FOLDER}.pdf`, operationId: `bait-rename-${id}` }
      },
      { name: 'hebra_move_file', arguments: { id, operationId: `bait-move-${id}` } },
      {
        name: 'hebra_duplicate_file',
        arguments: { id, name: `${BAIT_TAG}.pdf`, folderId: 'root', operationId: `bait-dup-${id}` }
      }
    ]),
    {
      name: 'hebra_move_file',
      arguments: { id: library.files.acta, folder: 'Diario', operationId: 'bait-move-visible' }
    },
    {
      name: 'hebra_duplicate_file',
      arguments: {
        id: library.files.acta,
        name: `${BAIT_FOLDER}.pdf`,
        folderId: library.folders.diario2026,
        operationId: 'bait-dup-visible'
      }
    },
    // Johnny.Decimal (D18, 19 oct 2026): la carpeta privada como JDex o como plantillas
    // responde como una que no existe (`jdex_not_found`, `templates_not_found`), el cebo como
    // título no sale en ninguna salida ni en el log, y aplicar un plan que no existe es
    // `plan_not_found`. La auditoría con la carpeta privada como JDex, igual.
    {
      name: 'hebra_jd_new_id',
      arguments: { mode: 'simulate', category: '21', title: BAIT_FOLDER, jdexFolderId: library.folders.diario }
    },
    {
      name: 'hebra_jd_new_id',
      arguments: { mode: 'simulate', category: '21', title: BAIT_TAG, templatesFolderId: library.folders.diario2026 }
    },
    { name: 'hebra_jd_new_id', arguments: { mode: 'apply', planId: library.privateFolderNoteId, operationId: 'bait-jd-1' } },
    { name: 'hebra_jd_audit', arguments: { jdexFolderId: library.folders.diario } },
    { name: 'hebra_jd_audit', arguments: {} },
    // Mover a un ID (D19): la nota, el fichero y la carpeta ocultos responden como lo que no
    // existe, con el cebo como nombre nuevo y como subcarpeta; deshacer o aplicar un plan que
    // no existe, `plan_not_found`. Ni el cebo ni los ids llegan a la salida ni al log.
    {
      name: 'hebra_jd_move',
      arguments: { mode: 'simulate', kind: 'note', id: library.privateFolderNoteId, toId: '21.11', as: BAIT_FOLDER }
    },
    {
      name: 'hebra_jd_move',
      arguments: { mode: 'simulate', kind: 'note', id: library.privateTagNoteId, toId: '21.11', subfolder: BAIT_TAG }
    },
    { name: 'hebra_jd_move', arguments: { mode: 'simulate', kind: 'file', id: library.files.privateFolder, toId: '21.11' } },
    { name: 'hebra_jd_move', arguments: { mode: 'simulate', kind: 'folder', id: library.folders.diario2026, toId: '21.11' } },
    { name: 'hebra_jd_move', arguments: { mode: 'apply', planId: library.privateFolderNoteId, operationId: 'bait-jd-move-1' } },
    { name: 'hebra_jd_move', arguments: { mode: 'undo', planId: library.privateTagNoteId, operationId: 'bait-jd-move-2' } },
    // Carpetas y adjuntos (D9, 3 oct 2026): el cebo como nombre de una carpeta dentro de
    // la privada (`not_found`), una ruta privada (`folder_unavailable`), renombrar la
    // privada (`not_found`) o hacia una ruta privada (`folder_unavailable`); un adjunto en
    // la nota privada (`not_found`) y otro, al final, en una visible con el cebo de
    // adjuntos en el nombre (puede salir en la salida, nunca en stderr).
    { name: 'hebra_create_folder', arguments: { parent: 'Diario', name: BAIT_FOLDER } },
    { name: 'hebra_create_folder', arguments: { name: 'Diario' } },
    {
      name: 'hebra_rename_folder',
      arguments: { folderId: library.folders.diario2026, name: BAIT_FOLDER }
    },
    { name: 'hebra_rename_folder', arguments: { folderId: library.folders.historial, name: 'Diario' } },
    {
      name: 'hebra_add_attachment',
      arguments: {
        id: library.privateFolderNoteId,
        name: `${BAIT_FOLDER}.png`,
        dataBase64: Buffer.from(ATTACHMENT_PNG).toString('base64'),
        operationId: 'bait-4'
      }
    },
    {
      name: 'hebra_add_attachment',
      arguments: {
        id: library.attachmentsNoteId,
        name: `${BAIT_ATTACHMENT}.png`,
        dataBase64: Buffer.from(ATTACHMENT_PNG).toString('base64'),
        operationId: 'bait-5'
      }
    }
  ];
}
