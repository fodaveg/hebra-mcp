/**
 * `hebra_grep` (D13, SPEC.md §5): privacidad (una nota que no se ve no cambia NADA de la
 * respuesta), corte por tiempo y cursor, expresión regular catastrófica, prefiltro de
 * subcadena igual que sin él, y el contrato de cada coincidencia.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { runGrep, type GrepInput, type GrepMatch, type GrepOutput } from '../../src/server/tools/grep';
import { runReadNote } from '../../src/server/tools/read-note';
import type { NodeLibraryPort } from '../../src/store/node-port';
import { substringIndexUsable, type GrepBodiesSession } from '../../src/store/grep-sql';
import { trigramMatch } from '../../src/store/grep';
import type { PrivacyConfig } from '../../src/privacy/config';
import { createNote } from '../fixtures/test-library';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import {
  buildGrepLibraryPair,
  GREP_BAIT,
  GREP_PRIVACY,
  grepContext,
  VISIBLE_BODIES,
  type GrepLibraryPair
} from '../fixtures/grep-library';

let pair: GrepLibraryPair;
let withPrivate: { ctx: ToolContext; port: NodeLibraryPort };
let withoutPrivate: { ctx: ToolContext; port: NodeLibraryPort };

beforeAll(async () => {
  pair = await buildGrepLibraryPair();
  withPrivate = await grepContext(pair.withPrivate);
  withoutPrivate = await grepContext(pair.withoutPrivate);
});

afterAll(() => {
  withPrivate?.port.close();
  withoutPrivate?.port.close();
  pair?.close();
});

/** Todas las páginas, siguiendo `nextCursor` (con un tope por si el cursor no avanzara). */
async function allPages(
  ctx: ToolContext,
  input: GrepInput,
  options: { timeBudgetMs?: number } = {}
): Promise<GrepOutput[]> {
  const pages: GrepOutput[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page += 1) {
    const out = await runGrep(ctx, { ...input, cursor }, options);
    pages.push(out);
    if (out.nextCursor === null) return pages;
    cursor = out.nextCursor;
  }
  throw new Error('el cursor no avanza');
}

const flat = (pages: readonly GrepOutput[]): GrepMatch[] => pages.flatMap((page) => page.matches);
const where = (match: GrepMatch): string => `${match.id}:${match.line}`;

const QUERIES: GrepInput[] = [
  { pattern: 'garbanzos' },
  { pattern: 'Garbanzos', caseSensitive: true },
  { pattern: 'garban[zs]os?', regex: true },
  { pattern: '^- ', regex: true },
  { pattern: 'garbanzos', contextLines: 2 },
  { pattern: 'garbanzos', folder: 'Proyectos', subfolders: true },
  { pattern: 'garbanzos', folder: '' },
  { pattern: 'garbanzos', tag: 'cocina' },
  { pattern: 'canción' },
  { pattern: 'hebra-locked' },
  { pattern: GREP_BAIT }
];

