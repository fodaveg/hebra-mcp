/**
 * Privacidad de `hebra_replace_in_notes` (D14, D3; SPEC.md §6.3): sobre la biblioteca doble
 * de `hebra_grep` (`test/fixtures/grep-library.ts`: la misma base con y sin siete notas
 * que no se pueden ver: carpeta privada, subcarpeta, etiqueta, etiqueta descendiente,
 * bloqueada, papelera y copia de conflicto de una privada, todas llenas del término), la
 * simulación, sus páginas, los cortes, el informe de aplicar y el de deshacer son
 * IDÉNTICOS en las dos (salvo el `planId`, que es aleatorio), y ninguna nota oculta se
 * toca. Una nota que pasa a oculta entre simular y aplicar no se toca ni se nombra.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy/config';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import {
  ReplaceBatch,
  type ReplacePlanView,
  type ReplaceRequest,
  type ReplaceResult
} from '../../src/store/replace-batch';
import { NoteWriter } from '../../src/store/writes';
import { privacyFingerprint } from '../../src/store/replace';
import { buildGrepLibraryPair, GREP_BAIT, GREP_PRIVACY, type GrepLibraryPair } from '../fixtures/grep-library';

const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };
const pairs: GrepLibraryPair[] = [];
const ports: NodeLibraryPort[] = [];

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  for (const pair of pairs.splice(0)) pair.close();
  vi.restoreAllMocks();
});

async function open(sqlitePath: string): Promise<{ port: NodeLibraryPort; batch: ReplaceBatch }> {
  const port = await openNodeLibraryPort({ sqlitePath, dataDir: join(sqlitePath, '..') });
  ports.push(port);
  return { port, batch: new ReplaceBatch(port, port) };
}

function bodies(sqlitePath: string, ids: readonly string[]): Map<string, string> {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return new Map(
      ids.map((id) => [id, (db.prepare('SELECT body FROM notes WHERE id = ?').get(id) as { body: string }).body])
    );
  } finally {
    db.close();
  }
}

/** La salida sin lo que es aleatorio: el `planId` (también dentro de los cursores de página)
 *  y `expiresAt`. */
function normalized(result: ReplaceResult): unknown {
  const planId = 'planId' in result ? result.planId : null;
  const text = JSON.stringify(result)
    .replace(/"rp1\.([A-Za-z0-9_-]+)"/g, (_, payload: string) =>
      JSON.stringify(`rp1:${Buffer.from(payload, 'base64url').toString('utf8')}`)
    )
    .split(planId ?? '\u0000')
    .join('PLAN')
    .replace(/"expiresAt":"[^"]+"/g, '"expiresAt":"EXP"');
  return JSON.parse(text);
}

/** Simula todo el ámbito por planes de `maxNotes`, con páginas de `limit`, aplica cada plan
 *  y lo deshace; devuelve todo lo que se vio, normalizado. */
async function walk(batch: ReplaceBatch, simulate: Extract<ReplaceRequest, { mode: 'simulate' }>): Promise<unknown[]> {
  const seen: unknown[] = [];
  let after: string | undefined;
  for (let round = 0; round < 20; round += 1) {
    const plan = (await batch.run({ ...simulate, ...(after ? { after } : {}) })).result as ReplacePlanView;
    seen.push(normalized(plan));
    let cursor = plan.nextCursor;
    while (cursor && plan.planId) {
      const page = (
        await batch.run({ mode: 'preview', planId: plan.planId, cursor, limit: simulate.limit, privacy: simulate.privacy })
      ).result as ReplacePlanView;
      seen.push(normalized(page));
      cursor = page.nextCursor;
    }
    if (plan.planId) {
      const operationId = `op-${round}`;
      seen.push(normalized((await batch.run({ mode: 'apply', planId: plan.planId, operationId, privacy: simulate.privacy })).result));
      seen.push(normalized((await batch.run({ mode: 'apply', planId: plan.planId, operationId, privacy: simulate.privacy })).result));
      seen.push(normalized((await batch.run({ mode: 'undo', planId: plan.planId, privacy: simulate.privacy })).result));
    }
    if (!plan.continueAfter) return seen;
    after = plan.continueAfter;
  }
  throw new Error('demasiadas vueltas');
}

