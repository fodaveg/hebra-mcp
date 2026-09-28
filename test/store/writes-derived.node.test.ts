import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { APPEND_SEPARATOR, NoteWriter } from '../../src/store/writes';

/**
 * Derivados completos (título, clave de orden, tareas, etiquetas, enlaces, adjuntos y
 * propiedades) tras `createNote` y `appendToNote`. Bug medido el 28 sep 2026:
 * `saveInputFor` no pasaba `hasOpenTasks`, `tasks` ni `titleSort` de `deriveNote`, y el
 * almacén de Hebra borra e inserta `tasks ?? []` en cada guardado (`replaceNoteTasks`),
 * así que crear o añadir dejaba vacío el índice de tareas de la nota.
 *
 * Lo guardado se lee con OTRA conexión `node:sqlite` sobre el mismo fichero (solo
 * lectura) y se compara con lo que devuelve `deriveNote` del cuerpo final: si el motor
 * y la herramienta derivan distinto, el test lo dice.
 */

const SHA = 'ab'.repeat(32);

/** Cuerpo que ejercita todos los derivados: frontmatter, H1, etiquetas anidadas, dos
 *  casillas (una abierta, con campo inline), un enlace a nota y uno a adjunto. */
const FULL_BODY = [
  '---',
  'estado: activo',
  '---',
  '# Ñandú y compañía',
  '#proyectos/hebra #lectura',
  '- [ ] tarea abierta [prioridad:: alta]',
  '- [x] tarea hecha',
  `Enlace a [[Otra nota]] y adjunto [[sha256:${SHA}]].`,
  ''
].join('\n');

interface StoredDerived {
  title: string;
  titleNorm: string;
  titleSort: string;
  excerpt: string;
  hasOpenTasks: boolean;
  tags: Array<{ tag: string; label: string; direct: boolean }>;
  links: Array<{ targetKind: string; target: string; targetPath: string | null }>;
  blobRefs: string[];
  props: Array<{ key: string; value: string }>;
  tasks: Array<{ line: number; status: string; text: string }>;
}

function byJson<T>(items: T[]): T[] {
  return [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function storedDerived(sqlitePath: string, id: string): StoredDerived {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const note = db
      .prepare('SELECT title, title_norm, title_sort, excerpt, has_open_tasks FROM notes WHERE id = ?')
      .get(id) as Record<string, unknown>;
    const rows = (sql: string) => db.prepare(sql).all(id) as Array<Record<string, unknown>>;
    return {
      title: String(note.title),
      titleNorm: String(note.title_norm),
      titleSort: String(note.title_sort),
      excerpt: String(note.excerpt),
      hasOpenTasks: Number(note.has_open_tasks) === 1,
      tags: byJson(
        rows('SELECT tag, label, direct FROM note_tags WHERE note_id = ?').map((row) => ({
          tag: String(row.tag),
          label: String(row.label),
          direct: Number(row.direct) === 1
        }))
      ),
      links: byJson(
        rows('SELECT target_kind, target, target_path FROM links WHERE src_note_id = ?').map(
          (row) => ({
            targetKind: String(row.target_kind),
            target: String(row.target),
            targetPath: (row.target_path as string | null) ?? null
          })
        )
      ),
      blobRefs: rows('SELECT sha256 FROM note_blob_refs WHERE note_id = ? ORDER BY ordinal').map(
        (row) => String(row.sha256)
      ),
      props: byJson(
        rows('SELECT key, value FROM note_props WHERE note_id = ?').map((row) => ({
          key: String(row.key),
          value: String(row.value)
        }))
      ),
      tasks: rows('SELECT line, status, text FROM note_tasks WHERE note_id = ? ORDER BY line').map(
        (row) => ({ line: Number(row.line), status: String(row.status), text: String(row.text) })
      )
    };
  } finally {
    db.close();
  }
}

function expectedDerived(body: string): StoredDerived {
  const derived = deriveNote(body);
  return {
    title: derived.title,
    titleNorm: derived.titleNorm,
    titleSort: derived.titleSort,
    excerpt: derived.excerpt,
    hasOpenTasks: derived.hasOpenTasks ?? false,
    tags: byJson((derived.tags ?? []).map(({ tag, label, direct }) => ({ tag, label, direct }))),
    links: byJson(
      (derived.links ?? []).map(({ targetKind, target, targetPath }) => ({
        targetKind,
        target,
        targetPath
      }))
    ),
    blobRefs: derived.blobRefs ?? [],
    props: byJson((derived.props ?? []).map(({ key, value }) => ({ key, value }))),
    tasks: (derived.tasks ?? []).map(({ line, status, text }) => ({ line, status, text }))
  };
}

describe('derivados completos al crear y añadir (NoteWriter)', () => {
  let dataDir: string | undefined;
  let port: NodeLibraryPort | undefined;

  afterEach(async () => {
    port?.close();
    port = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  async function open(): Promise<{ sqlitePath: string; writer: NoteWriter }> {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-derived-'));
    const sqlitePath = join(dataDir, 'library.sqlite');
    port = await openNodeLibraryPort({ sqlitePath, dataDir });
    return { sqlitePath, writer: new NoteWriter(port) };
  }

  it('el cuerpo de prueba ejercita todos los derivados', () => {
    const expected = expectedDerived(FULL_BODY);
    expect(expected.title).toBe('Ñandú y compañía');
    expect(expected.hasOpenTasks).toBe(true);
    expect(expected.tasks).toHaveLength(2);
    expect(expected.tags.length).toBeGreaterThanOrEqual(3);
    expect(expected.links.some((link) => link.targetKind === 'title')).toBe(true);
    expect(expected.blobRefs).toEqual([SHA]);
    expect(expected.props).toContainEqual({ key: 'estado', value: 'activo' });
  });

  it('createNote guarda todos los derivados de deriveNote', async () => {
    const { sqlitePath, writer } = await open();
    const created = await writer.createNote({ body: FULL_BODY });
    expect(storedDerived(sqlitePath, created.id)).toEqual(expectedDerived(FULL_BODY));
  });

  it('appendToNote conserva y recalcula todos los derivados del cuerpo final', async () => {
    const { sqlitePath, writer } = await open();
    const created = await writer.createNote({ body: FULL_BODY });
    const text = '- [ ] otra tarea #nueva';
    await writer.appendToNote({ id: created.id, text });
    const finalBody = `${FULL_BODY}${APPEND_SEPARATOR}${text}`;
    const stored = storedDerived(sqlitePath, created.id);
    expect(stored).toEqual(expectedDerived(finalBody));
    expect(stored.tasks).toHaveLength(3);
  });
});
