import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WRITER_LOCK_FILE, WriterLock, processIsAlive } from '../../src/lock/writer-lock';
import { StoreError } from '../../src/store/errors';
import { LibraryInstance } from '../../src/sync/library-instance';
import { InMemoryLibraryRelay, IDENTITY, VAULT_KEY, appDevice } from './devices';
import { NO_PRIVATE } from '../fixtures/no-private';

const privacy = NO_PRIVATE;

/**
 * Escritor único (SPEC.md §8, R4): bloqueo con PID y comprobación de vida, lectores en
 * solo lectura con `busy_other_instance`, huérfanos recuperados y relevo cuando el
 * poseedor muere. Los «otros procesos» son procesos de Node reales (`spawn`), para que
 * `process.kill(pid, 0)` compruebe PIDs de verdad.
 */

const dirs: string[] = [];
const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-lock-'));
  dirs.push(dir);
  return dir;
}

/** Un proceso de Node vivo hasta que se le mate. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  children.push(child);
  return child;
}

/** El PID de un proceso que ya terminó. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function writeLock(dataDir: string, pid: number, nonce = 'otro'): void {
  writeFileSync(
    join(dataDir, WRITER_LOCK_FILE),
    JSON.stringify({ pid, nonce, startedAt: new Date().toISOString() })
  );
}

async function open(dataDir: string, extra: Partial<Parameters<typeof LibraryInstance.open>[0]> = {}) {
  const instance = await LibraryInstance.open({
    dataDir,
    checkIntervalMs: null,
    ...extra,
    lock: { releaseOnExit: false, ...extra.lock }
  });
  instances.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) await killAndWait(child);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WriterLock', () => {
  it('se toma con wx y 0600, y solo lo suelta quien lo tiene', () => {
    const dataDir = tempDataDir();
    const a = new WriterLock({ dataDir, releaseOnExit: false });
    expect(a.tryAcquire()).toBe(true);
    const path = join(dataDir, WRITER_LOCK_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);

    const child = liveProcess();
    const b = new WriterLock({ dataDir, pid: child.pid!, releaseOnExit: false });
    expect(b.tryAcquire()).toBe(false);
    b.release();
    expect(existsSync(path)).toBe(true);
    a.release();
    expect(existsSync(path)).toBe(false);
    expect(b.tryAcquire()).toBe(true);
    b.release();
  });

  it('recupera un bloqueo huérfano (PID muerto)', async () => {
    const dataDir = tempDataDir();
    const pid = await deadPid();
    expect(processIsAlive(pid)).toBe(false);
    writeLock(dataDir, pid);
    const lock = new WriterLock({ dataDir, releaseOnExit: false });
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it('un fichero ilegible es de alguien a medio escribir; pasados 10 s, huérfano', () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_LOCK_FILE);
    writeFileSync(path, '');
    const lock = new WriterLock({ dataDir, releaseOnExit: false });
    expect(lock.tryAcquire()).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it('el mismo PID con otro nonce es de un proceso anterior: huérfano', () => {
    const dataDir = tempDataDir();
    writeLock(dataDir, process.pid, 'de-antes');
    const lock = new WriterLock({ dataDir, releaseOnExit: false });
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it('verify: si otro reemplazó el fichero, deja de ser dueño y no borra el ajeno', () => {
    const dataDir = tempDataDir();
    const lock = new WriterLock({ dataDir, releaseOnExit: false });
    expect(lock.tryAcquire()).toBe(true);
    const child = liveProcess();
    writeLock(dataDir, child.pid!, 'intruso');
    expect(lock.verify()).toBe(false);
    expect(lock.held).toBe(false);
    lock.release();
    expect(JSON.parse(readFileSync(join(dataDir, WRITER_LOCK_FILE), 'utf8')).nonce).toBe('intruso');
  });

  /**
   * Un proceso de Node real toma el bloqueo con `src/lock/writer-lock.ts` (solo importa
   * módulos de Node, así que corre con los tipos transformados por Node 24) y termina
   * por `process.exit` o por una señal: el fichero tiene que desaparecer.
   */
  async function childHoldingLock(dataDir: string, then: 'exit' | 'wait' | 'own-handler') {
    const source = new URL('../../src/lock/writer-lock.ts', import.meta.url).href;
    // `own-handler`: como `serve`, el proceso registra DESPUÉS su propio oyente de SIGTERM
    // (el apagado que vacía y cierra), que dice si el bloqueo seguía ahí al recibirla.
    const ownHandler = `
      const { existsSync } = await import('node:fs');
      process.once('SIGTERM', () => {
        process.stdout.write('sigterm lock=' + (existsSync(lock.path) ? 1 : 0) + '\\n');
      });
    `;
    const script = `
      const { WriterLock } = await import(${JSON.stringify(source)});
      const lock = new WriterLock({ dataDir: ${JSON.stringify(dataDir)} });
      if (!lock.tryAcquire()) process.exit(3);
      ${then === 'own-handler' ? ownHandler : ''}
      process.stdout.write('ready\\n');
      ${then === 'exit' ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}
    `;
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve();
      });
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`salida ${code}`))));
    });
    return child;
  }

  it('se suelta al salir el proceso (exit)', async () => {
    const dataDir = tempDataDir();
    const child = await childHoldingLock(dataDir, 'exit');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    expect(child.exitCode).toBe(0);
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
  });

  it('se suelta con SIGTERM y el proceso termina por la señal', async () => {
    const dataDir = tempDataDir();
    const child = await childHoldingLock(dataDir, 'wait');
    expect(JSON.parse(readFileSync(join(dataDir, WRITER_LOCK_FILE), 'utf8')).pid).toBe(child.pid);
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal))
    );
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
  });

  it('con un apagado propio escuchando SIGTERM no lo suelta (M1); una segunda señal sí, y termina', async () => {
    const dataDir = tempDataDir();
    const child = await childHoldingLock(dataDir, 'own-handler');
    const lines: string[] = [];
    const sigtermLine = new Promise<string>((resolve) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        const found = lines.find((line) => line.startsWith('sigterm'));
        if (found) resolve(found);
      });
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal))
    );

    child.kill('SIGTERM');
    // El apagado propio lo encuentra en su sitio, y sigue ahí con el proceso vivo.
    expect(await sigtermLine).toBe('sigterm lock=1');
    expect(child.exitCode).toBeNull();
    expect(JSON.parse(readFileSync(join(dataDir, WRITER_LOCK_FILE), 'utf8')).pid).toBe(child.pid);

    // Segunda señal, ya sin el oyente (`once`): suelta y termina por la señal.
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
  });
});