describe('hebra_grep: privacidad (D3)', () => {
  it('ninguna respuesta cambia por las notas que no se ven, página a página', async () => {
    for (const query of QUERIES) {
      for (const limit of [3, 100]) {
        const input = { ...query, limit };
        const seen = await allPages(withPrivate.ctx, input);
        const truth = await allPages(withoutPrivate.ctx, input);
        expect(seen, JSON.stringify(input)).toEqual(truth);
        expect(JSON.stringify(seen)).not.toContain(GREP_BAIT);
        expect(JSON.stringify(seen)).not.toContain('privados');
      }
    }
  });

  it('tampoco con cortes por tiempo: se corta en el mismo sitio con y sin ellas', async () => {
    for (const query of QUERIES.filter((entry) => entry.regex !== true)) {
      const input = { ...query, limit: 100 };
      const seen = await allPages(withPrivate.ctx, input, { timeBudgetMs: 0 });
      const truth = await allPages(withoutPrivate.ctx, input, { timeBudgetMs: 0 });
      expect(seen, JSON.stringify(input)).toEqual(truth);
    }
  });

  it('nunca lee el cuerpo de una oculta, bloqueada o de la papelera, ni la pasa al índice', async () => {
    const asked: number[] = [];
    const rows = await withPrivate.port.grepNotes();
    const hiddenRowids = rows.filter((row) => pair.privateIds.includes(row.id)).map((row) => row.rowid);
    expect(hiddenRowids.length).toBeGreaterThan(0);
    const port = withPrivate.port;
    const spy: ToolContext = {
      ...withPrivate.ctx,
      port: Object.assign(Object.create(Object.getPrototypeOf(port)), port, {
        grepBodies: (rowids: readonly number[], ...rest: [PrivacyConfig, GrepBodiesSession | null]) => {
          asked.push(...rowids);
          return port.grepBodies(rowids, ...rest);
        },
        grepCandidates: (match: string, rowids: readonly number[]) => {
          asked.push(...rowids);
          return port.grepCandidates(match, rowids);
        }
      })
    };
    for (const query of QUERIES) await allPages(spy, { ...query, limit: 5 });
    expect(asked.length).toBeGreaterThan(0);
    for (const rowid of hiddenRowids) expect(asked).not.toContain(rowid);
  });

  it('una nota que pasa a oculta entre dos lotes no sale: el filtro se rehace en el turno de la lectura', async () => {
    const path = await buildSmallLibrary(
      Array.from({ length: 70 }, (_, index) => `# Nota ${index}\ntérmino ${index}\n`)
    );
    const setup = openNodeSqliteConn(path);
    const diario = await (await SqliteLibraryEngine.open(setup.conn, 'grep-setup')).folderCreate(null, 'Diario');
    setup.db.close();
    const { ctx, port } = await grepContext(path, GREP_PRIVACY);
    // Otro escritor (como una ronda de sync) sobre el mismo fichero.
    const other = openNodeSqliteConn(path);
    const engine = await SqliteLibraryEngine.open(other.conn, 'grep-sync', { journalMode: 'WAL' });
    try {
      // Las tres últimas por id caen en el segundo lote (64 por lote).
      const ids = (await port.grepNotes()).map((row) => row.id).sort();
      const [moved, tagged, nested] = ids.slice(-3) as [string, string, string];
      let calls = 0;
      const spy: ToolContext = {
        ...ctx,
        port: Object.assign(Object.create(Object.getPrototypeOf(port)), port, {
          grepBodies: async (...args: unknown[]) => {
            const out = await (port.grepBodies as (...inner: unknown[]) => Promise<unknown>)(...args);
            calls += 1;
            if (calls === 1) {
              // Entre el primer lote y el segundo: una pasa a la carpeta privada y otra
              // gana `#secreto`.
              await engine.noteMove(moved, diario.id);
              // Y una tercera, a una subcarpeta privada que no existía al empezar.
              const nueva = await engine.folderCreate(diario.id, 'Nueva');
              await engine.noteMove(nested, nueva.id);
              const row = (await engine.noteRead(tagged))!;
              const body = '# Nota marcada\n#secreto\ntérmino secreto\n';
              const derived = deriveNote(body);
              await engine.noteSave({
                id: tagged,
                body,
                title: derived.title,
                titleNorm: derived.titleNorm,
                excerpt: derived.excerpt,
                expectedLocalSeq: row.localSeq,
                baseBodySha256: row.bodySha256,
                tags: derived.tags,
                links: derived.links,
                blobRefs: derived.blobRefs,
                props: derived.props
              });
            }
            return out;
          }
        })
      };
      const out = await runGrep(spy, { pattern: 'término', limit: 100 });
      expect(calls).toBe(2);
      const seen = out.matches.map((match) => match.id);
      expect(seen).toHaveLength(67);
      expect(seen).not.toContain(moved);
      expect(seen).not.toContain(nested);
      expect(seen).not.toContain(tagged);
      expect(JSON.stringify(out)).not.toContain('secreto');
    } finally {
      port.close();
      other.db.close();
    }
  });

  it('una carpeta o una etiqueta privadas dan lista vacía, como una inexistente', async () => {
    for (const filter of [
      { folder: 'Diario' },
      { folder: 'Diario/2026' },
      { folder: 'Diario', subfolders: true },
      { tag: 'secreto' },
      { tag: 'secreto/personal' },
      { folder: 'No existe' }
    ]) {
      expect(await runGrep(withPrivate.ctx, { pattern: 'garbanzos', ...filter })).toEqual({
        matches: [],
        nextCursor: null,
        cutoff: null
      });
    }
  });
});

