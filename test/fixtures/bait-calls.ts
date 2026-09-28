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
    { name: 'hebra_set_archived', arguments: { id: library.privateFolderNoteId, archived: true } }
  ];
}
