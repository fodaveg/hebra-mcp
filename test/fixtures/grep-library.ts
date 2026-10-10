/**
 * Biblioteca de `hebra_grep` (D13), hecha con el propio motor de Hebra, en DOS copias con
 * los mismos ids: `withPrivate` tiene además siete notas que no se pueden ver (carpeta
 * privada, subcarpeta, etiqueta privada, etiqueta descendiente, bloqueada, en la papelera
 * y copia de conflicto de una privada), todas con el término buscado muchas veces;
 * `withoutPrivate` es la misma base con esas siete purgadas (`notePurge`, lápida). Una
 * respuesta de `hebra_grep` tiene que ser IDÉNTICA en las dos, cursores incluidos.
 *
 * Las visibles tienen tildes, mayúsculas, apartados, frontmatter, `\r\n`, una línea larga,
 * muchas coincidencias, enlaces con alias, `hebra://`, `[[id:…]]` y un adjunto, para el
 * prefiltro de subcadena y sus excepciones.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { PrivacyFilter, type PrivacyConfig } from '../../src/privacy';
import type { ToolContext } from '../../src/server/context';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { createNote, lockedBody } from './test-library';

export const GREP_PRIVACY: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };

/** Lo que ninguna respuesta puede llevar: va en todas las notas privadas. */
export const GREP_BAIT = 'CEBO_GREP_4b7d';

const HEX = 'ab'.repeat(32);

export const VISIBLE_BODIES = {
  receta:
    '# Receta de garbanzos\n\n## Ingredientes\n- Garbanzos cocidos\n- GARBANZOS secos\n\n' +
    '## Pasos\nRemojar los garbanzos.\nVer [[Receta de pan|la otra receta]] y hebra://note/abc123.\n',
  cancion:
    '---\ntitle: Canción\n---\n# Canción\n\nUna canción. CANCIÓN en mayúsculas. cancion sin tilde.\n' +
    '### Sub\nGarbanzos en la sub\n',
  crlf: '# Notas CRLF\r\n\r\nlinea con garbanzos\r\notra\r\n',
  larga: `# Larga\n${'x'.repeat(500)} garbanzos ${'y'.repeat(500)}\n`,
  muchas: `# Muchas\n${Array.from({ length: 30 }, (_, index) => `garbanzo ${index + 1}`).join('\n')}\n`,
  enlaces: `# Enlaces\n[[id:0000-garbanzos]]\n![[sha256:${HEX}|foto garbanzos.png]]\n`,
  cocina: '# Cocina\n#cocina\nGarbanzos con #cocina\n'
} as const;

function privateBody(title: string, extra = ''): string {
  const lines = Array.from({ length: 200 }, (_, index) => `garbanzos privados ${index} ${GREP_BAIT}`);
  return `# ${title}\n${extra}${lines.join('\n')}\nCanción GARBANZOS hebra-locked\n`;
}

export interface GrepLibraryPair {
  dir: string;
  withPrivate: string;
  withoutPrivate: string;
  visibleIds: Record<keyof typeof VISIBLE_BODIES | 'conflictCopy', string>;
  privateIds: string[];
  close(): void;
}

async function save(engine: SqliteLibraryEngine, id: string, body: string, conflict: boolean) {
  const row = (await engine.noteRead(id))!;
  const derived = deriveNote(body);
  return engine.noteSave({
    id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: conflict ? -1 : row.localSeq,
    baseBodySha256: conflict ? null : row.bodySha256,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
}

export async function buildGrepLibraryPair(): Promise<GrepLibraryPair> {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-grep-'));
  const withPrivate = join(dir, 'con', 'library.sqlite');
  const withoutPrivate = join(dir, 'sin', 'library.sqlite');
  for (const path of [withPrivate, withoutPrivate]) mkdirSync(join(path, '..'), { recursive: true });

  const { db, conn } = openNodeSqliteConn(withPrivate);
  const engine = await SqliteLibraryEngine.open(conn, 'grep-fixture');
  const proyectos = await engine.folderCreate(null, 'Proyectos');
  const lumbre = await engine.folderCreate(proyectos.id, 'Lumbre');
  const diario = await engine.folderCreate(null, 'Diario');
  const diario2026 = await engine.folderCreate(diario.id, '2026');

  const folderOf: Record<keyof typeof VISIBLE_BODIES, string | null> = {
    receta: null,
    cancion: lumbre.id,
    crlf: proyectos.id,
    larga: null,
    muchas: null,
    enlaces: null,
    cocina: null
  };
  const visibleIds = {} as GrepLibraryPair['visibleIds'];
  for (const key of Object.keys(VISIBLE_BODIES) as Array<keyof typeof VISIBLE_BODIES>) {
    visibleIds[key] = (await createNote(engine, folderOf[key], VISIBLE_BODIES[key])).id;
  }
  // Copia de conflicto VISIBLE (de una visible): sale, con `isConflictCopy`.
  const visibleCopy = await save(
    engine,
    visibleIds.receta,
    '# Receta de garbanzos\n\nVersión en conflicto con garbanzos.\n',
    true
  );
  if (visibleCopy.outcome !== 'redirected') throw new Error('grep-library: sin copia de conflicto');
  visibleIds.conflictCopy = visibleCopy.redirectedTo;

  const privateIds: string[] = [];
  privateIds.push((await createNote(engine, diario.id, privateBody('Diario'))).id);
  privateIds.push((await createNote(engine, diario2026.id, privateBody('Diario 2026'))).id);
  privateIds.push((await createNote(engine, null, privateBody('Secreto', '#secreto\n'))).id);
  privateIds.push((await createNote(engine, null, privateBody('Personal', '#secreto/personal\n'))).id);
  // Bloqueada, en la raíz (visible para las demás herramientas): su cuerpo no se busca.
  privateIds.push((await createNote(engine, null, lockedBody('Garbanzos bloqueados', []))).id);
  const trashed = await createNote(engine, null, privateBody('Papelera'));
  await engine.noteTrash(trashed.id);
  privateIds.push(trashed.id);
  // Copia de conflicto de una nota de la carpeta privada: hereda la carpeta.
  const privateCopy = await save(engine, privateIds[0]!, privateBody('Diario en conflicto'), true);
  if (privateCopy.outcome !== 'redirected') throw new Error('grep-library: sin copia privada');
  privateIds.push(privateCopy.redirectedTo);
  db.close();

  copyFileSync(withPrivate, withoutPrivate);
  const second = openNodeSqliteConn(withoutPrivate);
  const pruned = await SqliteLibraryEngine.open(second.conn, 'grep-fixture');
  for (const id of privateIds) await pruned.notePurge(id);
  second.db.close();

  return {
    dir,
    withPrivate,
    withoutPrivate,
    visibleIds,
    privateIds,
    close: () => rmSync(dir, { recursive: true, force: true })
  };
}

/** Un `ToolContext` de solo lectura sobre una de las dos copias. */
export async function grepContext(
  sqlitePath: string,
  privacyConfig: PrivacyConfig = GREP_PRIVACY,
  mode: 'readWrite' | 'readOnly' = 'readWrite'
): Promise<{ ctx: ToolContext; port: NodeLibraryPort }> {
  const port = await openNodeLibraryPort({ sqlitePath, dataDir: join(sqlitePath, '..'), mode });
  const privacy = await PrivacyFilter.build(port, privacyConfig);
  return {
    ctx: { port, privacy, privacyConfig, status: new UnlinkedStatusSource() },
    port
  };
}
