/**
 * Biblioteca de las propiedades del frontmatter (D23), como la de `hebra_grep`
 * (`./grep-library.ts`), en DOS copias con los mismos ids: `withPrivate` tiene además notas que
 * no se pueden ver (carpeta privada, subcarpeta, etiqueta privada, descendiente, bloqueada, en la
 * papelera y copia de conflicto de una privada), todas con claves y valores que no tiene nadie
 * más y con un valor no numérico en `prioridad`, la clave por la que se ordena; `withoutPrivate`
 * es la misma base con esas notas purgadas. Una respuesta tiene que ser IDÉNTICA en las dos,
 * cursores incluidos.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { createNote, lockedBody } from './test-library';

/** Lo que ninguna respuesta puede llevar. */
export const PROPS_BAIT_KEY = 'clave_oculta';
export const PROPS_BAIT_VALUE = 'CEBOPROPS';

/** Un título que solo tiene una nota oculta, y otro que comparten una visible y una oculta. */
export const ONLY_HIDDEN_TITLE = 'Solo Privada';
export const SHARED_TITLE = 'Destino';

const HIDDEN_FRONTMATTER = [
  '---',
  `${PROPS_BAIT_KEY}: valor_oculto`,
  `estado: ${PROPS_BAIT_VALUE}`,
  'prioridad: no-numero',
  '---',
  ''
].join('\n');

function hiddenBody(title: string, extra = ''): string {
  return `${HIDDEN_FRONTMATTER}# ${title}\n${extra}garbanzos ${PROPS_BAIT_VALUE}\n`;
}

/** Empiezan igual mucho más allá del tope del cursor. */
export const LONG_VALUE = 'x'.repeat(5_000);

export interface PropsLibraryPair {
  dir: string;
  withPrivate: string;
  withoutPrivate: string;
  ids: Record<
    | 'alfa' | 'beta' | 'gamma' | 'delta' | 'eco' | 'largoA' | 'largoB'
    | 'destino' | 'enlaza' | 'enlazaSolo' | 'enlazaOculta',
    string
  >;
  privateIds: string[];
  /** La homónima oculta de `Destino`, a la que `enlazaOculta` apunta por id. */
  hiddenTwinId: string;
  close(): void;
}

export async function buildPropsLibraryPair(): Promise<PropsLibraryPair> {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-props-'));
  const withPrivate = join(dir, 'con', 'library.sqlite');
  const withoutPrivate = join(dir, 'sin', 'library.sqlite');
  for (const path of [withPrivate, withoutPrivate]) mkdirSync(join(path, '..'), { recursive: true });

  const { db, conn } = openNodeSqliteConn(withPrivate);
  const engine = await SqliteLibraryEngine.open(conn, 'props-fixture');
  const proyectos = await engine.folderCreate(null, 'Proyectos');
  const lumbre = await engine.folderCreate(proyectos.id, 'Lumbre');
  const diario = await engine.folderCreate(null, 'Diario');
  const diario2026 = await engine.folderCreate(diario.id, '2026');

  const privateIds: string[] = [];
  const hide = async (folderId: string | null, body: string): Promise<string> => {
    const { id } = await createNote(engine, folderId, body);
    privateIds.push(id);
    return id;
  };
  const diarioId = await hide(diario.id, hiddenBody('Diario'));
  await hide(diario2026.id, hiddenBody('Diario 2026'));
  await hide(null, hiddenBody('Secreto', '#secreto\n'));
  await hide(null, hiddenBody('Personal', '#secreto/personal\n'));
  await hide(null, lockedBody('Bloqueada', []));
  const trashed = await hide(null, hiddenBody('Papelera'));
  await engine.noteTrash(trashed);
  await hide(diario.id, hiddenBody(ONLY_HIDDEN_TITLE));
  const hiddenTwinId = await hide(diario.id, hiddenBody(SHARED_TITLE, `[[${SHARED_TITLE}]]\n`));
  const row = (await engine.noteRead(diarioId))!;
  const conflictBody = hiddenBody('Diario en conflicto');
  const derived = deriveNote(conflictBody);
  const copy = await engine.noteSave({
    id: row.id,
    body: conflictBody,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: -1,
    baseBodySha256: null,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
  if (copy.outcome !== 'redirected') throw new Error('props-library: sin copia privada');
  privateIds.push(copy.redirectedTo);

  const note = async (folderId: string | null, body: string): Promise<string> =>
    (await createNote(engine, folderId, body)).id;
  const ids: PropsLibraryPair['ids'] = {
    alfa: await note(null, '---\nestado: activo\nprioridad: 9\ntipo:\n  - x\n  - y\n---\n# Alfa\ngarbanzos\n'),
    beta: await note(proyectos.id, '---\nestado: Activo\nprioridad: 10\n---\n# Beta\ngarbanzos\n'),
    gamma: await note(lumbre.id, '---\nestado: pausado\nprioridad: 2\nfecha: 2026-03-01\n---\n# Gamma\n'),
    delta: await note(null, '# Delta\ngarbanzos\n'),
    eco: await note(null, '---\nvacia:\nprioridad: null\n---\n# Eco\n'),
    largoA: await note(null, `---\nlargo: ${LONG_VALUE}a\n---\n# Largo A\n`),
    largoB: await note(null, `---\nlargo: ${LONG_VALUE}b\n---\n# Largo B\n`),
    // Se enlaza a sí misma por título: con la homónima oculta, el motor la daría por enlazadora.
    destino: await note(null, `---\nestado: activo\n---\n# ${SHARED_TITLE}\n[[${SHARED_TITLE}]] garbanzos\n`),
    enlaza: await note(null, `---\nestado: activo\n---\n# Enlaza\n[[${SHARED_TITLE}]] garbanzos\n`),
    enlazaSolo: await note(null, `---\nestado: activo\n---\n# Enlaza sola\n[[${ONLY_HIDDEN_TITLE}]] garbanzos\n`),
    enlazaOculta: await note(null, `---\nestado: activo\n---\n# Enlaza oculta\n[[id:${hiddenTwinId}]] garbanzos\n`)
  };
  db.close();

  copyFileSync(withPrivate, withoutPrivate);
  const second = openNodeSqliteConn(withoutPrivate);
  const pruned = await SqliteLibraryEngine.open(second.conn, 'props-fixture');
  for (const id of privateIds) await pruned.notePurge(id);
  second.db.close();

  return {
    dir,
    withPrivate,
    withoutPrivate,
    ids,
    privateIds,
    hiddenTwinId,
    close: () => rmSync(dir, { recursive: true, force: true })
  };
}
