/**
 * AC5 de los ficheros de trabajo (SPEC.md §13.8): la prueba H1 de la sonda de Hebra
 * (`scripts/sonda-d/medir-h1.sh`) pasada a vitest, con un proceso hijo REAL
 * (`test/fixtures/workdir-child.ts`) al que se mata con SIGKILL a mitad del `apply`.
 *
 * 400 notas sintéticas en 4 carpetas; `checkout --all`; 40 editadas con escritura normal
 * de fichero; otro escritor edita 2 de esas 40 entre el checkout y el apply. El hijo
 * escribe la nota 15 (índice 14) y muere ANTES de poner al día sus metadatos: el hueco
 * en el que, sin el paso «ya estaba», repetir el `apply` la tomaría por un conflicto y
 * dejaría una copia duplicada. Después se repite el `apply` en este proceso y se comprueba:
 * nada duplicado, todo dentro, las dos ediciones de los conflictos conservadas y el diario
 * diciendo qué entró. Al final, deshacer los dos lotes deja las 38 como la semilla.
 *
 * Sabotaje: con `HEBRA_MCP_TEST_SABOTAJE=sin-ya-estaba` el `apply` repetido se salta ese
 * paso (`skipAlreadyApplied`) y este test TIENE que salir rojo (una copia de más con la
 * edición de la nota 15).
 *
 * Los directorios van a `os.tmpdir()`; nunca la biblioteca real.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, checkoutCommand, statusCommand, undoCommand } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { capture, createFolder, createNote, OPEN, opener, removeTempDirs, tempDir, withWriter } from './helpers';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundleDir = join(root, 'node_modules', '.cache', 'hebra-mcp-test');
const childPath = join(bundleDir, `workdir-child-${process.pid}.mjs`);
const SABOTAGE = process.env.HEBRA_MCP_TEST_SABOTAJE === 'sin-ya-estaba';

const NOTES = 400;
const EDITED = 40;
/** Posiciones (en el orden del apply) que edita también otro escritor. */
const BOTH = [5, 30];
/** El hijo muere tras escribir esta (la 15.ª). */
const STOP = 14;

