/**
 * D25 (9 nov 2026, RT-4 de Hebra, §27.3 punto 5 y §27.7): en las notas de un ESPACIO
 * compartido, una edición de hebra-mcp que coincide con otro cambio ya no deja una copia de
 * conflicto: el motor (`noteSave` de `SqliteLibraryEngine`, `vendor/hebra`) combina el texto
 * que leyó la herramienta (`baseBody`) con el actual y responde `merged`. Aquí se prueba lo
 * que hace hebra-mcp: pasar `baseBody` por las cuatro vías que guardan cuerpos y entender
 * la respuesta. La combinación en sí es del motor (sus casos: `space-sync-cases.json`).
 *
 * Bases de espacio REALES del motor (`openNodeLibraryPort` con `spaceAccess` y un vínculo de
 * sync), en directorios temporales. «Otro escritor cambió la nota por debajo» se hace con
 * una página remota de verdad (`syncApplyPage`) entre la lectura y el guardado.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteSaveInput, NoteSaveResult } from '../../src/hebra';
import { ReplaceBatch, type ReplaceApplyReport, type ReplacePlanView } from '../../src/store/replace-batch';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { encodeRevision } from '../../src/store/revision';
import { NoteWriter, type NoteWriteStore, type NoteWriteTarget } from '../../src/store/writes';
import type { SyncStorePort } from '../../src/store/sync-port';
import { NO_PRIVATE } from '../fixtures/no-private';
import { IDENTITY } from '../sync/devices';

const ID = 'shared-note';
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Un cuerpo con tres párrafos largos y separados: los parches de cada uno caben sin tocarse. */
const P1 = 'Primer párrafo de la nota compartida, con texto de sobra para que su contexto no se toque.';
const P2 = 'Segundo párrafo, que ningún escritor cambia en estas pruebas y sirve de separación larga.';
const P3 = 'Tercer párrafo, el que cambia el otro miembro desde su cliente mientras el agente edita.';
const BASE = `# Nota\n\n${P1}\n\n${P2}\n\n${P3}\n`;

interface Env {
  port: NodeLibraryPort;
  sqlitePath: string;
  writer: NoteWriter;
  /** Aplica una página remota que deja la nota con `body` (rev creciente). */
  remote(body: string): Promise<void>;
  /** `ydoc` guardado de la nota, o `null`. */
  ydoc(id?: string): Uint8Array | null;
  copies(): string[];
}

/** Una biblioteca de espacio con la nota `shared-note` ya bajada con `BASE` (o `body`). */
async function openSpace(shared = true, body = BASE): Promise<Env> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-space-merge-'));
  directories.push(directory);
  const sqlitePath = join(directory, 'library.sqlite');
  const spaceAccess = { spaceId: '955480b0-c2c3-471f-aa5d-3f37ed46fe68', scope: 'fixture', authorize: async () => {}, assertActive: () => {} };
  const port = await openNodeLibraryPort({ sqlitePath, ...(shared ? { spaceAccess } : {}) });
  ports.push(port);
  await port.syncStorePort().libraryConnect({
    binding: { ...IDENTITY, libraryInstance: 'space-merge-test' }, relayHasRecords: true
  });
  let rev = 0;
  const page = (text: string): Parameters<SyncStorePort['syncApplyPage']>[0] => {
    rev += 1;
    return [{
      id: ID, rev, minClient: 2, deleted: false, plaintextHash: `fixture-${rev}`,
      fields: {
        kind: 'note', folderId: 'root', body: text, favorite: false,
        createdAt: 1, updatedAt: rev, trashedAt: null, conflictOf: null,
        conflictAt: null, conflictDevice: null
      }
    }];
  };
  const env: Env = {
    port, sqlitePath, writer: new NoteWriter(port),
    remote: async (text) => { await port.syncStorePort().syncApplyPage(page(text)); },
    ydoc: (id = ID) => {
      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        const row = db.prepare('SELECT ydoc FROM notes WHERE id = ?').get(id) as { ydoc: Uint8Array | null } | undefined;
        return row?.ydoc ?? null;
      } finally { db.close(); }
    },
    copies: () => {
      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        return (db.prepare('SELECT id FROM notes WHERE conflict_of = ?').all(ID) as Array<{ id: string }>).map((row) => row.id);
      } finally { db.close(); }
    }
  };
  await env.remote(body);
  return env;
}

