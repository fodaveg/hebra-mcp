/**
 * Ficheros de trabajo con vuelta (SPEC.md §13, tarea D de Lumbre c4f2fd52), en el mismo
 * proceso y sobre bibliotecas temporales: AC1-AC4 y AC6 del audit
 * `docs/audits/2026-10-10-sqlite-o-markdown.md` de Hebra, más base dañada, ficheros
 * renombrados, nombres de Windows, NFC, otra biblioteca, notas bloqueadas y privadas.
 * El corte con `kill -9` (AC5) está en `./apply-corte.node.test.ts`; otro escritor vivo,
 * en `./otro-escritor.node.test.ts`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryInstance } from '../../src/sync/library-instance';
import {
  applyCommand,
  checkoutCommand,
  diffCommand,
  statusCommand,
  undoCommand,
  type CheckoutArgs
} from '../../src/workdir/commands';
import { runWorkdirCommand } from '../../src/workdir/cli';
import { Workdir } from '../../src/workdir/layout';
import {
  capture,
  createFolder,
  createNote,
  lockNote,
  OPEN,
  opener,
  removeTempDirs,
  tempDir,
  withWriter,
  writePrivacy
} from './helpers';

const CEBO = 'CEBO_PRIVADO_d41c';

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

function checkoutArgs(dir: string, extra: Partial<CheckoutArgs>): CheckoutArgs {
  return { dir, all: false, consultas: [], titulos: [], carpetas: [], forzar: false, ...extra };
}

interface Seeded {
  dataDir: string;
  plan: string;
  sub: string;
  receta: string;
  diario: string;
  etiquetada: string;
  tirada: string;
  bloqueada: string;
  archivada: string;
  copia: string;
}

/** Biblioteca con lo que AC1 deja fuera: privadas por carpeta y por etiqueta, papelera,
 *  bloqueada, archivada y una copia de conflicto. */
async function seedLibrary(): Promise<Seeded> {
  const dataDir = tempDir();
  const seeded = await withWriter(dataDir, async (writer) => {
    const proyectos = await createFolder(writer, 'Proyectos');
    const subcarpeta = await createFolder(writer, 'Sub', proyectos);
    const diarioFolder = await createFolder(writer, 'Diario');
    const plan = await createNote(writer, '# Plan\n\nLumbre y Hebra\n', proyectos);
    const sub = await createNote(writer, '# Sub\n\nnada que ver\n', subcarpeta);
    const receta = await createNote(writer, '# Receta\n\nLumbre de pan\n');
    const diario = await createNote(writer, `# Diario secreto\n\nLumbre ${CEBO}\n`, diarioFolder);
    const etiquetada = await createNote(writer, `# Etiquetada\n\n#secreto Lumbre ${CEBO}\n`);
    const tirada = await createNote(writer, '# Tirada\n\nLumbre\n');
    await writer.organizeLocal({ action: 'trashNote', id: tirada, privacy: OPEN });
    const bloqueada = await createNote(writer, '# Bloqueada\n\nLumbre\n');
    const archivada = await createNote(writer, '# Archivada\n\nLumbre\n');
    await writer.organizeLocal({ action: 'setArchived', id: archivada, archived: true, privacy: OPEN });
    const conflict = await writer.replaceBodyLocal({
      id: receta,
      body: '# Receta\n\nLumbre de pan COPIA\n',
      baseBodySha256: '0'.repeat(64),
      baseLocalSeq: 0,
      onConflict: 'copy',
      privacy: OPEN
    });
    if (conflict.outcome !== 'conflict_copy') throw new Error('la semilla esperaba una copia de conflicto');
    return { plan, sub, receta, diario, etiquetada, tirada, bloqueada, archivada, copia: conflict.copyId };
  });
  lockNote(dataDir, seeded.bloqueada);
  writePrivacy(dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
  return { dataDir, ...seeded };
}

function idsOf(workdirRoot: string): string[] {
  return new Workdir(workdirRoot)
    .readCheckout()
    .notas.map((entry) => entry.id)
    .sort();
}

function allFilesText(root: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [readFileSync(join(dir, entry.name), 'utf8')]
    );
  return walk(root).join('\n');
}

