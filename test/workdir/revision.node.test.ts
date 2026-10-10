/**
 * Hallazgos de la revisión de los ficheros de trabajo (SPEC.md §13), uno por bloque. Cada
 * test falla sin su arreglo.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { LibraryInstance } from '../../src/sync/library-instance';
import {
  applyCommand,
  checkoutCommand,
  describeRound,
  statusCommand,
  undoCommand,
  type CheckoutArgs,
  type OpenLibrary
} from '../../src/workdir/commands';
import { runWorkdirCommand } from '../../src/workdir/cli';
import { sha256Hex, Workdir } from '../../src/workdir/layout';
import type { WorkdirLibrary } from '../../src/workdir/library';
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

const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.restoreAllMocks();
  removeTempDirs();
});

function args(dir: string, extra: Partial<CheckoutArgs>): CheckoutArgs {
  return { dir, all: false, consultas: [], titulos: [], carpetas: [], forzar: false, ...extra };
}

const APPLY = { dir: 'trabajo', conflicto: 'copia' as const, simular: false };

function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

async function body(dataDir: string, id: string): Promise<string | undefined> {
  return withWriter(dataDir, async (writer) => (await writer.port.noteRead(id))?.body);
}

async function liveCopies(dataDir: string, id: string) {
  return withWriter(dataDir, async (writer) => {
    const page = await writer.port.notesPage(null, 200, { kind: 'conflicts' });
    const rows = await Promise.all(page.items.map((item) => writer.port.noteRead(item.id)));
    return rows.filter((row) => row?.conflictOf === id && row.trashedAt === null);
  });
}

/** Una nota, sacada en `trabajo`. */
async function oneNote(text = '# Receta\n\nLumbre de pan\n') {
  const dataDir = tempDir();
  const id = await withWriter(dataDir, (writer) => createNote(writer, text));
  const cwd = tempDir();
  await checkoutCommand(capture(cwd).io, opener(dataDir), args('trabajo', { all: true }));
  const workdir = new Workdir(join(cwd, 'trabajo'));
  const ruta = workdir.readCheckout().notas[0].ruta;
  return { dataDir, id, cwd, workdir, ruta, file: workdir.notePath(ruta) };
}

describe('1. base comprobada: un rev de la sacada que coincide no pisa', () => {
  it('rev de la sacada = local_seq actual con cuerpo distinto → copia de conflicto y original intacto', async () => {
    const { dataDir, id, cwd, workdir, file } = await oneNote();
    writeFileSync(file, '# Receta\n\nLumbre de pan\n\nAGENTE\n');
    await withWriter(dataDir, (writer) => writer.appendToNote({ id, text: 'OTRO', privacy: OPEN }));
    const current = await withWriter(dataDir, async (writer) => (await writer.port.noteRead(id))!);
    // La carpeta llegó de otra máquina (o la biblioteca se re-emparejó): su rev coincide
    // por casualidad con el local_seq de ahora.
    const meta = workdir.readMeta(id)!;
    workdir.writeMeta({ ...meta, rev: current.localSeq });
    expect(await applyCommand(capture(cwd).io, opener(dataDir), APPLY)).toBe(1);
    const original = await body(dataDir, id);
    expect(original).toContain('OTRO');
    expect(original).not.toContain('AGENTE');
    expect((await liveCopies(dataDir, id)).map((row) => row!.body)).toEqual(['# Receta\n\nLumbre de pan\n\nAGENTE\n']);
  });
});