describe('hebra_grep: resultados', () => {
  it('cada coincidencia: nota, línea, columna, texto, apartado y contexto', async () => {
    const out = await runGrep(withPrivate.ctx, {
      pattern: 'GARBANZOS secos',
      caseSensitive: true,
      contextLines: 1
    });
    expect(out.matches).toEqual([
      {
        id: pair.visibleIds.receta,
        title: 'Receta de garbanzos',
        isConflictCopy: false,
        line: 5,
        column: 3,
        text: '- GARBANZOS secos',
        before: ['- Garbanzos cocidos'],
        after: [''],
        heading: 'Ingredientes',
        headingOccurrence: 1
      }
    ]);
    expect(out.cutoff).toBeNull();
  });

  it('headingOccurrence: el apartado sirve tal cual en hebra_read_note aunque el título se repita', async () => {
    const path = await buildSmallLibrary(['# Doble\n\n## Dos\nuno\n\n## Dos\nbuscado aquí\n']);
    const { ctx, port } = await grepContext(path, { privateFolders: [], privateTags: [] });
    try {
      const [match] = (await runGrep(ctx, { pattern: 'buscado' })).matches;
      expect(match).toMatchObject({ line: 7, heading: 'Dos', headingOccurrence: 2 });
      const section = await runReadNote(ctx, {
        id: match!.id,
        heading: match!.heading!,
        headingOccurrence: match!.headingOccurrence!
      });
      expect(section.body).toBe('## Dos\nbuscado aquí\n');
      // La línea de un encabezado es de su propio apartado.
      const [title] = (await runGrep(ctx, { pattern: 'Doble' })).matches;
      expect(title).toMatchObject({ line: 1, heading: 'Doble', headingOccurrence: 1 });
    } finally {
      port.close();
    }
  });

  it('sin distinguir mayúsculas por defecto; las tildes cuentan', async () => {
    const lines = (await runGrep(withPrivate.ctx, { pattern: 'canción' })).matches.map(
      (match) => [match.id, match.line, match.heading]
    );
    // El frontmatter (líneas 1-3) también es cuerpo; «cancion» sin tilde no casa sola.
    expect(lines).toEqual([
      [pair.visibleIds.cancion, 2, null],
      [pair.visibleIds.cancion, 4, 'Canción'],
      [pair.visibleIds.cancion, 6, 'Canción']
    ]);
    const sensitive = await runGrep(withPrivate.ctx, { pattern: 'CANCIÓN', caseSensitive: true });
    expect(sensitive.matches.map((match) => match.line)).toEqual([6]);
  });

  it('\\r\\n: la línea sale sin el \\r y la numeración es la de la nota', async () => {
    const out = await runGrep(withPrivate.ctx, { pattern: 'linea con', contextLines: 5 });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      line: 3,
      text: 'linea con garbanzos',
      before: ['# Notas CRLF', ''],
      after: ['otra'],
      heading: 'Notas CRLF'
    });
  });

  it('una línea larga sale recortada alrededor de la coincidencia', async () => {
    const out = await runGrep(withPrivate.ctx, { pattern: 'garbanzos', folder: '' });
    const long = out.matches.find((match) => match.id === pair.visibleIds.larga)!;
    expect(long.column).toBe(502);
    expect(long.lineChars).toBe(1011);
    expect(long.text.length).toBe(300);
    expect(long.textStart).toBe(402);
    expect(long.text.slice(long.column - long.textStart!, long.column - long.textStart! + 9)).toBe(
      'garbanzos'
    );
  });

  it('las copias de conflicto visibles salen marcadas, como en hebra_search', async () => {
    const out = await runGrep(withPrivate.ctx, { pattern: 'Versión en conflicto' });
    expect(out.matches.map((match) => [match.id, match.isConflictCopy])).toEqual([
      [pair.visibleIds.conflictCopy, true]
    ]);
  });

  it('una nota bloqueada no se busca', async () => {
    expect((await runGrep(withPrivate.ctx, { pattern: 'hebra-locked' })).matches).toEqual([]);
  });

  it('entradas que no valen: invalid_input', async () => {
    for (const input of [
      { pattern: '' },
      { pattern: 'a'.repeat(1_001) },
      { pattern: 'dos\nlíneas' },
      { pattern: '(sin cerrar', regex: true },
      { pattern: 'x', contextLines: 6 },
      { pattern: 'x', cursor: 'n1.abc' },
      { pattern: 'x', cursor: `g1.${Buffer.from('[1,2]').toString('base64url')}` }
    ] as GrepInput[]) {
      await expect(runGrep(withPrivate.ctx, input)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('hebra_grep: paginación y cortes', () => {
  it('páginas pequeñas, cortes por tiempo y una sola página dan lo mismo, sin repetir ni saltar', async () => {
    for (const query of [{ pattern: 'garbanzo' }, { pattern: 'garbanzo \\d+', regex: true }]) {
      const whole = await runGrep(withPrivate.ctx, { ...query, limit: 100 });
      expect(whole.nextCursor).toBeNull();
      expect(whole.matches.length).toBeGreaterThanOrEqual(30);
      const small = flat(await allPages(withPrivate.ctx, { ...query, limit: 3 }));
      expect(small.map(where)).toEqual(whole.matches.map(where));
      expect(small).toEqual(whole.matches);
    }
    // Con plazo 0, cada página es una sola nota (la primera siempre se termina): corte
    // explícito y cursor que sigue en la siguiente.
    const pages = await allPages(withPrivate.ctx, { pattern: 'garbanzo', limit: 100 }, { timeBudgetMs: 0 });
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages.slice(0, -1)) {
      expect(page.cutoff).toBe('time');
      expect(page.nextCursor).not.toBeNull();
      expect(new Set(page.matches.map((match) => match.id)).size).toBeLessThanOrEqual(1);
    }
    expect(pages.at(-1)!.cutoff).toBeNull();
    const whole = await runGrep(withPrivate.ctx, { pattern: 'garbanzo', limit: 100 });
    expect(flat(pages)).toEqual(whole.matches);
  });

  it('la página llena mira una de más: sin nextCursor si no queda nada', async () => {
    const all = (await runGrep(withPrivate.ctx, { pattern: 'garbanzo', limit: 100 })).matches;
    const exact = await runGrep(withPrivate.ctx, { pattern: 'garbanzo', limit: all.length });
    expect(exact.matches).toHaveLength(all.length);
    expect(exact.nextCursor).toBeNull();
  });

  it('el cursor sigue aunque su nota ya no exista', async () => {
    const first = await runGrep(withoutPrivate.ctx, { pattern: 'garbanzo', limit: 1 });
    const cursorNote = first.matches[0]!.id;
    const rest = await allPages(withoutPrivate.ctx, {
      pattern: 'garbanzo',
      limit: 100,
      cursor: first.nextCursor!
    });
    expect(flat(rest).length).toBeGreaterThan(0);
    // Y con un id inventado entre medias: sigue por los de id mayor.
    const fake = `g1.${Buffer.from(JSON.stringify([`${cursorNote}~`, 0])).toString('base64url')}`;
    const after = await runGrep(withoutPrivate.ctx, { pattern: 'garbanzo', limit: 100, cursor: fake });
    expect(after.matches.every((match) => match.id > `${cursorNote}~`)).toBe(true);
  });
});

describe('hebra_grep: expresiones regulares caras', () => {
  it('una catastrófica no bloquea el bucle de eventos y se corta al plazo', async () => {
    const dir = await buildSmallLibrary([
      `# Trampa\n${'a'.repeat(40)}!\n`,
      '# Normal\naaa\n'
    ]);
    const { ctx, port } = await grepContext(dir, { privateFolders: [], privateTags: [] });
    try {
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 10);
      const started = Date.now();
      let error: unknown;
      // Las dos notas en el mismo lote: si la trampa va primero, ni una nota en el plazo
      // (`pattern_too_slow`); si va segunda, corte por tiempo con la primera hecha.
      const result = await runGrep(ctx, { pattern: '(a+)+$', regex: true }, { timeBudgetMs: 300 }).catch(
        (caught: unknown) => {
          error = caught;
          return null;
        }
      );
      const elapsed = Date.now() - started;
      clearInterval(ticker);
      expect(elapsed).toBeLessThan(1_500);
      // Unos 30 ticks de 10 ms en 300 ms: el bucle siguió vivo mientras la expresión corría.
      expect(ticks).toBeGreaterThanOrEqual(10);
      if (result) {
        expect(result.cutoff).toBe('time');
        expect(result.nextCursor).not.toBeNull();
        // Seguir desde ahí: la trampa es lo primero, ni una nota en el plazo.
        await expect(
          runGrep(ctx, { pattern: '(a+)+$', regex: true, cursor: result.nextCursor! }, { timeBudgetMs: 300 })
        ).rejects.toMatchObject({ code: 'pattern_too_slow' });
      } else {
        expect(error).toBeInstanceOf(ToolError);
        expect((error as ToolError).code).toBe('pattern_too_slow');
      }
      // Con un plazo normal, una expresión normal sobre la misma biblioteca va bien.
      expect((await runGrep(ctx, { pattern: 'a{3}$', regex: true })).matches).toHaveLength(1);
    } finally {
      port.close();
    }
  });
});

describe('hebra_grep: prefiltro de subcadena (H5)', () => {
  const PREFILTER_QUERIES: GrepInput[] = [
    { pattern: 'canción' },
    { pattern: 'CANCIÓN', caseSensitive: true },
    { pattern: 'GARBANZOS' },
    { pattern: 'Receta de pan' },
    { pattern: 'note/abc' },
    { pattern: '0000-garbanzos' },
    { pattern: 'foto garbanzos' },
    { pattern: 'sha256:abab' },
    { pattern: 'la otra' },
    { pattern: 'Garbanzos (cocidos|secos)', regex: true },
    { pattern: 'garbanzo \\d+$', regex: true },
    { pattern: 'mayúsculas\\. cancion', regex: true, caseSensitive: true }
  ];

  it('el mismo resultado con el índice que sin él (relleno sin terminar)', async () => {
    const withIndex: GrepOutput[][] = [];
    for (const query of PREFILTER_QUERIES) withIndex.push(await allPages(withoutPrivate.ctx, { ...query, limit: 7 }));
    // Sin la marca de completo, como a mitad del relleno: `hebra_grep` no usa el índice.
    const db = new DatabaseSync(pair.withoutPrivate);
    const marker = db.prepare("SELECT value FROM meta WHERE key = 'substring_index_version'").get() as {
      value: string;
    };
    db.prepare("DELETE FROM meta WHERE key = 'substring_index_version'").run();
    try {
      expect(await withoutPrivate.port.grepCandidates('body : "abc"', [1])).toBeNull();
      for (const [index, query] of PREFILTER_QUERIES.entries()) {
        const scanned = await allPages(withoutPrivate.ctx, { ...query, limit: 7 });
        expect(scanned, JSON.stringify(query)).toEqual(withIndex[index]);
        expect(flat(scanned).length, JSON.stringify(query)).toBeGreaterThan(0);
      }
    } finally {
      db.prepare("INSERT INTO meta(key, value) VALUES ('substring_index_version', ?)").run(marker.value);
      db.close();
    }
  });

  it('con una marca de otra versión del índice que la auditada, no se usa', async () => {
    const db = new DatabaseSync(pair.withoutPrivate);
    try {
      expect(await withoutPrivate.port.grepCandidates('body : "garbanzos"', [1])).not.toBeNull();
      db.prepare("UPDATE meta SET value = '2' WHERE key = 'substring_index_version'").run();
      expect(await withoutPrivate.port.grepCandidates('body : "garbanzos"', [1])).toBeNull();
      // Y el resultado es el del recorrido completo.
      expect((await runGrep(withoutPrivate.ctx, { pattern: 'Receta de pan' })).matches).toHaveLength(1);
    } finally {
      db.prepare("UPDATE meta SET value = '1' WHERE key = 'substring_index_version'").run();
      db.close();
    }
    expect(substringIndexUsable(1, 1)).toBe(true);
    expect(substringIndexUsable(2, 2)).toBe(false);
    expect(substringIndexUsable(1, 2)).toBe(false);
    expect(substringIndexUsable(1, 0)).toBe(false);
  });

  it('los vectores de texto visible de Hebra: lo que el índice no guarda sale como candidata', async () => {
    // Solo datos (`input`/`output` de `substringIndexText`), leídos del submódulo en tiempo
    // de test: ningún código de Hebra entra en este repo (D5).
    const vectors = (
      JSON.parse(
        readFileSync(
          join(process.cwd(), 'vendor/hebra/src/lib/library/cases/substring-index-text.json'),
          'utf8'
        )
      ) as { vectors: Array<{ name: string; input: string; output: string }> }
    ).vectors;
    expect(vectors.length).toBeGreaterThan(10);
    const path = await buildSmallLibrary(vectors.map((vector) => vector.input));
    const { port } = await grepContext(path, { privateFolders: [], privateTags: [] });
    try {
      const byBody = new Map<string, number>();
      for (const row of await port.grepNotes()) {
        const body = (await port.noteRead(row.id))!.body;
        byBody.set(body, row.rowid);
      }
      let checked = 0;
      for (const vector of vectors) {
        const rowid = byBody.get(vector.input)!;
        expect(rowid, vector.name).toBeDefined();
        const chars = [...vector.input];
        for (let from = 0; from < chars.length; from += 1) {
          for (let to = from + 3; to <= chars.length; to += 1) {
            const piece = chars.slice(from, to).join('');
            if (/[[\]|!\n]/.test(piece) || vector.output.includes(piece)) continue;
            for (const caseSensitive of [true, false]) {
              const match = trigramMatch(piece, caseSensitive);
              if (match === null) continue;
              checked += 1;
              const candidates = await port.grepCandidates(match, [rowid]);
              expect(candidates?.has(rowid), `${vector.name}: «${piece}»`).toBe(true);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    } finally {
      port.close();
    }
  });

  it('en un lector (solo lectura) da lo mismo: sus lecturas van en una transacción de lectura', async () => {
    const reader = await grepContext(pair.withoutPrivate, GREP_PRIVACY, 'readOnly');
    try {
      for (const query of PREFILTER_QUERIES) {
        expect(await allPages(reader.ctx, { ...query, limit: 7 }), JSON.stringify(query)).toEqual(
          await allPages(withoutPrivate.ctx, { ...query, limit: 7 })
        );
      }
    } finally {
      reader.port.close();
    }
  });

  it('una nota aún en la cola del índice se mira igual', async () => {
    const rowid = (await withoutPrivate.port.grepNotes()).find(
      (row) => row.id === pair.visibleIds.cocina
    )!.rowid;
    const before = await runGrep(withoutPrivate.ctx, { pattern: 'Garbanzos con' });
    expect(before.matches.map((match) => match.id)).toEqual([pair.visibleIds.cocina]);
    // Como si se acabara de guardar y nadie hubiera vaciado aún la cola (un lector la ve
    // así hasta que el escritor la vacía): fuera de `notes_trigram`, dentro de la cola.
    const db = new DatabaseSync(pair.withoutPrivate);
    try {
      db.prepare('DELETE FROM notes_trigram WHERE rowid = ?').run(rowid);
      db.prepare('INSERT INTO notes_trigram_pending(rowid) VALUES (?)').run(rowid);
      const hits = db
        .prepare(`SELECT count(*) AS c FROM notes_trigram WHERE notes_trigram MATCH 'body : "Garbanzos con"'`)
        .get() as { c: number | bigint };
      expect(Number(hits.c)).toBe(0);
    } finally {
      db.close();
    }
    expect(await runGrep(withoutPrivate.ctx, { pattern: 'Garbanzos con' })).toEqual(before);
  });

  it('con el índice, solo se leen las candidatas', async () => {
    const read: number[] = [];
    const port = withoutPrivate.port;
    const spy: ToolContext = {
      ...withoutPrivate.ctx,
      port: Object.assign(Object.create(Object.getPrototypeOf(port)), port, {
        grepBodies: (rowids: readonly number[], ...rest: [PrivacyConfig, GrepBodiesSession | null]) => {
          read.push(...rowids);
          return port.grepBodies(rowids, ...rest);
        }
      })
    };
    const out = await runGrep(spy, { pattern: 'canción' });
    expect(out.matches.length).toBe(3);
    // La de la canción y las que tienen algo que el índice no guarda tal cual (enlaces con
    // alias, `hebra://`, `[[id:…]]`, `sha256:`): no las 8 visibles.
    expect(new Set(read).size).toBeLessThan(Object.keys(VISIBLE_BODIES).length + 1);
  });
});

/** Una biblioteca pequeña nueva (índice completo desde el principio), con estas notas. */
async function buildSmallLibrary(bodies: readonly string[]): Promise<string> {
  const dir = join(pair.dir, `pequeña-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'library.sqlite');
  const { db, conn } = openNodeSqliteConn(path);
  const engine = await SqliteLibraryEngine.open(conn, 'grep-small');
  for (const body of bodies) await createNote(engine, null, body);
  db.close();
  return path;
}
