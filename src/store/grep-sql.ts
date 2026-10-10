/**
 * Las consultas de `hebra_grep` (D13, SPEC.md §5), SQL propio de hebra-mcp sobre `notes`,
 * `meta` y el índice de subcadena de Hebra (`notes_trigram` y su cola
 * `notes_trigram_pending`, H5). Las llama `NodeLibraryPort` dentro de un turno de su cola;
 * aquí no hay filtro de privados: quien llama decide antes qué notas se miran, y solo de
 * esas se lee el cuerpo.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SUBSTRING_INDEX_VERSION } from '../hebra';

/** Una nota viva (ni papelera ni lápida), sin su cuerpo: lo que `hebra_grep` necesita para
 *  decidir qué recorre. `rowid` es la clave del índice de subcadena. */
export interface GrepNoteRow {
  rowid: number;
  id: string;
  title: string;
  locked: boolean;
  /** Si es una copia de conflicto (`notes.conflict_of`). */
  conflict: boolean;
}

export function grepNoteRows(db: DatabaseSync): GrepNoteRow[] {
  const rows = db
    .prepare(
      `SELECT rowid AS rid, id, title, locked, conflict_of IS NOT NULL AS conflict FROM notes
       WHERE deleted = 0 AND trashed_at IS NULL`
    )
    .all() as Array<{
      rid: number | bigint;
      id: string;
      title: string | null;
      locked: number | bigint;
      conflict: number | bigint;
    }>;
  return rows.map((row) => ({
    rowid: Number(row.rid),
    id: String(row.id),
    title: String(row.title ?? ''),
    locked: Number(row.locked) !== 0,
    conflict: Number(row.conflict) !== 0
  }));
}

/** ¿Está `notes_trigram` completa con la versión de este submódulo? La marca la deja el
 *  relleno (`NodeLibraryPort.fillSubstringIndex`) con su última página; sin la tabla (una
 *  SQLite sin `trigram`, o un lector de una base que el escritor aún no ha abierto con
 *  H5), no. */
function substringIndexComplete(db: DatabaseSync): boolean {
  const table = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master
       WHERE type = 'table' AND name IN ('notes_trigram', 'notes_trigram_pending')`
    )
    .all();
  if (table.length !== 2) return false;
  const row = db
    .prepare("SELECT CAST(value AS INTEGER) AS version FROM meta WHERE key = 'substring_index_version'")
    .get() as { version: number | bigint } | undefined;
  return row !== undefined && Number(row.version) >= SUBSTRING_INDEX_VERSION;
}

/**
 * Las notas de `rowids` que PUEDEN casar con un literal, según el índice de subcadena:
 * las que da `match` (`trigramMatch` de `./grep.ts`), las que siguen en la cola del índice
 * (se guardaron y aún no se indexaron) y las que tienen en el cuerpo algo que el índice no
 * guarda tal cual (un enlace con alias, un `[[id:…]]`, un `sha256:…` o un `hebra://…`),
 * donde el literal podría estar sin que el índice lo vea. `null` si el índice no está
 * completo: entonces no se puede usar y se recorre todo.
 *
 * Solo se lee el cuerpo (para lo último) de las notas de `rowids`, que son las que quien
 * llama ya decidió mirar (visibles, sin bloquear): el de una nota oculta nunca. La consulta
 * al índice sí recorre sus entradas (de todas las notas, como `hebra_search`), pero solo
 * devuelve `rowid` y se cruza después con `rowids`.
 */
export function grepSubstringCandidates(
  db: DatabaseSync,
  match: string,
  rowids: readonly number[]
): Set<number> | null {
  if (!substringIndexComplete(db)) return null;
  const wanted = new Set(rowids);
  const out = new Set<number>();
  const keep = (rows: unknown[]): void => {
    for (const row of rows as Array<{ rid: number | bigint }>) {
      const rowid = Number(row.rid);
      if (wanted.has(rowid)) out.add(rowid);
    }
  };
  keep(db.prepare('SELECT rowid AS rid FROM notes_trigram WHERE notes_trigram MATCH ?').all(match));
  keep(db.prepare('SELECT rowid AS rid FROM notes_trigram_pending').all());
  keep(
    db
      .prepare(
        `SELECT n.rowid AS rid FROM json_each(?) AS wanted
         CROSS JOIN notes AS n ON n.rowid = wanted.value
         WHERE (instr(n.body, '[[') > 0 AND instr(n.body, '|') > 0)
            OR instr(n.body, '[[id:') > 0
            OR instr(n.body, 'sha256:') > 0
            OR instr(n.body, 'hebra://') > 0`
      )
      .all(JSON.stringify(rowids))
  );
  return out;
}

/**
 * El cuerpo de las notas de `rowids` que siguen vivas y sin bloquear (pudo cambiar algo
 * desde `grepNoteRows`: la que ya no lo esté, falta en el resultado).
 */
export function grepBodies(db: DatabaseSync, rowids: readonly number[]): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT n.rowid AS rid, n.body AS body FROM json_each(?) AS wanted
       CROSS JOIN notes AS n ON n.rowid = wanted.value
       WHERE n.deleted = 0 AND n.trashed_at IS NULL AND n.locked = 0`
    )
    .all(JSON.stringify(rowids)) as Array<{ rid: number | bigint; body: string | null }>;
  return new Map(rows.map((row) => [Number(row.rid), String(row.body ?? '')]));
}