describe('LibraryInstance: escritor único', () => {
  it('segunda instancia: lecturas OK, escrituras busy_other_instance; relevo al cerrar la primera', async () => {
    const dataDir = tempDataDir();
    const first = await open(dataDir);
    expect(first.role).toBe('this');
    const note = await first.createNote({ body: '# Primera\n\n#compartida', privacy });

    const child = liveProcess(); // el PID que declara la segunda instancia
    const second = await open(dataDir, { lock: { pid: child.pid! } });
    expect(second.role).toBe('other_instance');
    expect((await second.port.noteRead(note.id))?.title).toBe('Primera');
    expect((await second.port.tagsList()).tags.map((tag) => tag.tag)).toEqual(['compartida']);
    expect((await second.port.search('Primera', null, 10)).items).toHaveLength(1);

    await expect(second.createNote({ body: '# Segunda', privacy })).rejects.toMatchObject({
      code: 'busy_other_instance'
    });
    await expect(second.appendToNote({ id: note.id, text: 'x', privacy })).rejects.toBeInstanceOf(
      StoreError
    );
    await expect(second.port.noteCreate(null)).rejects.toMatchObject({
      code: 'busy_other_instance'
    });
    expect((await second.status()).writer).toBe('other_instance');

    // Lo que escribe el escritor lo ve el lector sin reabrir (WAL).
    await first.appendToNote({ id: note.id, text: 'más', privacy });
    expect((await second.port.noteRead(note.id))?.body).toBe('# Primera\n\n#compartida\n\nmás');

    // Mientras el primero vive, la comprobación no cambia nada.
    await second.checkWriter();
    expect(second.role).toBe('other_instance');

    // El primero se va (suelta el bloqueo): el segundo toma el relevo.
    await first.close();
    await second.checkWriter();
    expect(second.role).toBe('this');
    const again = await second.appendToNote({ id: note.id, text: 'relevo', privacy });
    expect(again.outcome).toBe('saved');
    expect((await second.port.noteRead(note.id))?.body).toContain('relevo');
  });

  it('el poseedor muere sin soltar el bloqueo: la siguiente comprobación lo recupera', async () => {
    const dataDir = tempDataDir();
    // El escritor crea la base y se va sin soltar el bloqueo, que queda a nombre de un
    // proceso vivo; ese proceso muere después.
    const creator = await open(dataDir, { lock: { releaseOnExit: false } });
    await creator.createNote({ body: '# Antes', privacy });
    await creator.close();
    const owner = liveProcess();
    writeLock(dataDir, owner.pid!);

    const reader = await open(dataDir);
    expect(reader.role).toBe('other_instance');
    await reader.checkWriter();
    expect(reader.role).toBe('other_instance');

    await killAndWait(owner);
    await reader.checkWriter();
    expect(reader.role).toBe('this');
    await reader.createNote({ body: '# Después', privacy });
  });

  it('bloqueo huérfano al arrancar: la instancia arranca como escritora', async () => {
    const dataDir = tempDataDir();
    writeLock(dataDir, await deadPid());
    const instance = await open(dataDir);
    expect(instance.role).toBe('this');
    expect((await instance.createNote({ body: '# Hola', privacy })).title).toBe('Hola');
  });

  it('con sync: el escritor sincroniza tras escribir y el lector no sincroniza', async () => {
    const dataDir = tempDataDir();
    const relay = new InMemoryLibraryRelay();
    const sync = { transport: relay, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null };
    const writer = await open(dataDir, { sync });
    await writer.whenReady(5_000);
    const child = liveProcess();
    const reader = await open(dataDir, { sync, lock: { pid: child.pid! } });
    expect(reader.syncRunner).toBeNull();

    const created = await writer.createNote({ body: '# Desde Claude\n\n#mcp', privacy });
    // `createNote` ya pidió una ronda (onWritten); esta se encadena detrás.
    await writer.syncRunner!.requestRound();
    const app = await appDevice(relay);
    await app.sync.runRound();
    expect((await app.port.noteRead(created.id))?.title).toBe('Desde Claude');

    const status = await writer.status();
    expect(status).toMatchObject({ writer: 'this', lastSyncOutcome: 'ok', pendingUpload: 0 });
    expect(await reader.status()).toMatchObject({ writer: 'other_instance', pendingUpload: 0 });
  });
});

