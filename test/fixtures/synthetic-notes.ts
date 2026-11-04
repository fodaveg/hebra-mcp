/**
 * Notas sintéticas para medir `notesVisibilityIndex`: se crean con el motor DIRECTAMENTE (como
 * `test-library.ts`), sin `deriveNote`, porque lo que interesa es la consulta y no el analizador
 * de Markdown. Con ellas, `test/store/notes-visibility-index.node.test.ts` cuenta sentencias y
 * `test/perf/notes-visibility-index.perf.ts` mide milisegundos.
 */
import { SqliteLibraryEngine } from '../../src/hebra';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

export interface SyntheticOptions {
  notes: number;
  folders: number;
  tagsPerNote: number;
  tagUniverse: number;
}

/** Crea la biblioteca en `sqlitePath`, la cierra y devuelve lo que tardó crear las notas. */
export async function createSyntheticLibrary(sqlitePath: string, options: SyntheticOptions): Promise<number> {
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'perf-fixture');
  const folderIds: string[] = [];
  for (let i = 0; i < options.folders; i += 1) {
    folderIds.push((await engine.folderCreate(null, `Carpeta ${i}`)).id);
  }
  const start = Date.now();
  for (let i = 0; i < options.notes; i += 1) {
    const created = await engine.noteCreate(folderIds[i % options.folders]!);
    const tags = Array.from({ length: options.tagsPerNote }, (_, t) => {
      const tag = `tag${(i + t) % options.tagUniverse}`;
      return { tag, label: tag, direct: true };
    });
    await engine.noteSave({
      id: created.id,
      body: `# Nota ${i}\ncuerpo sintético ${i}`,
      title: `Nota ${i}`,
      titleNorm: `nota ${i}`,
      excerpt: `cuerpo sintético ${i}`,
      expectedLocalSeq: created.localSeq,
      baseBodySha256: created.bodySha256,
      tags
    });
  }
  const createMs = Date.now() - start;
  db.close();
  return createMs;
}
