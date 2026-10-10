/**
 * AC5 de `hebra_replace_in_notes` (D14, SPEC.md §5): un `kill -9` a mitad de `apply` no
 * duplica nada, lo anotado dice qué entró, y repetir con el mismo `operationId` completa lo
 * pendiente. Con un proceso hijo REAL (`test/fixtures/replace-child.ts`) al que se mata con
 * SIGKILL justo después de escribir una nota y antes de anotarlo en el plan.
 *
 * 30 notas, un plan que las cambia todas, y otro escritor que edita 2 entre simular y
 * aplicar (copias de conflicto). El hijo muere tras escribir la 13.ª. Se repite en este
 * proceso y se comprueba: cada resultado UNA vez en la biblioteca, las dos ediciones ajenas
 * conservadas y el informe completo. Al final, deshacer devuelve las 28 a la semilla y manda
 * las dos copias a la papelera.
 *
 * Sabotaje: con `HEBRA_MCP_TEST_SABOTAJE=sin-ya-estaba`, el `apply` repetido se salta el paso
 * «ya estaba» (`skipAlreadyApplied`) y este test TIENE que salir rojo: la nota 13 sale como
 * copia de conflicto con su propio resultado, que queda dos veces.
 *
 * Los directorios van a `os.tmpdir()`; nunca la biblioteca real.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplaceApplyReport, ReplacePlanView } from '../../src/store/replace-batch';
import { LibraryInstance } from '../../src/sync/library-instance';
import { allNotes, createNote, noteState, OPEN, openWriter, query, removeTempDirs, tempDir } from './helpers';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundleDir = join(root, 'node_modules', '.cache', 'hebra-mcp-test');
const childPath = join(bundleDir, `replace-child-${process.pid}.mjs`);
const SABOTAGE = process.env.HEBRA_MCP_TEST_SABOTAJE === 'sin-ya-estaba';

const NOTES = 30;
/** Posiciones del plan que edita también otro escritor entre simular y aplicar. */
const BOTH = [5, 20];
/** El hijo muere tras escribir la nota de esta posición (la 13.ª). */
const STOP = 12;

beforeAll(async () => {
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test', 'fixtures', 'replace-child.ts')],
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'silent'
  });
});

afterAll(() => {
  rmSync(childPath, { force: true });
});

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