async function readBody(dataDir: string, id: string): Promise<string | undefined> {
  return withWriter(dataDir, async (writer) => (await writer.port.noteRead(id))?.body);
}

describe('checkout (AC1): por consulta, título, carpeta y --all', () => {
  it('--all saca las visibles y deja fuera bloqueadas, papelera, archivadas, copias de conflicto y privadas', async () => {
    const lib = await seedLibrary();
    const cwd = tempDir();
    const out = capture(cwd);
    expect(await checkoutCommand(out.io, opener(lib.dataDir), checkoutArgs('trabajo', { all: true }))).toBe(0);
    expect(idsOf(join(cwd, 'trabajo'))).toEqual([lib.plan, lib.receta, lib.sub].sort());
    const files = new Workdir(join(cwd, 'trabajo')).listMarkdown();
    expect(files).toEqual([
      `Proyectos/Plan (${lib.plan.slice(0, 8)}).md`,
      `Proyectos/Sub/Sub (${lib.sub.slice(0, 8)}).md`,
      `Receta (${lib.receta.slice(0, 8)}).md`
    ]);
    // El cuerpo, byte a byte, sin cabecera añadida.
    expect(readFileSync(join(cwd, 'trabajo', files[2]), 'utf8')).toBe('# Receta\n\nLumbre de pan\n');
    // Nada privado en disco: ni cuerpos, ni metadatos, ni bases.
    expect(allFilesText(join(cwd, 'trabajo'))).not.toContain(CEBO);
    expect(out.text()).not.toContain(CEBO);
    expect(out.text()).toContain('Sacadas 3 notas');
    expect(out.text()).toContain('hebra-mcp apply --dir trabajo');
    // §6.4: stderr solo lleva eventos cerrados; ni títulos, ni cuerpos, ni rutas.
    const stderr = vi
      .mocked(process.stderr.write)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    for (const text of ['Receta', 'Lumbre', 'Plan', CEBO, 'trabajo']) expect(stderr).not.toContain(text);
  });

  it('--consulta, --titulo y --carpeta, solos y combinados', async () => {
    const lib = await seedLibrary();
    const cwd = tempDir();
    const run = async (dir: string, extra: Partial<CheckoutArgs>) => {
      const out = capture(cwd);
      const code = await checkoutCommand(out.io, opener(lib.dataDir), checkoutArgs(dir, extra));
      return { code, text: out.text() };
    };
    expect((await run('q', { consultas: ['Lumbre'] })).code).toBe(0);
    expect(idsOf(join(cwd, 'q'))).toEqual([lib.plan, lib.receta].sort());

    const titles = await run('t', { titulos: ['Receta', 'No existe', 'Diario secreto'] });
    expect(idsOf(join(cwd, 't'))).toEqual([lib.receta]);
    expect(titles.text).toContain('Sin nota con el título «No existe».');
    // Una nota privada se comporta como si no existiera.
    expect(titles.text).toContain('Sin nota con el título «Diario secreto».');

    await run('c', { carpetas: ['proyectos'] });
    expect(idsOf(join(cwd, 'c'))).toEqual([lib.plan, lib.sub].sort());

    await run('qc', { consultas: ['Lumbre'], carpetas: ['Proyectos'] });
    expect(idsOf(join(cwd, 'qc'))).toEqual([lib.plan]);

    // Una carpeta privada responde igual que una que no existe.
    const hidden = capture(cwd);
    const code = await runWorkdirCommand('checkout', ['--dir', 'p', '--carpeta', 'Diario'], hidden.io, opener(lib.dataDir));
    expect(code).toBe(2);
    expect(hidden.text()).toContain('no existe la carpeta «Diario»');
    const missing = capture(cwd);
    await runWorkdirCommand('checkout', ['--dir', 'p', '--carpeta', 'Nada'], missing.io, opener(lib.dataDir));
    expect(missing.text().replace('Nada', 'Diario')).toBe(hidden.text());
  });

  it('sin selección o sin --dir es un error de uso', async () => {
    const lib = await seedLibrary();
    const cwd = tempDir();
    const out = capture(cwd);
    expect(await runWorkdirCommand('checkout', ['--dir', 'x'], out.io, opener(lib.dataDir))).toBe(2);
    expect(await runWorkdirCommand('checkout', ['--all'], out.io, opener(lib.dataDir))).toBe(2);
    expect(existsSync(join(cwd, 'x'))).toBe(false);
  });
});

