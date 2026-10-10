/**
 * Las consultas de `hebra_grep` (D13, SPEC.md §5), SQL propio de hebra-mcp sobre `notes`,
 * `meta` y el índice de subcadena de Hebra (`notes_trigram` y su cola
 * `notes_trigram_pending`, H5). Las llama `NodeLibraryPort` dentro de un turno de su cola;
 * aquí no hay filtro de privados: quien llama decide antes qué notas se miran, y solo de
 * esas se lee el cuerpo.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SUBSTRING_INDEX_VERSION, type FoldersList } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyFilter } from '../privacy/filter';

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

/**
 * `fn` en una transacción de lectura (`BEGIN` diferida, también en una conexión de solo
 * lectura): todas sus sentencias ven la MISMA instantánea de la base. En autocommit, cada
 * sentencia tiene la suya, y en un lector el escritor de otro proceso puede confirmar entre
 * dos de ellas.
 */
function inReadTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ya no había transacción: se propaga el error de verdad.
    }
    throw error;
  }
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
  // Todo en UNA instantánea: en un lector, en autocommit, el escritor de otro proceso podía
  // vaciar la cola entre la consulta al índice y la de la cola, y una nota que estaba en la
  // cola (aún sin indexar) no salía en ninguna de las dos.
  return inReadTransaction(db, () => substringCandidatesNow(db, match, rowids));
}

function substringCandidatesNow(
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


/** Lo que `grepVisibleBodies` guarda entre un lote y el siguiente de la misma llamada: el
 *  árbol de carpetas (`foldersList` del motor) y su huella, para no volver a pedirlo si
 *  no ha cambiado. */
export interface GrepBodiesSession {
  signature: string;
  folders: FoldersList;
}

export interface GrepBodiesResult {
  /** `rowid` → cuerpo, solo de las que siguen vivas, sin bloquear y VISIBLES. */
  bodies: Map<number, string>;
  /** La configuración de privados ya no se puede aplicar (una carpeta privada configurada
   *  desapareció): quien llama no devuelve nada (`privacy_config_unresolved`). */
  unresolved: boolean;
  session: GrepBodiesSession;
}

/**
 * El cuerpo de las notas de `rowids` que, AHORA, siguen vivas, sin bloquear y visibles,
 * en una sola transacción de lectura (D13, SPEC.md §6.3). El filtro de privados de la
 * herramienta es la instantánea del principio de la llamada, y entre ese turno y este (o
 * entre dos lotes) una ronda de sync puede haber movido una nota a una carpeta privada o
 * haberle puesto una etiqueta privada: por eso se rehace aquí, como el escritor dentro de
 * su turno (`PrivacyFilter.fromSnapshot`), con la carpeta efectiva y las etiquetas
 * (`note_tags`) leídas en la MISMA sentencia que el cuerpo, y el árbol de carpetas de esta
 * misma transacción. El árbol (`foldersList` del motor, que cuenta notas y recorre la
 * tabla) solo se vuelve a pedir si cambió la huella de `folders` desde el lote anterior.
 */
export function grepVisibleBodies(
  db: DatabaseSync,
  foldersList: () => FoldersList,
  rowids: readonly number[],
  privacy: PrivacyConfig,
  session: GrepBodiesSession | null
): GrepBodiesResult {
  return inReadTransaction(db, () => {
    const signature = String(
      (
        db
          .prepare(
            `SELECT json_group_array(json_array(id, parent_id, name, deleted)) AS sig
             FROM (SELECT id, parent_id, name, deleted FROM folders ORDER BY id)`
          )
          .get() as { sig: string }
      ).sig
    );
    const current =
      session && session.signature === signature ? session : { signature, folders: foldersList() };
    const rows = db
      .prepare(
        `SELECT n.rowid AS rid, n.id AS id, n.body AS body,
                CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END AS folder_id,
                (SELECT GROUP_CONCAT(t.tag, char(10)) FROM note_tags AS t WHERE t.note_id = n.id) AS tags
         FROM json_each(?) AS wanted
         CROSS JOIN notes AS n ON n.rowid = wanted.value
         LEFT JOIN folders AS f ON f.id = n.folder_id
         WHERE n.deleted = 0 AND n.trashed_at IS NULL AND n.locked = 0`
      )
      .all(JSON.stringify(rowids)) as Array<{
      rid: number | bigint;
      id: string;
      body: string | null;
      folder_id: string;
      tags: string | null;
    }>;
    const filter = PrivacyFilter.fromSnapshot(
      current.folders,
      rows.map((row) => ({
        id: String(row.id),
        folderId: String(row.folder_id),
        tags: row.tags ? row.tags.split('\n') : []
      })),
      privacy
    );
    const bodies = new Map<number, string>();
    if (!filter.unresolved) {
      for (const row of rows) {
        if (!filter.isHiddenNote(String(row.id))) bodies.set(Number(row.rid), String(row.body ?? ''));
      }
    }
    return { bodies, unresolved: filter.unresolved, session: current };
  });
}