describe('2. D3 con la fila fresca: lo que se vuelve privado a mitad del checkout no sale', () => {
  for (const how of ['etiqueta', 'carpeta'] as const) {
    it(`una nota que pasa a ${how} privada entre el filtro y la lectura no se escribe en disco`, async () => {
      const dataDir = tempDir();
      const writer = await LibraryInstance.open({
        dataDir,
        checkIntervalMs: null,
        lock: { releaseOnExit: false },
        writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
      });
      instances.push(writer);
      const diario = await createFolder(writer, 'Diario');
      const target = await createNote(writer, '# Se vuelve privada\n\nCEBO_REVISION\n');
      await createNote(writer, '# Normal\n\nvisible\n');
      writePrivacy(dataDir, { privateFolders: ['Diario'], privateTags: ['secreto'] });
      const base = opener(dataDir, { lock: { releaseOnExit: false, pid: livePid() } });
      let done = false;
      const open: OpenLibrary = async () => {
        const lib: WorkdirLibrary = await base();
        const noteRead = lib.port.noteRead;
        // Una ronda de sync (aquí, el escritor) la cambia justo antes de leerla.
        const port = {
          ...lib.port,
          noteRead: async (id: string) => {
            if (id === target && !done) {
              done = true;
              if (how === 'etiqueta') await writer.appendToNote({ id, text: '#secreto', privacy: OPEN });
              else await writer.organizeLocal({ action: 'moveNote', id, folderId: diario, privacy: OPEN });
            }
            return noteRead(id);
          }
        };
        return { ...lib, role: lib.role, port };
      };
      const cwd = tempDir();
      const out = capture(cwd);
      await checkoutCommand(out.io, open, args('trabajo', { all: true }));
      expect(done).toBe(true);
      const workdir = new Workdir(join(cwd, 'trabajo'));
      expect(workdir.readCheckout().notas.map((entry) => entry.id)).not.toContain(target);
      const onDisk = workdir.listMarkdown().map((ruta) => readFileSync(workdir.notePath(ruta), 'utf8')).join('\n');
      expect(onDisk).not.toContain('CEBO_REVISION');
      expect(existsSync(join(workdir.metaDir, 'base', `${target}.base`))).toBe(false);
      expect(out.text()).not.toContain('Se vuelve privada');
    });
  }
});

describe('3. rutas de los JSON: normalizadas y nunca fuera de la carpeta', () => {
  for (const bad of ['../fuera.md', 'ABS', '.hebra-d/fuera.md', 'a/../../fuera.md']) {
    it(`una ruta tocada (${bad}) es base dañada y no se lee ni se devuelve`, async () => {
      const { dataDir, id, cwd, workdir } = await oneNote();
      const outside = join(cwd, 'fuera.md');
      writeFileSync(outside, '# Receta\n\nfuera\n');
      mkdirSync(workdir.metaDir, { recursive: true });
      writeFileSync(join(workdir.metaDir, 'fuera.md'), '# Receta\n\nfuera\n');
      const ruta = bad === 'ABS' ? outside : bad;
      const checkout = workdir.readCheckout();
      workdir.writeCheckout({ ...checkout, notas: [{ id, ruta }] });
      workdir.writeMeta({ ...workdir.readMeta(id)!, ruta });
      const out = capture(cwd);
      expect(await applyCommand(out.io, opener(dataDir), APPLY)).toBe(1);
      expect(out.text()).toContain('base dañada');
      expect(await body(dataDir, id)).toBe('# Receta\n\nLumbre de pan\n');
    });
  }

  it('una ruta con \\ de Windows se lee con /', async () => {
    const dataDir = tempDir();
    const id = await withWriter(dataDir, async (writer) => createNote(writer, '# Plan\n\nuno\n', await createFolder(writer, 'Proyectos')));
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(dataDir), args('trabajo', { all: true }));
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const ruta = workdir.readCheckout().notas[0].ruta;
    writeFileSync(workdir.notePath(ruta), '# Plan\n\nuno y dos\n');
    const windows = ruta.replace('/', '\\');
    workdir.writeCheckout({ ...workdir.readCheckout(), notas: [{ id, ruta: windows }] });
    workdir.writeMeta({ ...workdir.readMeta(id)!, ruta: windows });
    expect(await applyCommand(capture(cwd).io, opener(dataDir), APPLY)).toBe(0);
    expect(await body(dataDir, id)).toBe('# Plan\n\nuno y dos\n');
  });
});