async function revisionOf(port: NodeLibraryPort, id = ID): Promise<string> {
  const note = (await port.noteRead(id))!;
  return encodeRevision({ libraryId: await port.libraryId(), noteId: id, localSeq: note.localSeq, bodySha256: note.bodySha256 });
}

/** El escritor, con la lectura de la nota FIJADA a `stale` en el turno: la herramienta leyó
 *  esa versión y, antes de guardar, llegó otra página (así se junta «lo que leyó» con «lo
 *  que hay», que dentro de un turno exclusivo no se separan solas). Devuelve también lo que
 *  respondió el motor a `noteSave`. */
function staleReader(port: NodeLibraryPort, stale: Awaited<ReturnType<NodeLibraryPort['noteRead']>>) {
  const engineResults: NoteSaveResult[] = [];
  const inputs: NoteSaveInput[] = [];
  let first = true;
  const target: NoteWriteTarget = {
    writeExclusive: (operation) =>
      port.writeExclusive((store) => {
        const wrapped: NoteWriteStore = Object.create(store);
        wrapped.noteRead = async (id) => {
          if (first && id === ID) { first = false; return stale; }
          return store.noteRead(id);
        };
        wrapped.noteSave = async (input) => {
          inputs.push(input);
          const result = await store.noteSave(input);
          engineResults.push(result);
          return result;
        };
        return operation(wrapped);
      })
  };
  return { writer: new NoteWriter(target), engineResults, inputs };
}