describe('hebra_replace_in_notes no deja ver lo privado', () => {
  for (const [label, base] of [
    ['literal', { pattern: 'garbanzos', regex: false }],
    ['expresión regular', { pattern: 'garbanzos?|canci[oó]n', regex: true }]
  ] as const) {
    it(`${label}: simulación, páginas, cortes e informes idénticos con y sin las ocultas`, async () => {
      const pair = await buildGrepLibraryPair();
      pairs.push(pair);
      const privateBefore = bodies(pair.withPrivate, pair.privateIds);
      const simulate = {
        mode: 'simulate' as const,
        ...base,
        caseSensitive: false,
        replacement: 'CAMBIADO',
        scope: {},
        maxNotes: 2,
        limit: 1,
        privacy: GREP_PRIVACY
      };
      const a = await open(pair.withPrivate);
      const b = await open(pair.withoutPrivate);
      // Control: sin privados configurados, la simulación SÍ ve las ocultas y las dos copias
      // difieren; si no, que salgan iguales abajo no probaría nada.
      const control = { ...simulate, maxNotes: 200, limit: 200, privacy: OPEN };
      const openA = normalized((await a.batch.run(control)).result);
      const openB = normalized((await b.batch.run(control)).result);
      expect(openA).not.toEqual(openB);
      const withPrivate = await walk(a.batch, simulate);
      const withoutPrivate = await walk(b.batch, simulate);
      expect(withPrivate).toEqual(withoutPrivate);
      // Se vio algo de verdad: varios planes, páginas, informes con notas aplicadas.
      expect(withPrivate.length).toBeGreaterThan(6);
      expect(JSON.stringify(withPrivate)).toContain('"outcome":"applied"');
      expect(JSON.stringify(withPrivate)).toContain('"outcome":"restored"');
      const text = JSON.stringify(withPrivate);
      expect(text).not.toContain(GREP_BAIT);
      for (const id of pair.privateIds) expect(text).not.toContain(id);
      // Ninguna oculta se tocó.
      for (const port of ports) port.close();
      ports.length = 0;
      expect(bodies(pair.withPrivate, pair.privateIds)).toEqual(privateBefore);
      // Ni en los planes guardados con esta configuración (el de control, sin privados, sí
      // las tiene: es de otra configuración y no vale con esta).
      const db = new DatabaseSync(pair.withPrivate, { readOnly: true });
      try {
        const planned = (
          db
            .prepare(
              `SELECT n.note_id FROM hebra_mcp_replace_plan_notes n
               JOIN hebra_mcp_replace_plans p ON p.plan_id = n.plan_id WHERE p.privacy_sha256 = ?`
            )
            .all(privacyFingerprint(GREP_PRIVACY)) as Array<{ note_id: string }>
        ).map((row) => row.note_id);
        expect(planned.length).toBeGreaterThan(0);
        for (const id of pair.privateIds) expect(planned).not.toContain(id);
      } finally {
        db.close();
      }
    }, 60_000);
  }

  it('una nota que pasa a oculta entre simular y aplicar no se toca ni se nombra', async () => {
    const pair = await buildGrepLibraryPair();
    pairs.push(pair);
    const { port, batch } = await open(pair.withPrivate);
    const privacy = GREP_PRIVACY;
    const plan = (
      await batch.run({
        mode: 'simulate',
        pattern: 'garbanzos',
        regex: false,
        caseSensitive: false,
        replacement: 'CAMBIADO',
        scope: {},
        maxNotes: 200,
        limit: 200,
        privacy
      })
    ).result as ReplacePlanView;
    const { larga, cancion, receta } = pair.visibleIds;
    expect(plan.notes.map((note) => note.id)).toEqual(expect.arrayContaining([larga, cancion, receta]));

    // Entre simular y aplicar: `larga` va a la carpeta privada y `cancion` gana una etiqueta
    // privada (otro escritor, sin privados).
    const writer = new NoteWriter(port);
    const diario = (await port.foldersList()).folders.find((folder) => folder.name === 'Diario')!.id;
    await writer.organize({ action: 'moveNote', id: larga, folderId: diario, privacy: OPEN });
    await writer.appendToNote({ id: cancion, text: '#secreto', privacy: OPEN });
    const before = bodies(pair.withPrivate, [larga, cancion]);

    const report = (await batch.run({ mode: 'apply', planId: plan.planId!, operationId: 'op-h', privacy })).result;
    const text = JSON.stringify(report);
    for (const id of [larga, cancion]) expect(text).not.toContain(id);
    expect(text).not.toContain('Larga');
    expect(text).not.toContain('Canción');
    expect(text).toContain(receta);
    expect(bodies(pair.withPrivate, [larga, cancion])).toEqual(before);
    expect(bodies(pair.withPrivate, [receta]).get(receta)).toContain('CAMBIADO');

    // Tampoco en las páginas del plan ni al deshacer.
    const cursor = `rp1.${Buffer.from(JSON.stringify([plan.planId, 0])).toString('base64url')}`;
    const page = (await batch.run({ mode: 'preview', planId: plan.planId!, cursor, limit: 200, privacy })).result;
    const undo = (await batch.run({ mode: 'undo', planId: plan.planId!, privacy })).result;
    for (const id of [larga, cancion]) {
      expect(JSON.stringify(page)).not.toContain(id);
      expect(JSON.stringify(undo)).not.toContain(id);
    }
    expect(bodies(pair.withPrivate, [larga, cancion])).toEqual(before);
  }, 60_000);
});