describe('4. lo que dejó de poder sacarse se retira en el checkout siguiente', () => {
  it('privada, en la papelera o bloqueada: sin editar se retira; editada se avisa sin nombrarla', async () => {
    const dataDir = tempDir();
    const ids = await withWriter(dataDir, async (writer) => ({
      diario: await createFolder(writer, 'Diario'),
      privada: await createNote(writer, '# Pasa a privada\n\nuno\n'),
      tirada: await createNote(writer, '# Tirada luego\n\ndos\n'),
      bloqueada: await createNote(writer, '# Bloqueada luego\n\ntres\n'),
      queda: await createNote(writer, '# Se queda\n\ncuatro\n')
    }));
    writePrivacy(dataDir, { privateFolders: ['Diario'] });
    const cwd = tempDir();
    await checkoutCommand(capture(cwd).io, opener(dataDir), args('trabajo', { all: true }));
    const workdir = new Workdir(join(cwd, 'trabajo'));
    const rutaOf = (id: string) => workdir.readCheckout().notas.find((entry) => entry.id === id)!.ruta;
    const tiradaFile = workdir.notePath(rutaOf(ids.tirada));
    const privadaFile = workdir.notePath(rutaOf(ids.privada));
    const bloqueadaFile = workdir.notePath(rutaOf(ids.bloqueada));
    writeFileSync(tiradaFile, '# Tirada luego\n\ndos editada\n');
    await withWriter(dataDir, async (writer) => {
      await writer.organizeLocal({ action: 'moveNote', id: ids.privada, folderId: ids.diario, privacy: OPEN });
      await writer.organizeLocal({ action: 'trashNote', id: ids.tirada, privacy: OPEN });
    });
    lockNote(dataDir, ids.bloqueada);
    const out = capture(cwd);
    expect(await checkoutCommand(out.io, opener(dataDir), args('trabajo', { all: true }))).toBe(0);
    const tracked = workdir.readCheckout().notas.map((entry) => entry.id);
    expect(tracked).not.toContain(ids.privada);
    expect(tracked).not.toContain(ids.bloqueada);
    expect(existsSync(privadaFile)).toBe(false);
    expect(existsSync(bloqueadaFile)).toBe(false);
    expect(workdir.readMeta(ids.privada)).toBeNull();
    expect(existsSync(join(workdir.metaDir, 'base', `${ids.privada}.base`))).toBe(false);
    // La editada se queda, y el aviso no la nombra.
    expect(readFileSync(tiradaFile, 'utf8')).toBe('# Tirada luego\n\ndos editada\n');
    expect(out.text()).toContain('1 nota sacada antes ya no se puede sacar');
    for (const title of ['Tirada luego', 'Pasa a privada', 'Bloqueada luego']) expect(out.text()).not.toContain(title);
    expect(out.text()).toContain('Retiradas 2 notas');
  });
});

describe('5. un fichero que no es de la carpeta no se pisa', () => {
  it('sin metadatos y con otro contenido: no se pisa sin --forzar', async () => {
    const dataDir = tempDir();
    const id = await withWriter(dataDir, (writer) => createNote(writer, '# Receta\n\nLumbre\n'));
    const cwd = tempDir();
    mkdirSync(join(cwd, 'trabajo'));
    const mine = join(cwd, 'trabajo', `Receta (${id.slice(0, 8)}).md`);
    writeFileSync(mine, 'mío\n');
    const out = capture(cwd);
    await checkoutCommand(out.io, opener(dataDir), args('trabajo', { all: true }));
    expect(readFileSync(mine, 'utf8')).toBe('mío\n');
    expect(out.text()).toContain('no se han pisado');
    await checkoutCommand(capture(cwd).io, opener(dataDir), args('trabajo', { all: true, forzar: true }));
    expect(readFileSync(mine, 'utf8')).toBe('# Receta\n\nLumbre\n');
  });
});

