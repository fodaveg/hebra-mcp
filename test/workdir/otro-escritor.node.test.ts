/**
 * Ficheros de trabajo con OTRO proceso de hebra-mcp como escritor (SPEC.md §13.6): el CLI
 * no escribe en la SQLite por su cuenta, reenvía por `writer.sock` (`replaceBody`,
 * `trashConflictCopies`, `syncRound`) y lee de la réplica.
 *
 * Como en `test/forward/forward.test.ts`, el escritor es una `LibraryInstance` de este
 * proceso con su socket, y el CLI declara el PID de otro proceso vivo (así no puede tomar
 * el bloqueo y queda de lector). El sync va sobre el relé en memoria de Hebra, con una
 * «app» montada como la monta Hebra (`test/sync/devices.ts`): la segunda mitad de AC4
 * («tras una ronda, la app las enseña») contra ese relé, no contra la app real.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { LibraryInstance } from '../../src/sync/library-instance';
import { applyCommand, checkoutCommand, undoCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import type { WorkdirLibrary } from '../../src/workdir/library';
import { InMemoryLibraryRelay } from '../hebra-testing';
import { allBodies, appDevice, appSave, IDENTITY, VAULT_KEY } from '../sync/devices';
import { capture, createNote, lockNote, opener, removeTempDirs, tempDir, writePrivacy } from './helpers';

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

/** Un proceso vivo cuyo PID declara el CLI (así no puede tomar el bloqueo). */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

async function setup(options: { oldWriter?: boolean; privateTags?: string[] } = {}) {
  const dataDir = tempDir();
  // La configuración de privados es la del CLI (el lector); el escritor la recibe con cada
  // escritura y la vuelve a aplicar en su turno.
  if (options.privateTags) writePrivacy(dataDir, { privateTags: options.privateTags });
  const relay = new InMemoryLibraryRelay();
  const sync = { transport: relay, blobTransport: null, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null };
  const writer = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
    // Un escritor «de una versión anterior»: sin los manejadores de los ficheros de trabajo.
    writerSocket: (opened) =>
      options.oldWriter
        ? writerSocketHandlers(localWriteContext(opened), { status: () => opened.status() })
        : writerSocketHandlers(localWriteContext(opened), opened)
  });
  instances.push(writer);
  await writer.whenReady(5_000);
  const app = await appDevice(relay);
  const ids = {
    a: await createNote(writer, '# Nota A\n\ntexto A\n'),
    b: await createNote(writer, '# Nota B\n\ntexto B\n'),
    c: await createNote(writer, '# Nota C\n\ntexto C\n')
  };
  await writer.syncRunner!.requestRound();
  await app.sync.runRound();
  const roles: string[] = [];
  const base = opener(dataDir, { sync, lock: { releaseOnExit: false, pid: livePid() } });
  const open: OpenLibrary = async () => {
    const lib: WorkdirLibrary = await base();
    roles.push(lib.role);
    return lib;
  };
  const cwd = tempDir();
  const out = capture(cwd);
  expect(
    await checkoutCommand(out.io, open, { dir: 'trabajo', all: true, consultas: [], titulos: [], carpetas: [], forzar: false })
  ).toBe(0);
  const workdir = new Workdir(join(cwd, 'trabajo'));
  const fileOf = (id: string) => workdir.notePath(workdir.readCheckout().notas.find((entry) => entry.id === id)!.ruta);
  return { dataDir, writer, app, ids, open, roles, cwd, workdir, fileOf, checkoutText: out.text() };
}

