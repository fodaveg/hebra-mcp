/**
 * Recuentos y listados sobre las notas VISIBLES, en SQL y sin traer a JS una fila por nota
 * (pieza A7 del plan de memoria, 6 nov 2026). Antes, `hebra_list_tags`, `hebra_list_folders`,
 * `hebra_list_properties` y `hebra_query_properties` recorrían `PrivacyFilter.visibleNotes()`,
 * que necesita la biblioteca entera cargada en el filtro (40-50 MiB de JS a 30 000 notas, 104 MiB
 * en `hebra_list_tags`) y la copia otra vez. Aquí la visibilidad entra en la propia consulta
 * (una subconsulta, `withVisibleNotes`), y a JS solo llega lo que crece con los valores distintos
 * (etiquetas, carpetas, claves) o con la página.
 *
 * Las reglas son las de `PrivacyFilter.isHiddenNote` (`src/privacy/filter.ts`), y no una copia
 * escrita a mano: el filtro de la llamada las da en un `VisibleNotesScope`
 * (`PrivacyFilter.notesScope()`), y la consulta las aplica sobre las mismas columnas que lee el
 * filtro (`VISIBILITY_COLUMNS` de `./privacy-sql.ts`). Una nota viva (ni papelera ni lápida) se ve
 * si a la vez:
 * - no está bloqueada mientras haya etiquetas privadas (A1);
 * - su carpeta efectiva no es una carpeta oculta (privada o debajo de una, también las que una
 *   ruta privada resolvió antes, A3: la lista ya la trae el filtro);
 * - si su carpeta guardada no está viva (A2), la subida por las lápidas desde ella resuelve a algo
 *   visible: eso no se puede decir en SQL (rutas en minúsculas y NFC, ciclos, filas que faltan),
 *   así que se leen las carpetas guardadas DISTINTAS de las notas vivas (muy pocas: lo que dejó un
 *   cliente antiguo o una carpeta que aún no llegó por sync) con sus filas de lápida, las juzga el
 *   propio filtro (`climbFolder`) y entran en la consulta las que se VEN: una que aparezca entre
 *   las dos lecturas no está en la lista y queda oculta (cerrado ante la duda). Las dos lecturas
 *   van en la misma transacción de lectura;
 * - no lleva ninguna etiqueta privada (`note_tags` guarda también los ancestros, así que
 *   `secreto/hondo` lleva `secreto`).
 *
 * Coste: las listas que entran en la consulta crecen con las carpetas ocultas, las etiquetas
 * privadas y las carpetas guardadas muertas, no con las notas. SQLite sí recorre las notas (el
 * tiempo sigue siendo O(notas)), pero sin llevarlas a JS.
 */
import type { DatabaseSync } from 'node:sqlite';
import { folderRowFacts, folderTrailOf, VISIBILITY_COLUMNS } from './privacy-sql';
import type { FolderRowFact } from './types';
import { inReadTransaction } from './grep-sql';

/** Las reglas del filtro de privados de una llamada, para aplicarlas dentro de una consulta
 *  (`PrivacyFilter.notesScope()`). */
export interface VisibleNotesScope {
  /** Las carpetas ocultas: privadas, sus descendientes y las que resolvió antes una ruta
   *  privada (`PrivacyFilter.isFolderHidden`). */
  readonly hiddenFolderIds: readonly string[];
  /** Las etiquetas privadas configuradas, canónicas. */
  readonly privateTags: readonly string[];
  /** Con etiquetas privadas, una nota bloqueada se oculta (A1). */
  readonly hideLocked: boolean;
  /** ¿Se ve lo guardado en `storedFolderId`, una carpeta que no está viva, subiendo por
   *  `trail` (sus filas de lápida hasta la primera viva)? La regla de A2 del filtro. */
  storedFolderVisible(storedFolderId: string, trail: readonly FolderRowFact[]): boolean;
}

/**
 * Las notas visibles como una subconsulta entre paréntesis, con las columnas `id`, `folder_id`
 * (la efectiva) e `is_locked`, para usarla como tabla (`FROM ${table} v`, `IN (SELECT id FROM
 * ${table} …)`), y sus parámetros, que van donde vaya `table` en el texto de la sentencia. Una
 * subconsulta y no una CTE (`WITH`): así toda sentencia de lectura sigue empezando por `SELECT`,
 * que es lo que vigila `test/store/surface.node.test.ts` en `./props-sql.ts`.
 */
export interface BoundScope {
  table: string;
  params: Array<string | number>;
}

/**
 * Las carpetas guardadas no vivas de las notas vivas (la `stored_folder_id` de
 * `VISIBILITY_COLUMNS`, sin repetir) que el filtro juzga visibles. Las filas de carpeta se leen
 * solo si hay alguna.
 */
function visibleStoredFolders(db: DatabaseSync, scope: VisibleNotesScope): string[] {
  const stored = db
    .prepare(
      `SELECT DISTINCT n.folder_id AS id
       FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
       WHERE n.deleted = 0 AND n.trashed_at IS NULL AND n.folder_id IS NOT NULL
         AND (f.id IS NULL OR f.deleted <> 0)`
    )
    .all() as Array<{ id: string }>;
  if (stored.length === 0) return [];
  const rows = new Map(folderRowFacts(db).map((row) => [row.id, row]));
  return stored
    .map((row) => String(row.id))
    .filter((id) => scope.storedFolderVisible(id, folderTrailOf(id, rows)));
}