describe('hebra_edit_note en una nota de espacio (D25)', () => {
  it('con otro cambio llegado por debajo: merged, los dos cambios en la misma nota y sin copia', async () => {
    const env = await openSpace();
    const stale = await env.port.noteRead(ID);
    const revision = await revisionOf(env.port);
    await env.remote(BASE.replace(P3, `${P3} (cambio del otro miembro)`));
    const { writer, engineResults, inputs } = staleReader(env.port, stale);

    const result = await writer.editNote({
      id: ID, edits: [{ find: 'Primer párrafo', replace: 'Primer párrafo EDITADO' }],
      expectedRevision: revision, operationId: 'op-merge', privacy: NO_PRIVATE
    });

    expect(inputs[0]!.baseBody).toBe(BASE);
    expect(engineResults[0]!.outcome).toBe('merged');
    expect(result.outcome).toBe('merged');
    const saved = (await env.port.noteRead(ID))!;
    expect(saved.body).toContain('Primer párrafo EDITADO');
    expect(saved.body).toContain('(cambio del otro miembro)');
    if (result.outcome === 'merged') {
      expect(result.revision).toBe(await revisionOf(env.port));
      expect(result.totalChars).toBe(saved.body.length);
      expect(result.applied).toHaveLength(1);
    }
    expect(env.copies()).toEqual([]);
    expect(env.ydoc()).not.toBeNull();
  });

  it('un reintento con el mismo operationId devuelve lo guardado como merged, sin volver a escribir', async () => {
    const env = await openSpace();
    const stale = await env.port.noteRead(ID);
    const revision = await revisionOf(env.port);
    await env.remote(BASE.replace(P3, `${P3} (otro)`));
    const { writer } = staleReader(env.port, stale);
    const input = {
      id: ID, edits: [{ find: 'Primer párrafo', replace: 'Primer párrafo EDITADO' }],
      expectedRevision: revision, operationId: 'op-retry', privacy: NO_PRIVATE
    };
    const first = await writer.editNote(input);
    const again = await new NoteWriter(env.port).editNote(input);
    expect(first.outcome).toBe('merged');
    expect(again).toMatchObject({ outcome: 'merged', replayed: true });
  });

  it('con un parche que no encaja (otro escritor tocó lo mismo): la copia de siempre, con su motivo', async () => {
    const env = await openSpace();
    const stale = await env.port.noteRead(ID);
    const revision = await revisionOf(env.port);
    await env.remote(BASE.replace('Primer párrafo', 'Primer párrafo REESCRITO POR OTRO'));
    const { writer, engineResults } = staleReader(env.port, stale);

    const result = await writer.editNote({
      id: ID, edits: [{ find: 'Primer párrafo', replace: 'Primer párrafo EDITADO' }],
      expectedRevision: revision, operationId: 'op-copy', privacy: NO_PRIVATE
    });

    const engine = engineResults[0]!;
    expect(engine.outcome).toBe('redirected');
    if (engine.outcome === 'redirected') expect(engine.spaceReason).toBe('rebase_failed');
    expect(result.outcome).toBe('conflict_copy');
    expect(env.copies()).toHaveLength(1);
    expect((await env.port.noteRead(ID))!.body).toContain('REESCRITO POR OTRO');
  });

  it('en una nota bloqueada no hay ydoc ni combinación: lo de siempre', async () => {
    const locked = 'hebra-locked:v1:eyJ2IjoxLCJraWQiOiI0MDQxNDI0MzQ0NDU0NjQ3NDg0OTRhNGI0YzRkNGU0ZiIsImtkZiI6eyJhbGciOiJwYmtkZjItc2hhMjU2IiwiaXRlciI6NjAwMDAwLCJzYWx0IjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyJ9LCJ3cmFwcGVkS2V5IjoiRUJFU0V4UVZGaGNZR1JvYmtnQmY0Ql9JX3k3SGVnNkhZdmlTblVJOGpFd3Z1QUx2U3lLVThCdi1aNUtUMzRSUGUyWGJyU09XbU1TODdOb20iLCJ0aXRsZSI6IiIsImJsb2JSZWZzIjpbXX0.YGFiY2RlZmdoaWprxNEDSQd5xHO5PU_6WbAh8Q';
    const env = await openSpace(true, locked);
    const note = (await env.port.noteRead(ID))!;
    expect(note.body).toBe(locked);
    // El MCP nunca escribe una nota bloqueada (`note_locked`)...
    await expect(env.writer.editNote({
      id: ID, edits: [{ find: 'x', replace: 'y' }], expectedRevision: await revisionOf(env.port),
      operationId: 'op-locked', privacy: NO_PRIVATE
    })).rejects.toMatchObject({ code: 'note_locked' });
    // ...y si el motor la guarda con `baseBody` (otro llamador), no entra `ydoc`.
    const saved = await env.port.noteSave({
      ...(await import('../../src/store/writes')).saveInputFor(note, locked, { localSeq: note.localSeq, bodySha256: note.bodySha256, baseBody: locked })
    });
    expect(saved.outcome).toBe('saved');
    expect(env.ydoc()).toBeNull();
    expect(env.copies()).toEqual([]);
  });

  it('en la biblioteca personal, con o sin baseBody: la copia de siempre', async () => {
    for (const withBase of [true, false]) {
      const env = await openSpace(false);
      const stale = await env.port.noteRead(ID);
      const revision = await revisionOf(env.port);
      await env.remote(BASE.replace(P3, `${P3} (otro)`));
      // `withBase: false` es un llamador que no manda el texto de la base.
      const target: NoteWriteTarget = {
        writeExclusive: (operation) => env.port.writeExclusive((store) => {
          const wrapped: NoteWriteStore = Object.create(store);
          let first = true;
          wrapped.noteRead = async (id) => (first && id === ID ? ((first = false), stale) : store.noteRead(id));
          wrapped.noteSave = async (input) => {
            const { baseBody: _dropped, ...rest } = input;
            return store.noteSave(withBase ? input : rest);
          };
          return operation(wrapped);
        })
      };
      const result = await new NoteWriter(target).editNote({
        id: ID, edits: [{ find: 'Primer párrafo', replace: 'Primer párrafo EDITADO' }],
        expectedRevision: revision, operationId: `op-personal-${withBase}`, privacy: NO_PRIVATE
      });
      expect(result.outcome, `withBase=${withBase}`).toBe('conflict_copy');
      expect(env.copies(), `withBase=${withBase}`).toHaveLength(1);
      expect(env.ydoc(), `withBase=${withBase}`).toBeNull();
      expect((await env.port.noteRead(ID))!.body).toContain('(otro)');
      expect((await env.port.noteRead(ID))!.body).not.toContain('EDITADO');
    }
  });
});