/** Lanza el hijo, espera a que diga `parado` y lo mata con SIGKILL. */
async function applyAndKill(dataDir: string, planId: string, operationId: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=2048', childPath, 'apply', dataDir, planId, operationId, String(STOP)],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let stdout = '';
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
    child.once('exit', (code, signal) => resolve(signal ?? code))
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el hijo no llegó a pararse: ${stdout}`)), 60_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('parado\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      if (!stdout.includes('parado\n')) reject(new Error(`el hijo salió sin pararse: ${stdout}`));
    });
  });
  child.kill('SIGKILL');
  expect(await exited).toBe('SIGKILL');
  return stdout;
}

async function withWriter<T>(dataDir: string, run: (instance: LibraryInstance) => Promise<T>): Promise<T> {
  const instance = await LibraryInstance.open({ dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
  try {
    return await run(instance);
  } finally {
    await instance.close();
  }
}

describe('apply cortado con kill -9 y repetido (AC5)', () => {
  it('nada duplicado, lo anotado dice qué entró y repetir completa lo pendiente', async () => {
    const dataDir = tempDir();
    const seeds = new Map<string, string>();
    const planId = await withWriter(dataDir, async (instance) => {
      for (let i = 0; i < NOTES; i += 1) {
        const body = `# Nota ${String(i).padStart(2, '0')}\n\nfoo ${i}\n`;
        seeds.set(await createNote(instance, body), body);
      }
      return undefined;
    }).then(async () => {
      const writer = await openWriter(dataDir);
      try {
        const plan = (await writer.call({ mode: 'simulate', pattern: 'foo', replacement: 'bar' })) as ReplacePlanView;
        expect(plan.planNotes).toBe(NOTES);
        return plan.planId!;
      } finally {
        await writer.instance.close();
      }
    });
    const order = query<{ note_id: string }>(
      dataDir,
      'SELECT note_id FROM hebra_mcp_replace_plan_notes WHERE plan_id = ? ORDER BY position',
      planId
    ).map((row) => row.note_id);
    const result = (id: string): string => seeds.get(id)!.replace('foo', 'bar');

    // Otro escritor toca 2 entre simular y aplicar.
    await withWriter(dataDir, async (instance) => {
      for (const position of BOTH) {
        await instance.appendToNote({ id: order[position]!, text: `OTRO-${position}`, privacy: OPEN });
      }
    });

    // Primer apply, en un hijo que muere con SIGKILL tras escribir la nota de STOP.
    const childOut = await applyAndKill(dataDir, planId, 'op-corte');
    expect(childOut).not.toContain('salida');
    // Lo anotado dice qué entró: las de antes de STOP, con su resultado; la de STOP está
    // escrita (y su base guardada) pero sin anotar; las de detrás, sin tocar.
    const rows = query<{ position: number; outcome: string | null; has_base: number }>(
      dataDir,
      `SELECT position, outcome, base_body IS NOT NULL AS has_base FROM hebra_mcp_replace_plan_notes
       WHERE plan_id = ? ORDER BY position`,
      planId
    );
    expect(rows.filter((row) => row.outcome !== null).map((row) => row.position)).toEqual(
      Array.from({ length: STOP }, (_, i) => i)
    );
    expect(rows[STOP]).toMatchObject({ outcome: null, has_base: 1 });
    expect(rows[5]!.outcome).toBe('conflict_copy');
    expect(noteState(dataDir, order[STOP]!).body).toBe(result(order[STOP]!));
    expect(noteState(dataDir, order[STOP + 1]!).body).toBe(seeds.get(order[STOP + 1]!));

    // Repetir con el mismo operationId completa lo pendiente.
    const report = await withWriter(dataDir, async (instance) => {
      const { result: again } = await instance.replaceInNotesLocal(
        { mode: 'apply', planId, operationId: 'op-corte', privacy: OPEN },
        SABOTAGE ? { skipAlreadyApplied: true } : {}
      );
      return again as ReplaceApplyReport;
    });

    // La biblioteca: cada resultado UNA vez; las dos ediciones ajenas conservadas.
    // (Antes que el informe: es la garantía que el sabotaje tiene que ver romperse.)
    const live = allNotes(dataDir).filter((row) => row.trashed_at === null);
    const copies = live.filter((row) => row.conflict_of !== null);
    for (const [position, id] of order.entries()) {
      // La línea entera, con sus saltos: «bar 2» también está dentro de «bar 20».
      const line = `\n${result(id).split('\n')[2]!}\n`;
      const withResult = live.filter((row) => row.body.includes(line));
      expect(withResult, `el resultado de la nota ${position} está ${withResult.length} veces`).toHaveLength(1);
      if (BOTH.includes(position)) {
        expect(noteState(dataDir, id).body).toContain(`OTRO-${position}`);
        expect(withResult[0]!.conflict_of).toBe(id);
        expect(withResult[0]!.body).toBe(result(id));
      } else {
        expect(withResult[0]!.id).toBe(id);
        expect(withResult[0]!.body).toBe(result(id));
      }
    }
    expect(copies).toHaveLength(BOTH.length);

    // El informe, completo y leído de lo guardado.
    expect(report.complete).toBe(true);
    expect(report.notes).toHaveLength(NOTES);
    const outcomes = new Map(report.notes.map((note) => [note.id, note.outcome]));
    expect(outcomes.get(order[STOP]!)).toBe('applied');
    for (const position of BOTH) expect(outcomes.get(order[position]!)).toBe('conflict_copy');
    expect([...outcomes.values()].filter((outcome) => outcome === 'applied')).toHaveLength(NOTES - BOTH.length);

    // Deshacer: las 28 vuelven a la semilla, las dos copias a la papelera, las ediciones
    // ajenas se quedan.
    await withWriter(dataDir, async (instance) => {
      await instance.replaceInNotesLocal({ mode: 'undo', planId, privacy: OPEN });
    });
    for (const [position, id] of order.entries()) {
      const body = noteState(dataDir, id).body;
      if (BOTH.includes(position)) expect(body).toContain(`OTRO-${position}`);
      else expect(body).toBe(seeds.get(id));
    }
    for (const copy of copies) expect(noteState(dataDir, copy.id).trashed_at).not.toBeNull();
  }, 120_000);
});