/**
 * M2 del audit de robustez (10 oct 2026): un relevo que choca con una transacción abierta
 * de otra conexión (el escritor viejo a mitad de un guardado). Antes `node:sqlite` abría
 * sin espera (`database is locked` al instante) y el bloqueo se quedaba en un proceso que
 * no escribía.
 */
describe('LibraryInstance: relevo con la base ocupada', () => {
  /** Crea la base y suelta el bloqueo, como un escritor que ya se fue. */
  async function createdLibrary(): Promise<string> {
    const dataDir = tempDataDir();
    const creator = await open(dataDir);
    await creator.createNote({ body: '# Antes', privacy });
    await creator.close();
    return dataDir;
  }

  it('una transacción corta de otro proceso: el relevo espera y abre como escritor', async () => {
    const dataDir = await createdLibrary();
    const sqlitePath = join(dataDir, 'library.sqlite');
    // Otro proceso con `BEGIN IMMEDIATE` durante 300 ms (menos que `SQLITE_BUSY_TIMEOUT_MS`).
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(${JSON.stringify(sqlitePath)});
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    children.push(holder);
    await new Promise<void>((resolve) =>
      holder.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      })
    );
    const instance = await open(dataDir);
    expect(instance.role).toBe('this');
    expect((await instance.createNote({ body: '# Después', privacy })).title).toBe('Después');
  });

  it('una transacción que no termina a tiempo: suelta el bloqueo y sigue de lectora', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dataDir = await createdLibrary();
    const owner = liveProcess();
    writeLock(dataDir, owner.pid!);
    const reader = await open(dataDir);
    expect(reader.role).toBe('other_instance');

    // El poseedor muere con una transacción abierta (aquí, de otra conexión de este
    // proceso: no la puede cerrar mientras SQLite espera, así que agota el plazo).
    const busy = new DatabaseSync(join(dataDir, 'library.sqlite'));
    busy.exec('BEGIN IMMEDIATE');
    try {
      await killAndWait(owner);
      await reader.checkWriter();
      expect(reader.role).toBe('other_instance');
      expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
      const logged = (stderr.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
      expect(logged).toContain('"event":"writer.takeover","result":"failed"');
    } finally {
      busy.exec('ROLLBACK');
      busy.close();
      stderr.mockRestore();
    }
    // Ya sin la transacción, el siguiente intento toma el relevo.
    await reader.checkWriter();
    expect(reader.role).toBe('this');
  });

  it('al arrancar: si no puede abrir la base, no se queda con el bloqueo', async () => {
    const dataDir = await createdLibrary();
    const busy = new DatabaseSync(join(dataDir, 'library.sqlite'));
    busy.exec('BEGIN IMMEDIATE');
    try {
      await expect(open(dataDir)).rejects.toThrow();
      expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
    } finally {
      busy.exec('ROLLBACK');
      busy.close();
    }
  });
});
