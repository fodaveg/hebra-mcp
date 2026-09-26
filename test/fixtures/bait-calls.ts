/**
 * Las llamadas del test de notas-cebo (SPEC.md §6.3, §6.4): las nueve herramientas con
 * argumentos que casarían el cebo. Las comparten el test por `InMemoryTransport`
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
    }
  ];
}