describe('hebra_append_to_note en una nota de espacio (D25)', () => {
  it('manda baseBody y guarda el ydoc; sin cambio por debajo, saved', async () => {
    const env = await openSpace();
    const result = await env.writer.appendToNote({ id: ID, text: 'Añadido por el agente.', privacy: NO_PRIVATE });
    expect(result.outcome).toBe('saved');
    expect((await env.port.noteRead(ID))!.body).toBe(`${BASE}\n\nAñadido por el agente.`);
    expect(env.ydoc()).not.toBeNull();
  });

  it('si la lectura quedó atrás (otra página llegó antes de guardar): merged, el texto añadido sale en la prueba', async () => {
    const env = await openSpace();
    const stale = await env.port.noteRead(ID);
    await env.remote(BASE.replace(P1, `${P1} (otro)`));
    const { writer, engineResults } = staleReader(env.port, stale);
    const result = await writer.appendToNote({ id: ID, text: 'Añadido por el agente.', privacy: NO_PRIVATE });
    expect(engineResults[0]!.outcome).toBe('merged');
    expect(result).toMatchObject({ outcome: 'merged' });
    const body = (await env.port.noteRead(ID))!.body;
    expect(body).toContain('(otro)');
    expect(body.endsWith('Añadido por el agente.')).toBe(true);
    if (result.outcome === 'merged') {
      expect(result.totalChars).toBe(body.length);
      expect(result.appended).toMatchObject({ chars: 22, tail: 'Añadido por el agente.' });
    }
    expect(env.copies()).toEqual([]);
  });
});

describe('hebra_restore_version en una nota de espacio (D25)', () => {
  it('con la nota cambiada por debajo: merged', async () => {
    const env = await openSpace();
    // Una versión anterior: el cuerpo base, capturado al cambiar la nota.
    await env.remote(BASE.replace(P1, `${P1} (v2)`));
    const versionId = await new Promise<number>((resolve, reject) => {
      const db = new DatabaseSync(env.sqlitePath, { readOnly: true });
      try {
        const row = db.prepare('SELECT id FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1').get(ID) as { id: number } | undefined;
        row ? resolve(Number(row.id)) : reject(new Error('sin versión'));
      } finally { db.close(); }
    });
    const stale = await env.port.noteRead(ID);
    const revision = await revisionOf(env.port);
    await env.remote(BASE.replace(P1, `${P1} (v2)`).replace(P3, `${P3} (otro)`));
    const { writer, engineResults } = staleReader(env.port, stale);

    const result = await writer.restoreVersion({
      id: ID, versionId, expectedRevision: revision, operationId: 'op-restore', privacy: NO_PRIVATE
    });

    expect(engineResults[0]!.outcome).toBe('merged');
    expect(result.outcome).toBe('merged');
    const body = (await env.port.noteRead(ID))!.body;
    expect(body).toContain('(otro)');
    expect(body).not.toContain('(v2)');
    expect(env.copies()).toEqual([]);
  });
});

