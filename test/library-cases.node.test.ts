import { describe, expect, it } from 'vitest';
import { parseLinkRef, SqliteLibraryEngine, type NoteSaveInput, type NotesScope, type SqliteConn } from '../src/hebra';
import { libraryCases as cases, MemoryBlobStore } from './hebra-testing';
// `node.ts`/`node-testing.ts` (L6c) no exportan estos ocho tipos: son detalles del
// dispatcher de casos compartidos (mutaciones fuera de D2 que hebra-mcp nunca expone,
// SPEC.md §5), usados aquí SOLO para castear los argumentos de cada paso. Justificado:
// entran por `$lib/library/types`, no por producción (`../src/hebra`).
import type {
  AckEntry,
  ImportBatch,
  IncomingRecord,
  NoteRewriteEntry,
  PendingMark,
  PropsQueryFilters,
  PropsQuerySort,
  TagsReindexEntry
} from '$lib/library/types';
import { openNodeSqliteConn } from '../src/store/sqlite-conn-node';

/**
 * Casos compartidos del almacén (`vendor/hebra/src/lib/library/cases/library-cases.json`,
 * ejecutados en Hebra por `library-cases.test.ts` contra sqlite-wasm y contra Rust; ver
 * SPEC.md §10 L0) corridos aquí contra el adaptador `node:sqlite` de
 * `src/store/sqlite-conn-node.ts`. Es una copia FIEL del dispatcher `run()` de
 * `library-cases.test.ts` (mismo switch, mismos nombres de operación): si diverge de él,
 * hay que releer ese fichero en el SHA fijado del submódulo, no adivinar. El JSON de
 * casos NUNCA se copia: se importa del submódulo.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Step {
  op: string;
  args?: Record<string, Json>;
  as?: string;
  expect?: Json;
  expectError?: string;
}

interface CasesFile {
  defaults: {
    folder: Record<string, Json>;
    note: Record<string, Json>;
    file: Record<string, Json>;
  };
  cases: Array<{ name: string; steps: Step[] }>;
}

const file = cases as unknown as CasesFile;

function substitute(value: Json, bound: Map<string, Json>): Json {
  if (typeof value === 'string' && value.startsWith('$') && value.includes('.')) {
    const [name, ...path] = value.slice(1).split('.');
    let current: Json = bound.get(name!) ?? null;
    for (const key of path) {
      current =
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current[key] ?? null)
          : null;
    }
    if (current === null) throw new Error(`referencia sin valor: ${value}`);
    return current;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, bound));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, bound)])
    );
  }
  return value;
}

function assertIncludes(actual: unknown, expected: Json, path: string): void {
  if (expected === null || typeof expected !== 'object') {
    expect(actual, path).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} es array`).toBe(true);
    const list = actual as unknown[];
    expect(list.length, `${path}.length`).toBe(expected.length);
    expected.forEach((entry, index) => assertIncludes(list[index], entry, `${path}[${index}]`));
    return;
  }
  expect(actual !== null && typeof actual === 'object', `${path} es objeto`).toBe(true);
  for (const [key, entry] of Object.entries(expected)) {
    assertIncludes((actual as Record<string, unknown>)[key], entry, `${path}.${key}`);
  }
}

function withDefaults(batch: ImportBatch): ImportBatch {
  return {
    folders: batch.folders?.map((entry) => ({ ...file.defaults.folder, ...entry }) as never),
    notes: batch.notes?.map((entry) => ({ ...file.defaults.note, ...entry }) as never),
    files: batch.files?.map((entry) => ({ ...file.defaults.file, ...entry }) as never)
  };
}

async function run(engine: SqliteLibraryEngine, conn: SqliteConn, step: Step): Promise<unknown> {
  const args = (step.args ?? {}) as Record<string, never>;
  switch (step.op) {
    case 'clock':
      engine.setClockForTests(args.now);
      return null;
    case 'libraryOpen':
      return engine.libraryOpen();
    case 'noteCreate':
      return engine.noteCreate(args.folderId ?? null);
    case 'noteRead':
      return engine.noteRead(args.id);
    case 'noteSave':
      return engine.noteSave(args.input as NoteSaveInput);
    case 'notesPage':
      return engine.notesPage(
        args.cursor ?? null,
        args.limit,
        (args.scope ?? undefined) as NotesScope | undefined
      );
    case 'foldersList':
      return engine.foldersList();
    case 'tagsList':
      return engine.tagsList();
    case 'noteMove':
      return engine.noteMove(args.id, args.folderId);
    case 'noteSetFavorite':
      return engine.noteSetFavorite(args.id, args.favorite);
    case 'noteTrash':
      return engine.noteTrash(args.id);
    case 'noteRestore':
      return engine.noteRestore(args.id);
    case 'noteClearConflict':
      return engine.noteClearConflict(args.id);
    case 'notePurge':
      return engine.notePurge(args.id);
    case 'folderCreate':
      return engine.folderCreate(args.parentId ?? null, args.name);
    case 'folderRename':
      return engine.folderRename(args.id, args.name);
    case 'folderMove':
      return engine.folderMove(args.id, args.parentId ?? null);
    case 'folderTrash':
      return engine.folderTrash(args.id);
    case 'fileCreate':
      return engine.fileCreate(args.folderId ?? null, args.name, args.sha256);
    case 'fileRename':
      return engine.fileRename(args.id, args.name);
    case 'fileMove':
      return engine.fileMove(args.id, args.folderId);
    case 'fileTrash':
      return engine.fileTrash(args.id);
    case 'fileRestore':
      return engine.fileRestore(args.id);
    case 'filePurge':
      return engine.filePurge(args.id);
    case 'filesTrashPage':
      return engine.filesTrashPage(args.cursor ?? null, args.limit);
    case 'trashCounts':
      return engine.trashCounts();
    case 'trashEmpty':
      return engine.trashEmpty();
    case 'notesByTitlePrefix':
      return engine.notesByTitlePrefix(args.prefix, args.limit);
    case 'resolveLink':
      return engine.resolveLink(args.query);
    case 'fileRead':
      expect(args.query ?? null).toEqual(parseLinkRef(args.ref));
      return engine.fileRead(args.ref, args.query ?? null);
    case 'backlinks':
      return engine.backlinks(args.id, args.cursor ?? null, args.limit);
    case 'search':
      return engine.search(args.q, args.cursor ?? null, args.limit, args.filters ?? null);
    case 'tagNoteIds':
      return engine.tagNoteIds(args.tag);
    case 'notesRewriteBatch':
      return engine.notesRewriteBatch(args.entries as NoteRewriteEntry[]);
    case 'tagsReindexPage':
      return engine.tagsReindexPage(args.version, args.cursor ?? null, args.limit);
    case 'tagsReindexWrite':
      return engine.tagsReindexWrite(
        args.version,
        args.entries as TagsReindexEntry[],
        args.done as boolean
      );
    case 'blobPut':
      return engine.blobPut(new TextEncoder().encode(args.text), {
        mime: args.mime ?? null,
        expectedSha256: args.expectedSha256 ?? null
      });
    case 'blobRead': {
      const bytes = await engine.blobRead(args.sha256);
      return bytes ? { text: new TextDecoder().decode(bytes) } : null;
    }
    case 'filesList':
      return engine.filesList(args.cursor ?? null, args.limit);
    case 'blobInfo':
      return engine.blobInfo(args.sha256);
    case 'noteSummary':
      return engine.noteSummary(args.ids);
    case 'graphNeighborhood':
      return engine.graphNeighborhood(args.id, args.depth, args.limit);
    case 'graphOverview':
      return engine.graphOverview(args.limit);
    case 'propsQuery':
      return engine.propsQuery(
        (args.filters ?? null) as PropsQueryFilters | null,
        (args.sort ?? null) as PropsQuerySort | null,
        args.cursor ?? null,
        args.limit
      );
    case 'propsKeys':
      return engine.propsKeys(args.prefix ?? '', args.limit);
    case 'propsValues':
      return engine.propsValues(args.key, args.prefix ?? '', args.limit);
    case 'libraryDigest':
      return engine.libraryDigest();
    case 'importBatch':
      return engine.libraryImportBatch(withDefaults(args.batch as ImportBatch));
    case 'syncDirtyBatch':
      return engine.syncDirtyBatch(args.limit);
    case 'syncMarkPending':
      engine.syncMarkPending(args.entries as PendingMark[]);
      return null;
    case 'syncApplyPage':
      return engine.syncApplyPage(args.records as IncomingRecord[]);
    case 'syncAck':
      return engine.syncAck(args.entries as AckEntry[]);
    case 'sql':
      return conn.selectObjects(args.query);
    case 'sqlExec':
      // Estados que ningún comando de §5 produce (bytes nuevos de un recurso), o que se
      // fijan a mano para aislar §7 del comando (una lápida sin pasar por `filePurge`).
      conn.exec(args.query);
      return null;
    default:
      throw new Error(`operación desconocida en los casos: ${step.op}`);
  }
}

describe('casos compartidos del almacén (adaptador node:sqlite)', () => {
  for (const testCase of file.cases) {
    it(testCase.name, async () => {
      const { conn } = openNodeSqliteConn(':memory:');
      const engine = await SqliteLibraryEngine.open(conn, 'Mac', { blobs: new MemoryBlobStore() });
      const bound = new Map<string, Json>();
      for (const [index, rawStep] of testCase.steps.entries()) {
        const step = substitute(rawStep as unknown as Json, bound) as unknown as Step;
        const label = `${testCase.name} · paso ${index} (${step.op})`;
        if (step.expectError !== undefined) {
          await expect(run(engine, conn, step), label).rejects.toThrow(step.expectError);
          continue;
        }
        const result = await run(engine, conn, step);
        if (step.as) bound.set(step.as, result as Json);
        if ('expect' in step) assertIncludes(result, step.expect as Json, label);
      }
    });
  }
});