describe('editar, revisar y devolver (AC2, AC3, AC6)', () => {
  it('simular no escribe nada; apply devuelve solo las cambiadas; undo vuelve a la base', async () => {
    const lib = await seedLibrary();
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(lib.dataDir), checkoutArgs('trabajo', { all: true }));
    const root = join(cwd, 'trabajo');
    const workdir = new Workdir(root);
    const recetaFile = join(root, `Receta (${lib.receta.slice(0, 8)}).md`);
    const planFile = join(root, 'Proyectos', `Plan (${lib.plan.slice(0, 8)}).md`);
    // AC2: escritura normal de fichero, como un sed o un script.
    writeFileSync(recetaFile, readFileSync(recetaFile, 'utf8').replace('pan', 'pan integral'));
    writeFileSync(planFile, `${readFileSync(planFile, 'utf8')}\nUna línea más.\n`);

    const status = capture(cwd);
    statusCommand(status.io, { dir: 'trabajo', rutas: false });
    expect(status.text()).toContain('2 editadas sin devolver');

    const diff = capture(cwd);
    diffCommand(diff.io, { dir: 'trabajo', stat: false, files: [recetaFile] });
    expect(diff.text()).toContain(`--- a/Receta (${lib.receta.slice(0, 8)}).md`);
    expect(diff.text()).toContain('+Lumbre de pan integral');
    expect(diff.text()).not.toContain('Plan');
    const stat = capture(cwd);
    diffCommand(stat.io, { dir: 'trabajo', stat: true, files: [] });
    expect(stat.lines).toHaveLength(2);

    // AC3: simular, sin lote, sin metadatos y sin tocar la nota.
    const metaBefore = readFileSync(join(root, '.hebra-d', 'notas', `${lib.receta}.json`), 'utf8');
    const sim = capture(cwd);
    expect(await applyCommand(sim.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: true })).toBe(0);
    expect(sim.text()).toContain('Simulación: se devolverían 2 notas');
    expect(sim.text()).toContain('+ Lumbre de pan integral');
    expect(existsSync(join(root, '.hebra-d', 'lotes'))).toBe(false);
    expect(readFileSync(join(root, '.hebra-d', 'notas', `${lib.receta}.json`), 'utf8')).toBe(metaBefore);
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n');

    const applied = capture(cwd);
    expect(await applyCommand(applied.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(0);
    expect(applied.text()).toMatch(/Lote \S+: 2 aplicada/u);
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan integral\n');
    expect(await readBody(lib.dataDir, lib.plan)).toBe('# Plan\n\nLumbre y Hebra\n\nUna línea más.\n');
    const [lote] = workdir.lotes();
    const journal = workdir.readJournal(lote);
    expect(journal.filter((entry) => entry.paso === 'intento')).toHaveLength(2);
    expect(journal.filter((entry) => entry.paso === 'hecho' && entry.resultado === 'aplicada')).toHaveLength(2);
    expect(readFileSync(join(workdir.loteDir(lote), 'cambios.diff'), 'utf8')).toContain('+Lumbre de pan integral');
    // Instantánea forzada del cuerpo que se sustituyó.
    const versions = await withWriter(lib.dataDir, (writer) => writer.port.noteVersionsList(lib.receta));
    expect(versions.items.length).toBeGreaterThan(0);

    const again = capture(cwd);
    expect(await applyCommand(again.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(0);
    expect(again.text()).toContain('Nada que devolver.');

    // AC6: deshacer el lote deja las dos como estaban, también en la carpeta de trabajo.
    const undo = capture(cwd);
    expect(await undoCommand(undo.io, opener(lib.dataDir), { dir: 'trabajo', lote })).toBe(0);
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n');
    expect(await readBody(lib.dataDir, lib.plan)).toBe('# Plan\n\nLumbre y Hebra\n');
    expect(readFileSync(recetaFile, 'utf8')).toBe('# Receta\n\nLumbre de pan\n');
    const after = capture(cwd);
    statusCommand(after.io, { dir: 'trabajo', rutas: false });
    expect(after.text()).toContain('Nada editado.');
    // Repetirlo no hace nada.
    const twice = capture(cwd);
    expect(await undoCommand(twice.io, opener(lib.dataDir), { dir: 'trabajo', lote })).toBe(0);
    expect(twice.text()).toContain('ya estaba como antes del lote');
  });
});

describe('devolver sin pisar (AC4)', () => {
  async function editedByBoth(mode: 'copia' | 'rechazar') {
    const lib = await seedLibrary();
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(lib.dataDir), checkoutArgs('trabajo', { all: true }));
    const root = join(cwd, 'trabajo');
    const recetaFile = join(root, `Receta (${lib.receta.slice(0, 8)}).md`);
    const planFile = join(root, 'Proyectos', `Plan (${lib.plan.slice(0, 8)}).md`);
    writeFileSync(recetaFile, '# Receta\n\nLumbre de pan\n\nEDICIÓN DEL AGENTE\n');
    writeFileSync(planFile, '# Plan\n\nLumbre y Hebra\n\nPLAN DEL AGENTE\n');
    // Otro escritor edita la receta entre el checkout y el apply.
    await withWriter(lib.dataDir, (writer) =>
      writer.appendToNote({ id: lib.receta, text: 'EDICIÓN DE DAVID', privacy: OPEN })
    );
    const out = capture(cwd);
    const code = await applyCommand(out.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: mode, simular: false });
    return { lib, cwd, root, recetaFile, code, text: out.text() };
  }

  async function copiesOf(dataDir: string, id: string) {
    return withWriter(dataDir, async (writer) => {
      const page = await writer.port.notesPage(null, 200, { kind: 'conflicts' });
      const rows = await Promise.all(page.items.map((item) => writer.port.noteRead(item.id)));
      return rows.filter((row) => row?.conflictOf === id && row.trashedAt === null);
    });
  }

  it('copia: las dos ediciones se conservan y la nota no se vuelve a devolver', async () => {
    const { lib, cwd, recetaFile, code, text } = await editedByBoth('copia');
    expect(code).toBe(1);
    expect(text).toContain('copia de conflicto');
    expect(await readBody(lib.dataDir, lib.plan)).toContain('PLAN DEL AGENTE');
    const original = await readBody(lib.dataDir, lib.receta);
    expect(original).toContain('EDICIÓN DE DAVID');
    expect(original).not.toContain('EDICIÓN DEL AGENTE');
    // La de la semilla («COPIA») y la nueva, con el cuerpo entero del agente.
    const copies = (await copiesOf(lib.dataDir, lib.receta)).filter((row) => row?.body.includes('AGENTE'));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.body).toBe('# Receta\n\nLumbre de pan\n\nEDICIÓN DEL AGENTE\n');

    // En conflicto: otro apply no la manda otra vez (ni otra copia).
    const again = capture(cwd);
    expect(await applyCommand(again.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(1);
    expect(again.text()).toContain('en conflicto de antes');
    expect((await copiesOf(lib.dataDir, lib.receta)).filter((row) => row?.body.includes('AGENTE'))).toHaveLength(1);

    // Otro checkout de esa nota la refresca (su edición ya está a salvo en la copia).
    const refresh = capture(cwd);
    await checkoutCommand(refresh.io, opener(lib.dataDir), checkoutArgs('trabajo', { titulos: ['Receta'] }));
    expect(readFileSync(recetaFile, 'utf8')).toBe(original);
    const status = capture(cwd);
    statusCommand(status.io, { dir: 'trabajo', rutas: false });
    expect(status.text()).toContain('Nada editado.');
  });

  it('rechazar: no escribe, lo lista y no pisa el fichero al volver a sacar', async () => {
    const { lib, cwd, recetaFile, code, text } = await editedByBoth('rechazar');
    expect(code).toBe(1);
    expect(text).toContain('rechazada: la nota cambió en Hebra');
    const original = await readBody(lib.dataDir, lib.receta);
    expect(original).toContain('EDICIÓN DE DAVID');
    expect(original).not.toContain('AGENTE');
    expect((await copiesOf(lib.dataDir, lib.receta)).filter((row) => row?.body.includes('AGENTE'))).toHaveLength(0);
    // La edición solo está en el fichero: checkout no la pisa sin --forzar.
    const refresh = capture(cwd);
    await checkoutCommand(refresh.io, opener(lib.dataDir), checkoutArgs('trabajo', { titulos: ['Receta'] }));
    expect(refresh.text()).toContain('no se han pisado');
    expect(readFileSync(recetaFile, 'utf8')).toContain('EDICIÓN DEL AGENTE');
  });

  it('undo de un lote con conflicto: la copia a la papelera, lo cambiado después no se toca', async () => {
    const { lib, cwd, root } = await editedByBoth('copia');
    const [lote] = new Workdir(root).lotes();
    // Después del lote, alguien vuelve a tocar el plan.
    await withWriter(lib.dataDir, (writer) => writer.appendToNote({ id: lib.plan, text: 'DESPUÉS', privacy: OPEN }));
    const undo = capture(cwd);
    expect(await undoCommand(undo.io, opener(lib.dataDir), { dir: 'trabajo', lote })).toBe(1);
    expect(undo.text()).toContain('cambió después del lote: no se toca');
    expect(undo.text()).toContain('su copia de conflicto, a la papelera');
    expect(await readBody(lib.dataDir, lib.plan)).toContain('DESPUÉS');
    expect((await copiesOf(lib.dataDir, lib.receta)).filter((row) => row?.body.includes('AGENTE'))).toHaveLength(0);
  });
});

describe('casos límite de la carpeta de trabajo', () => {
  async function checkedOut() {
    const lib = await seedLibrary();
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(lib.dataDir), checkoutArgs('trabajo', { all: true }));
    const root = join(cwd, 'trabajo');
    return { lib, cwd, root, recetaFile: join(root, `Receta (${lib.receta.slice(0, 8)}).md`) };
  }

  it('una base tocada por un script sale como dañada y no se devuelve', async () => {
    const { lib, cwd, root, recetaFile } = await checkedOut();
    writeFileSync(recetaFile, '# Receta\n\notra cosa\n');
    writeFileSync(join(root, '.hebra-d', 'base', `${lib.receta}.base`), '# Receta\n\ntocada\n');
    const out = capture(cwd);
    expect(await applyCommand(out.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(1);
    expect(out.text()).toContain('base dañada');
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n');
  });

  it('un fichero renombrado sale como «falta» y el nuevo «sin seguimiento»; ninguno se devuelve', async () => {
    const { lib, cwd, root, recetaFile } = await checkedOut();
    writeFileSync(recetaFile, '# Receta\n\nrenombrada y editada\n');
    renameSync(recetaFile, join(root, 'Receta nueva.md'));
    const status = capture(cwd);
    statusCommand(status.io, { dir: 'trabajo', rutas: true });
    expect(status.text()).toContain('1 faltan');
    expect(status.text()).toContain('1 sin seguimiento');
    expect(status.text()).toContain('Receta nueva.md');
    const out = capture(cwd);
    expect(await applyCommand(out.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(0);
    expect(out.text()).toContain('Nada que devolver.');
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n');
  });

  it('apply encuentra la carpeta subiendo o en un subdirectorio, y se niega con otra biblioteca', async () => {
    const { lib, cwd, root, recetaFile } = await checkedOut();
    writeFileSync(recetaFile, '# Receta\n\nLumbre de pan\n\nmás\n');
    const other = tempDir();
    await withWriter(other, (writer) => createNote(writer, '# Otra\n'));
    const wrong = capture(join(root, 'Proyectos'));
    expect(await runWorkdirCommand('apply', [], wrong.io, opener(other))).toBe(2);
    expect(wrong.text()).toContain('otra biblioteca');
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n');
    // Desde el directorio que CONTIENE la carpeta de trabajo, sin --dir.
    const right = capture(cwd);
    expect(await runWorkdirCommand('apply', [], right.io, opener(lib.dataDir))).toBe(0);
    expect(await readBody(lib.dataDir, lib.receta)).toBe('# Receta\n\nLumbre de pan\n\nmás\n');
  });

  it('una nota bloqueada después del checkout, o una edición con etiqueta privada, no entran', async () => {
    const { lib, cwd, root, recetaFile } = await checkedOut();
    const planFile = join(root, 'Proyectos', `Plan (${lib.plan.slice(0, 8)}).md`);
    writeFileSync(recetaFile, '# Receta\n\nLumbre de pan\n\nnueva\n');
    writeFileSync(planFile, '# Plan\n\nLumbre y Hebra #secreto\n');
    lockNote(lib.dataDir, lib.receta);
    const out = capture(cwd);
    expect(await applyCommand(out.io, opener(lib.dataDir), { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(1);
    expect(out.text()).toContain('bloqueada: no se escribió nada');
    expect(out.text()).toContain('no disponible');
    expect(await readBody(lib.dataDir, lib.plan)).toBe('# Plan\n\nLumbre y Hebra\n');
  });

  it('nombres de Windows y NFC en títulos y carpetas', async () => {
    const dataDir = tempDir();
    const ids = await withWriter(dataDir, async (writer) => {
      const aux = await createFolder(writer, 'AUX');
      return {
        con: await createNote(writer, '# CON\n\nuno\n', aux),
        raros: await createNote(writer, '# a:b*c?\n\ndos\n'),
        nfd: await createNote(writer, '# Canción.\n\ntres\n')
      };
    });
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(dataDir), checkoutArgs('t', { all: true }));
    const files = new Workdir(join(cwd, 't')).listMarkdown();
    expect(files).toEqual(
      [
        `_AUX/_CON (${ids.con.slice(0, 8)}).md`,
        `a-b-c- (${ids.raros.slice(0, 8)}).md`,
        `Canción (${ids.nfd.slice(0, 8)}).md`
      ].sort()
    );
    // El fichero en NFC se encuentra y se devuelve; nada «sin seguimiento».
    writeFileSync(join(cwd, 't', `Canción (${ids.nfd.slice(0, 8)}).md`), '# Canción.\n\ntres y más\n');
    const status = capture(cwd);
    statusCommand(status.io, { dir: 't', rutas: true });
    expect(status.text()).not.toContain('sin seguimiento');
    expect(await applyCommand(capture(cwd).io, opener(dataDir), { dir: 't', conflicto: 'copia', simular: false })).toBe(0);
    expect(await readBody(dataDir, ids.nfd)).toBe('# Canción.\n\ntres y más\n');
  });
});

describe('la instancia se abre y se cierra como serve', () => {
  it('al terminar, el bloqueo queda libre para el siguiente', async () => {
    const lib = await seedLibrary();
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(lib.dataDir), checkoutArgs('trabajo', { all: true }));
    const next = await LibraryInstance.open({ dataDir: lib.dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
    try {
      expect(next.role).toBe('this');
    } finally {
      await next.close();
    }
  });
});