function bindScope(db: DatabaseSync, scope: VisibleNotesScope): BoundScope {
  // Las mismas columnas que lee el filtro (`VISIBILITY_COLUMNS`), y sobre ellas sus reglas.
  // `locked`: la misma lectura que `visibilityEntries` (no nula y distinta de 0).
  const table = `(
    SELECT sv.id AS id, sv.folder_id AS folder_id,
           (sv.locked IS NOT NULL AND sv.locked <> 0) AS is_locked
    FROM (
      SELECT n.id AS id, ${VISIBILITY_COLUMNS}
      FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
      WHERE n.deleted = 0 AND n.trashed_at IS NULL
    ) sv
    WHERE NOT (? <> 0 AND sv.locked IS NOT NULL AND sv.locked <> 0)
      AND sv.folder_id NOT IN (SELECT value FROM json_each(?))
      AND (sv.stored_folder_id IS NULL OR sv.stored_folder_id IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (
        SELECT 1 FROM note_tags st
        WHERE st.note_id = sv.id AND st.tag IN (SELECT value FROM json_each(?))
      )
  )`;
  return {
    table,
    params: [
      scope.hideLocked ? 1 : 0,
      JSON.stringify(scope.hiddenFolderIds),
      JSON.stringify(visibleStoredFolders(db, scope)),
      JSON.stringify(scope.privateTags)
    ]
  };
}

/**
 * `fn` con las notas visibles ya resueltas (`BoundScope`), en una transacción de lectura: la
 * lista de carpetas guardadas visibles y la consulta que la usa ven la misma instantánea.
 */
export function withVisibleNotes<T>(db: DatabaseSync, scope: VisibleNotesScope, fn: (bound: BoundScope) => T): T {
  return inReadTransaction(db, () => fn(bindScope(db, scope)));
}

/** Cuántas notas visibles lleva cada etiqueta canónica (con ancestros, como `note_tags`). Solo
 *  las etiquetas con alguna; una fila por etiqueta distinta. */
export function visibleTagCounts(db: DatabaseSync, scope: VisibleNotesScope): Map<string, number> {
  return withVisibleNotes(db, scope, ({ table, params }) => {
    const counts = new Map<string, number>();
    const statement = db.prepare(
      `SELECT t.tag AS tag, COUNT(DISTINCT t.note_id) AS count
       FROM note_tags t JOIN ${table} v ON v.id = t.note_id
       WHERE t.tag IS NOT NULL
       GROUP BY t.tag`
    );
    for (const row of statement.iterate(...params) as Iterable<{ tag: string; count: number | bigint }>) {
      counts.set(String(row.tag), Number(row.count));
    }
    return counts;
  });
}

/** Cuántas notas visibles hay en cada carpeta EFECTIVA. Solo las carpetas con alguna. */
export function visibleFolderCounts(db: DatabaseSync, scope: VisibleNotesScope): Map<string, number> {
  return withVisibleNotes(db, scope, ({ table, params }) => {
    const counts = new Map<string, number>();
    const statement = db.prepare(
      `SELECT v.folder_id AS folder_id, COUNT(*) AS count FROM ${table} v GROUP BY v.folder_id`
    );
    for (const row of statement.iterate(...params) as Iterable<{ folder_id: string; count: number | bigint }>) {
      counts.set(String(row.folder_id), Number(row.count));
    }
    return counts;
  });
}

/** Una nota viva de una carpeta, con su título (sin el cuerpo). */
export interface FolderNoteTitle {
  id: string;
  title: string;
}

/**
 * Las notas vivas (ni papelera ni lápida) cuya carpeta EFECTIVA es `folderId`, con su título y
 * por id, SIN filtro de privados (lo aplica quien llama): `listNotes` del puerto del motor JD
 * (`./jd-port.ts`). La carpeta efectiva es la de `VISIBILITY_COLUMNS`: la propia si está viva, si
 * no la raíz. Fuera de la raíz, por el índice de `folder_id`; en la raíz, también las de carpeta
 * guardada muerta.
 */
export function titlesInFolderRows(db: DatabaseSync, folderId: string): FolderNoteTitle[] {
  const statement =
    folderId === 'root'
      ? db.prepare(
          `SELECT n.id AS id, n.title AS title
           FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
           WHERE n.deleted = 0 AND n.trashed_at IS NULL
             AND CASE WHEN f.id IS NOT NULL AND f.deleted = 0 THEN n.folder_id ELSE 'root' END = 'root'
           ORDER BY n.id`
        )
      : db.prepare(
          `SELECT n.id AS id, n.title AS title
           FROM notes n JOIN folders f ON f.id = n.folder_id
           WHERE n.folder_id = ? AND f.deleted = 0 AND n.deleted = 0 AND n.trashed_at IS NULL
           ORDER BY n.id`
        );
  const rows = (folderId === 'root' ? statement.all() : statement.all(folderId)) as Array<{
    id: string;
    title: string | null;
  }>;
  return rows.map((row) => ({ id: String(row.id), title: String(row.title ?? '') }));
}
