/**
 * Las llamadas del test de notas-cebo (SPEC.md §6.3, §6.4): todas las herramientas
 * (`./tool-names.ts`) con argumentos que casarían el cebo. Las comparten el test por `InMemoryTransport`
 * (`test/privacy-and-logs.test.ts`) y el de Streamable HTTP (`test/http/serve-http.test.ts`),
 * para que el cebo se pruebe igual por los dos transportes.
 */
import { BAIT_FOLDER, BAIT_TAG, type TestLibrary } from './test-library';

export interface BaitCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export function baitCalls(library: TestLibrary): BaitCall[] {
  return [
    { name: 'hebra_search', arguments: { query: BAIT_FOLDER } },
    { name: 'hebra_search', arguments: { query: BAIT_TAG } },
    { name: 'hebra_list_notes', arguments: { limit: 100 } },
    { name: 'hebra_read_note', arguments: { id: library.privateFolderNoteId } },
    { name: 'hebra_read_note', arguments: { id: library.privateTagNoteId } },
    { name: 'hebra_read_note', arguments: { title: 'Nota oculta de carpeta' } },
    { name: 'hebra_list_tags', arguments: {} },
    { name: 'hebra_list_folders', arguments: {} },
    { name: 'hebra_links', arguments: { id: library.publicNoteId } },
    { name: 'hebra_status', arguments: {} },
    // Las dos de escritura (L3b): el cebo va en `body`/`text`, que nunca se hace eco en la
    // salida (`{id, title, folderPath}` / `{id, outcome, copyId?}`) ni en el log.
    { name: 'hebra_create_note', arguments: { body: `# Nota nueva\n${BAIT_FOLDER}\n${BAIT_TAG}\n` } },
    {
      name: 'hebra_append_to_note',
      arguments: { id: library.publicNoteId, text: `${BAIT_FOLDER} ${BAIT_TAG}` }
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
    }
  ];
}