describe('otro proceso es el escritor: el CLI reenvía por writer.sock', () => {
  it('checkout y apply van por el escritor; tras la ronda la app los ve y no se pierde texto', async () => {
    const { writer, app, ids, open, roles, cwd, workdir, fileOf, checkoutText } = await setup();
    expect(checkoutText).toContain('(sync: ok)');
    writeFileSync(fileOf(ids.a), '# Nota A\n\ntexto A\n\nAGENTE-A\n');
    writeFileSync(fileOf(ids.b), '# Nota B\n\ntexto B\n\nAGENTE-B\n');
    // La app edita A (la primera del lote) y sincroniza; el escritor aún no lo ha traído.
    await appSave(app, ids.a, '# Nota A\n\ntexto A\n\nAPP-A\n');
    await app.sync.runRound();

    const out = capture(cwd);
    const code = await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false });
    expect(roles.every((role) => role === 'other_instance')).toBe(true);
    // A se escribió en el escritor (su copia local no había cambiado) y la ronda trajo la de
    // la app: el motor lo resuelve con una copia de conflicto, y apply lo dice. (Si la app
    // editara una nota que se escribe DESPUÉS de una ronda, saldría como copia de conflicto
    // al escribir: `checkout-apply.node.test.ts`, AC4.)
    expect(code).toBe(1);
    expect(out.text()).toContain('la ronda de sync trajo otra versión');
    expect((await writer.port.noteRead(ids.b))!.body).toBe('# Nota B\n\ntexto B\n\nAGENTE-B\n');

    // Segunda mitad de AC4, contra el relé en memoria: la app ve lo devuelto y no se pierde
    // ninguna de las dos ediciones de A.
    await app.sync.runRound();
    expect((await app.port.noteRead(ids.b))!.body).toBe('# Nota B\n\ntexto B\n\nAGENTE-B\n');
    for (const port of [app.port, writer.port]) {
      const bodies = (await allBodies(port)).map((row) => row.body).join('\n');
      expect(bodies).toContain('AGENTE-A');
      expect(bodies).toContain('APP-A');
    }

    // undo también va por el escritor, y la app lo ve.
    const [lote] = workdir.lotes();
    await undoCommand(capture(cwd).io, open, { dir: 'trabajo', lote });
    expect((await writer.port.noteRead(ids.b))!.body).toBe('# Nota B\n\ntexto B\n');
    await app.sync.runRound();
    expect((await app.port.noteRead(ids.b))!.body).toBe('# Nota B\n\ntexto B\n');
    expect(readFileSync(fileOf(ids.b), 'utf8')).toBe('# Nota B\n\ntexto B\n');
  });

  it('privacidad y bloqueo en el turno del escritor: una etiqueta privada y una nota bloqueada no entran', async () => {
    const { dataDir, writer, ids, open, cwd, fileOf } = await setup({ privateTags: ['secreto'] });
    writeFileSync(fileOf(ids.a), '# Nota A\n\ntexto A #secreto\n');
    writeFileSync(fileOf(ids.b), '# Nota B\n\ntexto B y más\n');
    writeFileSync(fileOf(ids.c), '# Nota C\n\ntexto C y más\n');
    // B se bloquea en la biblioteca después del checkout (otra app).
    lockNote(dataDir, ids.b);
    const out = capture(cwd);
    expect(await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(1);
    expect(out.text()).toContain('no disponible');
    expect(out.text()).toContain('bloqueada: no se escribió nada');
    expect((await writer.port.noteRead(ids.a))!.body).toBe('# Nota A\n\ntexto A\n');
    expect((await writer.port.noteRead(ids.b))!.body.startsWith('hebra-locked:')).toBe(true);
    // La tercera, sin nada de eso, entra por el mismo escritor.
    expect((await writer.port.noteRead(ids.c))!.body).toBe('# Nota C\n\ntexto C y más\n');
  });

  it('un escritor de una versión anterior: apply lo dice y no escribe nada', async () => {
    const { writer, ids, open, cwd, fileOf } = await setup({ oldWriter: true });
    writeFileSync(fileOf(ids.c), '# Nota C\n\ntexto C\n\nAGENTE-C\n');
    const out = capture(cwd);
    expect(await applyCommand(out.io, open, { dir: 'trabajo', conflicto: 'copia', simular: false })).toBe(1);
    expect(out.text()).toContain('versión anterior');
    expect((await writer.port.noteRead(ids.c))!.body).toBe('# Nota C\n\ntexto C\n');
  });
});