describe('hebra_replace_in_notes en una nota de espacio (D25)', () => {
  async function simulate(env: Env, replacement: string): Promise<ReplacePlanView & { planId: string }> {
    const batch = new ReplaceBatch(env.port, env.port);
    const { result } = await batch.run({
      mode: 'simulate', pattern: 'Primer párrafo', regex: false, caseSensitive: true, replacement,
      scope: { ids: [ID] }, maxNotes: 10, limit: 10, privacy: NO_PRIVATE
    });
    return result as ReplacePlanView & { planId: string };
  }
  const apply = async (env: Env, planId: string, operationId: string): Promise<ReplaceApplyReport> =>
    (await new ReplaceBatch(env.port, env.port).run({ mode: 'apply', planId, operationId, privacy: NO_PRIVATE })).result as ReplaceApplyReport;

  it('cambió entre la simulación y la aplicación: merged, informe con la prueba de lo guardado y vuelta atrás al cuerpo previo', async () => {
    const env = await openSpace();
    const plan = await simulate(env, 'Primer párrafo EDITADO');
    expect(plan.planId).toBeTruthy();
    await env.remote(BASE.replace(P3, `${P3} (otro)`));
    const before = (await env.port.noteRead(ID))!;

    const report = await apply(env, plan.planId, 'op-replace');

    expect(report.complete).toBe(true);
    expect(report.notes).toHaveLength(1);
    const entry = report.notes[0]!;
    expect(entry.outcome).toBe('merged');
    const saved = (await env.port.noteRead(ID))!;
    expect(saved.body).toContain('Primer párrafo EDITADO');
    expect(saved.body).toContain('(otro)');
    expect(entry).toMatchObject({ totalChars: saved.body.length, bodySha256: saved.bodySha256 });
    expect(entry.copyId).toBeUndefined();
    expect(env.copies()).toEqual([]);

    // Un `apply` repetido con el mismo operationId no vuelve a escribir.
    const again = await apply(env, plan.planId, 'op-replace');
    expect(again.notes[0]!.outcome).toBe('merged');
    expect((await env.port.noteRead(ID))!.localSeq).toBe(saved.localSeq);

    // Deshacer devuelve el cuerpo que tenía la nota ANTES de la combinación (con el cambio
    // del otro miembro), no la base simulada.
    const undone = (await new ReplaceBatch(env.port, env.port).run({ mode: 'undo', planId: plan.planId, privacy: NO_PRIVATE })).result;
    expect(undone).toMatchObject({ mode: 'undo', complete: true, notes: [{ id: ID, outcome: 'restored' }] });
    expect((await env.port.noteRead(ID))!.body).toBe(before.body);
  });

  it('si el cambio de por debajo toca lo mismo: conflict_copy como siempre', async () => {
    const env = await openSpace();
    const plan = await simulate(env, 'Primer párrafo EDITADO');
    await env.remote(BASE.replace('Primer párrafo', 'Primer párrafo REESCRITO POR OTRO'));
    const report = await apply(env, plan.planId, 'op-replace-copy');
    expect(report.notes[0]!.outcome).toBe('conflict_copy');
    expect(report.notes[0]!.copyId).toBeTruthy();
    expect((await env.port.noteRead(ID))!.body).toContain('REESCRITO POR OTRO');
  });

  it('en la biblioteca personal la nota cambiada por debajo sigue dando conflict_copy', async () => {
    const env = await openSpace(false);
    const plan = await simulate(env, 'Primer párrafo EDITADO');
    await env.remote(BASE.replace(P3, `${P3} (otro)`));
    const report = await apply(env, plan.planId, 'op-replace-personal');
    expect(report.notes[0]!.outcome).toBe('conflict_copy');
    expect(env.copies()).toHaveLength(1);
  });

  it('el texto de la base solo se guarda en el plan de un espacio', async () => {
    for (const shared of [true, false]) {
      const env = await openSpace(shared);
      const plan = await simulate(env, 'X');
      const db = new DatabaseSync(join(env.sqlitePath, '..', 'replace-plans.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT sim_base_body FROM hebra_mcp_replace_plan_notes WHERE plan_id = ?').get(plan.planId) as { sim_base_body: string | null };
        expect(row.sim_base_body, `shared=${shared}`).toBe(shared ? BASE : null);
      } finally { db.close(); }
    }
  });
});
