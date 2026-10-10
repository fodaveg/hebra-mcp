/**
 * E2 y E3 del audit de robustez del escritor (10 oct 2026), con procesos de verdad: el
 * escritor es un proceso hijo (`test/fixtures/robustez-child.ts`, empaquetado con esbuild
 * desde las fuentes, sin tocar `dist/`) con sync contra un relé que acepta TCP y nunca
 * responde, y este proceso hace de lector.
 *
 * - E2: el escritor muere (SIGKILL) con un `hebra_append_to_note` reenviado ya guardado y
 *   esperando la ronda. El lector responde `busy_other_instance`; el agente reintenta con
 *   el mismo `operationId`, el lector toma el relevo y el registro (en la misma SQLite)
 *   sirve el reintento: el texto queda UNA vez. Antes del arreglo el append no tenía
 *   `operationId` y el reintento lo dejaba dos veces.
 * - E3 (M1): SIGTERM al escritor con una ronda colgada en el relé. El bloqueo sigue siendo
 *   suyo mientras vacía (otro proceso que abre ahora queda de lector) y lo suelta al
 *   terminar. Antes del arreglo `WriterLock` lo soltaba al recibir la señal, antes que el
 *   apagado de `serve`, y entraba un segundo escritor con el viejo vivo.
 *
 * Los directorios de datos van a `os.tmpdir()`: la ruta de `writer.sock` no puede pasar de
 * 104 bytes en macOS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITER_LOCK_FILE } from '../../src/lock/writer-lock';
import { buildRoutedWriteContext } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { isBusyOtherInstance } from '../../src/store/errors';
import type { AppendToNoteInput } from '../../src/store/writes';
import { LibraryInstance } from '../../src/sync/library-instance';
import { NO_PRIVATE } from '../fixtures/no-private';

const root = fileURLToPath(new URL('../..', import.meta.url));
/** Dentro del repo para que el paquete encuentre `node_modules` (dependencias externas). */
const bundleDir = join(root, 'node_modules', '.cache', 'hebra-mcp-test');
const childPath = join(bundleDir, `robustez-child-${process.pid}.mjs`);

const dirs: string[] = [];
const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];
const relays: Array<{ server: Server; sockets: Set<Socket> }> = [];

beforeAll(async () => {
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test', 'fixtures', 'robustez-child.ts')],
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    // Como `scripts/build.mjs`: sin esto esbuild usaría el tsconfig de `vendor/hebra`.
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

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const relay of relays.splice(0)) {
    for (const socket of relay.sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function shortDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hr-'));
  dirs.push(dir);
  return dir;
}

/** Relé mudo: acepta la conexión y nunca responde. `connected` resuelve con la primera. */
async function silentRelay(): Promise<{
  origin: string;
  connected: Promise<void>;
  cut(): void;
}> {
  const sockets = new Set<Socket>();
  let markConnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.resume();
    markConnected();
  });
  relays.push({ server, sockets });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    connected,
    /** Corta las conexiones colgadas: la ronda en vuelo termina (sin red). */
    cut: () => {
      for (const socket of sockets) socket.destroy();
    }
  };
}

interface Child {
  proc: ChildProcess;
  line(prefix: string): Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launchWriter(dataDir: string, relayOrigin: string): Child {
  const proc = spawn(process.execPath, [childPath, 'hang', dataDir, relayOrigin], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  children.push(proc);
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let buffered = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
    for (const wake of [...waiters]) wake();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal }))
  );
  return {
    proc,
    exited,
    line(prefix) {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const found = lines.find((entry) => entry.startsWith(prefix));
          if (found !== undefined) {
            waiters.delete(check);
            resolve(found);
          } else if (lines.some((entry) => entry.startsWith('fatal'))) {
            waiters.delete(check);
            reject(new Error(`el hijo falló: ${lines.join(' | ')}`));
          }
        };
        waiters.add(check);
        check();
        void exited.then(() => {
          if (waiters.has(check)) {
            waiters.delete(check);
            reject(new Error(`el hijo salió sin «${prefix}»: ${lines.join(' | ')}`));
          }
        });
      });
    }
  };
}

async function openReader(dataDir: string): Promise<LibraryInstance> {
  const reader = await LibraryInstance.open({ dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
  instances.push(reader);
  return reader;
}

function copies(body: string, text: string): number {
  return body.split(text).length - 1;
}

describe('E2: el escritor muere con un append reenviado ya guardado', () => {
  it('el reintento con el mismo operationId no duplica el texto', async () => {
    const relay = await silentRelay();
    const dataDir = shortDataDir();
    const writer = launchWriter(dataDir, relay.origin);
    const id = (await writer.line('ready ')).slice('ready '.length);
    const reader = await openReader(dataDir);
    expect(reader.role).toBe('other_instance');
    const write = buildRoutedWriteContext(reader, localWriteContext(reader));
    const text = 'CEBO-E2-append-7c1d';
    const input: AppendToNoteInput = { id, text, operationId: 'op-e2-1', privacy: NO_PRIVATE };

    const pending = write.appendToNote(input).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    // El escritor ya guardó (el lector lo ve en la SQLite compartida) y espera la ronda,
    // colgada en el relé mudo: es el momento de matarlo.
    for (;;) {
      const body = (await reader.port.noteRead(id))?.body ?? '';
      if (body.includes(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writer.proc.kill('SIGKILL');
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && isBusyOtherInstance(outcome.error)).toBe(true);
    expect(copies((await reader.port.noteRead(id))!.body, text)).toBe(1);
    await writer.exited;

    // El agente, al ver `busy_other_instance`, reintenta con el mismo `operationId`.
    const retry = await write.appendToNote(input);
    expect(reader.role).toBe('this');
    const body = (await reader.port.noteRead(id))!.body;
    expect(copies(body, text)).toBe(1);
    expect(retry).toMatchObject({ id, outcome: 'saved', replayed: true });
    // La prueba de lo guardado es la de la primera vez, leída del registro.
    expect(retry.outcome === 'saved' && retry.appended?.tail).toBe(text);
    expect(retry.outcome === 'saved' && retry.totalChars).toBe(body.length);
  }, 60_000);
});

describe('E3: SIGTERM al escritor con una ronda colgada en el relé', () => {
  it('el bloqueo sigue siendo suyo mientras vacía y lo suelta al terminar', async () => {
    const relay = await silentRelay();
    const dataDir = shortDataDir();
    const writer = launchWriter(dataDir, relay.origin);
    await writer.line('ready ');
    // La ronda de arranque ya está colgada en el relé.
    await relay.connected;

    writer.proc.kill('SIGTERM');
    // En el oyente de `serve`: el bloqueo tiene que seguir en su sitio.
    expect(await writer.line('sigterm ')).toBe('sigterm lock=1');
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(true);

    // Con el viejo vivo y vaciando (esperando la ronda), otro proceso no se hace escritor.
    expect(writer.proc.exitCode).toBeNull();
    const intruder = await openReader(dataDir);
    expect(intruder.role).toBe('other_instance');
    expect(writer.proc.exitCode).toBeNull();

    // La ronda termina (el relé corta) y el apagado acaba: suelta el bloqueo y sale con 0.
    relay.cut();
    await writer.line('closed');
    expect(await writer.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);
    await intruder.checkWriter();
    expect(intruder.role).toBe('this');
  }, 60_000);
});
