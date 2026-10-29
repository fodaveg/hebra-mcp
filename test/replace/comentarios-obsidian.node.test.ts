/**
 * TRA-C01 (audit de Hebra, 19 oct): «al actualizar su copia de Hebra, `hebra_grep` y
 * `hebra_replace_in_notes` dejan de ver el texto dentro de `%%` (comentarios de Obsidian),
 * por el prefiltro `notes_trigram`». Regresión sobre una SQLite REAL con el índice completo
 * y marcado con la versión vigente (el estado de después de actualizar). Desde TRA-18,
 * Hebra indexa `search_body` (el cuerpo SIN los comentarios `%%…%%`): `notes_trigram` no
 * guarda el texto de los comentarios y la búsqueda por palabras no los ve, que es lo
 * querido. Aun así, `hebra_grep` y `hebra_replace_in_notes` (búsquedas literales sobre el
 * cuerpo) los encuentran: el prefiltro (`grepSubstringCandidates`) mira también el cuerpo
 * en bruto de las notas con comentarios.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { localWriteContext } from '../../src/server/serve';
import { runGrep } from '../../src/server/tools/grep';
import { trigramMatch } from '../../src/store/grep';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { LibraryInstance } from '../../src/sync/library-instance';
import { createNote, noteState, OPEN, openWriter, query, removeTempDirs, tempDir } from './helpers';

const instances: LibraryInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  vi.restoreAllMocks();
  removeTempDirs();
});

const COMMENTED = '# Con comentario\n\nTexto visible.\n%% zanahoriaoculta en un comentario %%\nFin.\n';
const MULTILINE = '# Bloque\n\n%%\nremolachaoculta\nen varias líneas\n%%\n';
const PLAIN = '# Otra\n\nNada que ver.\n';

async function setup(): Promise<{ dataDir: string; writer: Awaited<ReturnType<typeof openWriter>> }> {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const dataDir = tempDir();
  const writer = await openWriter(dataDir);
  instances.push(writer.instance);
  return { dataDir, writer };
}

describe('TRA-C01: el texto dentro de %% se encuentra con el índice completo', () => {
  it('el índice está completo y NO guarda el texto de los comentarios: se encuentra igual', async () => {
    const { dataDir, writer } = await setup();
    const id = await createNote(writer.instance, COMMENTED);
    await createNote(writer.instance, MULTILINE);
    await createNote(writer.instance, PLAIN);
    // Con la marca vigente `grepCandidates` devuelve un conjunto (con otra, `null`).
    const rows = await writer.instance.port.grepNotes();
    const rowid = rows.find((row) => row.id === id)!.rowid;
    const match = trigramMatch('zanahoriaoculta', false)!;
    const candidates = await writer.instance.port.grepCandidates(match, rows.map((row) => row.rowid));
    expect(candidates).not.toBeNull();
    expect([...candidates!]).toEqual([rowid]);
    // TRA-18: el índice guarda `search_body`, sin los comentarios. El texto del comentario
    // no está en `notes_trigram`… (0)…
    expect(
      query<{ c: number }>(
        dataDir,
        `SELECT count(*) AS c FROM notes_trigram WHERE notes_trigram MATCH 'body : "remolachaoculta"'`
      )[0]!.c
    ).toBe(0);
    // …y el índice sigue completo: lo VISIBLE sí está en él.
    expect(
      query<{ c: number }>(
        dataDir,
        `SELECT count(*) AS c FROM notes_trigram WHERE notes_trigram MATCH 'body : "Texto visible"'`
      )[0]!.c
    ).toBe(1);
  });

  it('hebra_grep, literal y regex, encuentra lo que solo está en un comentario', async () => {
    const { writer } = await setup();
    const id = await createNote(writer.instance, COMMENTED);
    const block = await createNote(writer.instance, MULTILINE);
    await createNote(writer.instance, PLAIN);
    const ctx = await resolveToolContext({
      port: writer.instance.port,
      privacyConfig: OPEN,
      status: new UnlinkedStatusSource(),
      write: localWriteContext(writer.instance)
    });
    const literal = await runGrep(ctx, { pattern: 'zanahoriaoculta' });
    expect(literal.matches.map((m) => [m.id, m.line])).toEqual([[id, 4]]);
    const regex = await runGrep(ctx, { pattern: 'zanahoria\\w+', regex: true });
    expect(regex.matches.map((m) => [m.id, m.line])).toEqual([[id, 4]]);
    const upper = await runGrep(ctx, { pattern: 'REMOLACHAOCULTA' });
    expect(upper.matches.map((m) => [m.id, m.line])).toEqual([[block, 4]]);
    const regexBlock = await runGrep(ctx, { pattern: 'remolacha\\w+$', regex: true });
    expect(regexBlock.matches.map((m) => [m.id, m.line])).toEqual([[block, 4]]);
  });

  it('hebra_replace_in_notes sustituye (simular y aplicar) lo que solo está en un comentario', async () => {
    const { dataDir, writer } = await setup();
    const id = await createNote(writer.instance, COMMENTED);
    const block = await createNote(writer.instance, MULTILINE);
    const plain = await createNote(writer.instance, PLAIN);

    const plan = (await writer.call({
      mode: 'simulate',
      pattern: 'zanahoriaoculta',
      replacement: 'ZANAHORIA'
    })) as { planId: string; planNotes: number; planMatches: number };
    expect(plan.planNotes).toBe(1);
    expect(plan.planMatches).toBe(1);
    await writer.call({ mode: 'apply', planId: plan.planId, operationId: 'op-tra-c01-literal-0001' });
    expect(noteState(dataDir, id).body).toBe(COMMENTED.replace('zanahoriaoculta', 'ZANAHORIA'));

    const regexPlan = (await writer.call({
      mode: 'simulate',
      pattern: 'remolacha(\\w+)',
      regex: true,
      replacement: 'nabo-$1'
    })) as { planId: string; planNotes: number };
    expect(regexPlan.planNotes).toBe(1);
    await writer.call({ mode: 'apply', planId: regexPlan.planId, operationId: 'op-tra-c01-regex-00002' });
    expect(noteState(dataDir, block).body).toBe(MULTILINE.replace('remolachaoculta', 'nabo-oculta'));
    expect(noteState(dataDir, plain).body).toBe(PLAIN);
  });
});