beforeAll(async () => {
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test', 'fixtures', 'workdir-child.ts')],
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
async function applyAndKill(dataDir: string, cwd: string): Promise<string> {
  const child = spawn(process.execPath, ['--max-old-space-size=2048', childPath, 'apply', dataDir, cwd, String(STOP), '0'], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
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

describe('apply cortado con kill -9 y repetido (AC5, H1)', () => {
  it('nada duplicado, todo dentro, las dos ediciones de los conflictos y el diario dice qué entró', async () => {
    const dataDir = tempDir();
    const seeds = new Map<string, string>();
    await withWriter(dataDir, async (writer) => {
      const folders = [];
      for (const name of ['Alfa', 'Beta', 'Gamma', 'Delta']) folders.push(await createFolder(writer, name));
      for (let i = 0; i < NOTES; i += 1) {
        const body = `# Nota ${String(i).padStart(3, '0')}\n\nCuerpo de la nota ${i}.\n\n- tarea ${i}\n`;
        seeds.set(await createNote(writer, body, folders[i % folders.length]), body);
      }
    });

    const cwd = tempDir();
    const checkout = capture(cwd);
    expect(
      await checkoutCommand(checkout.io, opener(dataDir), {
        dir: 'trabajo',
        all: true,
        consultas: [],
        titulos: [],
        carpetas: [],
        forzar: false
      })
    ).toBe(0);
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const files = workdir.listMarkdown();
    expect(files).toHaveLength(NOTES);
    const idOf = new Map(workdir.readCheckout().notas.map((entry) => [entry.ruta, entry.id]));

    // 40 editadas (en el orden en que las devuelve apply), con escritura normal de fichero.
    const picked = files.filter((_, index) => index % (NOTES / EDITED) === 0);
    expect(picked).toHaveLength(EDITED);
    const ids = picked.map((ruta) => idOf.get(ruta)!);
    const edited = new Map<string, string>();
    for (const [index, ruta] of picked.entries()) {
      const body = `${readFileSync(workdir.notePath(ruta), 'utf8')}\nEDIT-${ids[index]}\n`;
      writeFileSync(workdir.notePath(ruta), body);
      edited.set(ids[index], body);
    }
    // Otro escritor toca 2 de ellas en la biblioteca entre el checkout y el apply.
    await withWriter(dataDir, async (writer) => {
      for (const index of BOTH) {
        await writer.appendToNote({ id: ids[index], text: `OTRO-${ids[index]}`, privacy: OPEN });
      }
    });

    // Primer apply, en un proceso hijo que muere con SIGKILL tras escribir la nota 15.
    const childOut = await applyAndKill(dataDir, cwd);
    expect(childOut).not.toContain('salida');
    const [firstLote] = workdir.lotes();
    const firstJournal = workdir.readJournal(firstLote);
    expect(firstJournal.filter((entry) => entry.paso === 'intento')).toHaveLength(STOP + 1);
    expect(firstJournal.filter((entry) => entry.paso === 'hecho')).toHaveLength(STOP);
    const lastAttempt = firstJournal.filter((entry) => entry.paso === 'intento').at(-1)!;
    expect(lastAttempt).toMatchObject({ id: ids[STOP] });
    // La nota 15 entró en la biblioteca aunque sus metadatos no se pusieron al día.
    expect(await withWriter(dataDir, async (writer) => (await writer.port.noteRead(ids[STOP]))?.body)).toBe(
      edited.get(ids[STOP])
    );
    const status = capture(cwd);
    statusCommand(status.io, { dir: 'trabajo', rutas: false });
    // La 15.ª (escrita, sin metadatos) y las 25 de detrás; la 6.ª quedó en conflicto.
    expect(status.text()).toContain(`${EDITED - STOP} editadas sin devolver`);
    expect(status.text()).toContain('1 en conflicto');

    // Repetir completa lo pendiente.
    const again = capture(cwd);
    await applyCommand(again.io, opener(dataDir, {}, SABOTAGE ? { skipAlreadyApplied: true } : undefined), {
      dir: 'trabajo',
      conflicto: 'copia',
      simular: false
    });
    // La biblioteca: cada edición UNA vez, las dos ediciones de los conflictos conservadas.
    // (Antes que el diario: es la garantía que el sabotaje tiene que ver romperse.)
    const library = await withWriter(dataDir, async (writer) => {
      const rows = [];
      for (const kind of ['all', 'conflicts'] as const) {
        let cursor: string | null = null;
        do {
          const page = await writer.port.notesPage(cursor, 200, { kind });
          for (const item of page.items) rows.push(await writer.port.noteRead(item.id));
          cursor = page.nextCursor;
        } while (cursor);
      }
      const unique = new Map(rows.filter((row) => row !== null).map((row) => [row!.id, row!]));
      return [...unique.values()].filter((row) => row.trashedAt === null);
    });
    const copies = library.filter((row) => row.conflictOf !== null);
    expect(copies).toHaveLength(BOTH.length);
    for (const [index, id] of ids.entries()) {
      const withEdit = library.filter((row) => row.body.includes(`EDIT-${id}`));
      expect(withEdit, `la edición de la nota ${index} está ${withEdit.length} veces`).toHaveLength(1);
      if (BOTH.includes(index)) {
        const original = library.find((row) => row.id === id)!;
        expect(original.body).toContain(`OTRO-${id}`);
        expect(original.body).not.toContain(`EDIT-${id}`);
        expect(withEdit[0].conflictOf).toBe(id);
        expect(withEdit[0].body).toBe(edited.get(id));
      } else {
        expect(withEdit[0].id).toBe(id);
        expect(withEdit[0].body).toBe(edited.get(id));
      }
    }
    // Las otras 360 siguen como la semilla.
    for (const row of library.filter((row) => row.conflictOf === null && !ids.includes(row.id))) {
      expect(row.body).toBe(seeds.get(row.id));
    }

    // El diario del segundo lote dice qué entró y por qué.
    const secondLote = workdir.lotes().find((lote) => lote !== firstLote)!;
    const secondDone = workdir.readJournal(secondLote).filter((entry) => entry.paso === 'hecho');
    const count = (name: string) => secondDone.filter((entry) => entry.paso === 'hecho' && entry.resultado === name).length;
    expect(count('ya_estaba')).toBe(1);
    expect(count('aplicada')).toBe(EDITED - STOP - 1 - 1);
    expect(count('copia_de_conflicto')).toBe(1);

    // Un tercer apply no escribe nada.
    const third = capture(cwd);
    await applyCommand(third.io, opener(dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false });
    expect(third.text()).toContain('Nada que devolver.');
    expect(workdir.lotes()).toHaveLength(2);

    // Deshacer los dos lotes (el más reciente primero) deja las 38 como la semilla y manda
    // las dos copias a la papelera.
    for (const lote of [secondLote, firstLote]) {
      await undoCommand(capture(cwd).io, opener(dataDir), { dir: 'trabajo', lote });
    }
    await withWriter(dataDir, async (writer) => {
      for (const [index, id] of ids.entries()) {
        const body = (await writer.port.noteRead(id))!.body;
        if (BOTH.includes(index)) expect(body).toContain(`OTRO-${id}`);
        else expect(body).toBe(seeds.get(id));
      }
      for (const copy of copies) expect((await writer.port.noteRead(copy.id))!.trashedAt).not.toBeNull();
    });
  }, 180_000);
});