describe('6. undo de un lote cortado', () => {
  /** Lote A con copia de conflicto (otro escritor tocó la nota). */
  async function loteConCopia() {
    const setup = await oneNote();
    writeFileSync(setup.file, '# Receta\n\nLumbre de pan\n\nAGENTE\n');
    await withWriter(setup.dataDir, (writer) => writer.appendToNote({ id: setup.id, text: 'OTRO', privacy: OPEN }));
    await applyCommand(capture(setup.cwd).io, opener(setup.dataDir), APPLY);
    const [loteA] = setup.workdir.lotes();
    const [copy] = await liveCopies(setup.dataDir, setup.id);
    return { ...setup, loteA, copyId: copy!.id };
  }

  /** Un lote cortado: el diario de `from` sin sus «hecho». */
  function cutLote(workdir: Workdir, from: string, name: string): void {
    cpSync(workdir.loteDir(from), workdir.loteDir(name), { recursive: true });
    const lines = readFileSync(join(workdir.loteDir(name), 'diario.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line && !line.includes('"paso":"hecho"'));
    writeFileSync(join(workdir.loteDir(name), 'diario.jsonl'), `${lines.join('\n')}\n`);
  }

  it('no toca la copia de conflicto de OTRO lote', async () => {
    const { dataDir, id, cwd, workdir, loteA, copyId } = await loteConCopia();
    cutLote(workdir, loteA, '29991231T000000Z-cortado');
    await undoCommand(capture(cwd).io, opener(dataDir), { dir: 'trabajo', lote: '29991231T000000Z-cortado' });
    expect((await liveCopies(dataDir, id)).map((row) => row!.id)).toEqual([copyId]);
  });

  it('una copia ya en la papelera no prueba que el lote dejó copia: la nota se restaura', async () => {
    const { dataDir, id, cwd, workdir, loteA } = await loteConCopia();
    await undoCommand(capture(cwd).io, opener(dataDir), { dir: 'trabajo', lote: loteA });
    expect(await liveCopies(dataDir, id)).toHaveLength(0);
    // Después, la misma edición entra en el original y el lote que lo hizo se corta.
    const otro = (await body(dataDir, id))!;
    const edited = '# Receta\n\nLumbre de pan\n\nAGENTE\n';
    await withWriter(dataDir, async (writer) => {
      const row = (await writer.port.noteRead(id))!;
      await writer.replaceBodyLocal({
        id,
        body: edited,
        baseBodySha256: row.bodySha256,
        onConflict: 'reject',
        privacy: OPEN
      });
    });
    const lote = '29991231T000000Z-cortado';
    mkdirSync(join(workdir.loteDir(lote), 'base'), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      join(workdir.loteDir(lote), 'diario.jsonl'),
      `${JSON.stringify({ paso: 'lote', lote, conflicto: 'copia', en: at })}\n${JSON.stringify({
        paso: 'intento',
        id,
        ruta: workdir.readCheckout().notas[0].ruta,
        shaBase: sha256Hex(otro),
        shaEditado: sha256Hex(edited),
        en: at
      })}\n`
    );
    writeFileSync(join(workdir.loteDir(lote), 'base', `${id}.base`), otro);
    await undoCommand(capture(cwd).io, opener(dataDir), { dir: 'trabajo', lote });
    expect(await body(dataDir, id)).toBe(otro);
  });
});

describe('7. cerrojo de la carpeta de trabajo', () => {
  it('dos apply a la vez: el segundo sale con 2 y lo dice', async () => {
    const { dataDir, id, cwd, file } = await oneNote();
    writeFileSync(file, '# Receta\n\nLumbre de pan\n\nmás\n');
    const first = capture(cwd);
    const second = capture(cwd);
    const running = applyCommand(first.io, opener(dataDir), APPLY);
    const code = await runWorkdirCommand('apply', ['--dir', 'trabajo'], second.io, opener(dataDir));
    expect(code).toBe(2);
    expect(second.text()).toContain('otra orden está usando esta carpeta de trabajo');
    expect(await running).toBe(0);
    expect(await body(dataDir, id)).toBe('# Receta\n\nLumbre de pan\n\nmás\n');
  });

  it('un cerrojo de un proceso muerto no bloquea', async () => {
    const { dataDir, id, cwd, workdir, file } = await oneNote();
    writeFileSync(file, '# Receta\n\nLumbre de pan\n\nmás\n');
    writeFileSync(join(workdir.metaDir, 'cerrojo'), JSON.stringify({ pid: await deadPid() }));
    expect(await applyCommand(capture(cwd).io, opener(dataDir), APPLY)).toBe(0);
    expect(await body(dataDir, id)).toBe('# Receta\n\nLumbre de pan\n\nmás\n');
  });
});

describe('8. mensajes', () => {
  it('la ronda: escritor antiguo, y escritor que era este proceso', () => {
    expect(describeRound({ kind: 'old_writer' }, 'other_instance')).toContain('versión anterior');
    const mine = describeRound({ kind: 'timeout' }, 'this');
    expect(mine).not.toContain('seguirá sola');
    expect(mine).toContain('la próxima vez');
  });

  it('una sacada parcial no rejuvenece el aviso de 24 h de las notas antiguas', async () => {
    const dataDir = tempDir();
    await withWriter(dataDir, async (writer) => {
      await createNote(writer, '# Vieja\n\nuno\n');
      await createNote(writer, '# Nueva\n\ndos\n');
    });
    const cwd = tempDir();
    const t0 = Date.parse('2026-10-01T10:00:00Z');
    const at = (hours: number) => ({ ...capture(cwd).io, now: () => new Date(t0 + hours * 3_600_000) });
    await checkoutCommand(at(0), opener(dataDir), args('trabajo', { titulos: ['Vieja'] }));
    await checkoutCommand(at(30), opener(dataDir), args('trabajo', { titulos: ['Nueva'] }));
    const out = capture(cwd);
    statusCommand({ ...out.io, now: () => new Date(t0 + 31 * 3_600_000) }, { dir: 'trabajo', rutas: false });
    expect(out.text()).toContain('más de 24 h');
  });
});
