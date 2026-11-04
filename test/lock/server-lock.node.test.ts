/**
 * `control/server.lock` y la clasificación de `writer.lock` (D22, §12.10, "Bloqueos tras una
 * caída"). Los otros `serve-http` son procesos de verdad (`test/fixtures/server-lock-child.ts`,
 * empaquetado desde las fuentes): lo que se prueba es que el kernel suelta el bloqueo con un
 * SIGKILL y que lo ve otro proceso. El SIGKILL con el PID repetido no se puede dar en un mismo
 * proceso: se simula con el fichero exacto que deja, con este PID y otro arranque.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../../src/accounts';
import { httpConfigFor } from '../../src/http/config';
import { startServeHttp, type ServeHttpHandle } from '../../src/http/serve-http';
import { acquireServerLock, classifyWriterLock, SERVER_LOCK_FILE, WRITER_LOCK_FILE, WriterLock,
  type ServerLock } from '../../src/lock';
import type { OAuthHttpAuth } from '../../src/oauth/http-auth';
import { MemorySecretStore } from '../../src/secrets';
import { openServeContext, WriterRequiredError } from '../../src/server/serve';
import { staticBearerAuth } from '../fixtures/http-app';

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundleDir = join(root, 'node_modules', '.cache', 'hebra-mcp-test');
const childPath = join(bundleDir, `server-lock-child-${process.pid}.mjs`);

/** Estos tests lanzan procesos de Node: el margen es para eso, no mide nada. */
const SPAWN_TIMEOUT_MS = 30_000;

const dirs: string[] = [];
const children: ChildProcess[] = [];
const locks: ServerLock[] = [];
const handles: ServeHttpHandle[] = [];

beforeAll(async () => {
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [join(root, 'test', 'fixtures', 'server-lock-child.ts')],
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

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  for (const lock of locks.splice(0)) lock.release();
  for (const child of children.splice(0)) await killAndWait(child);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Layout { dataDir: string; controlDir: string; accountDir: string }

function layout(): Layout {
  const dataDir = mkdtempSync(join(tmpdir(), 'hebra-server-lock-'));
  dirs.push(dataDir);
  const controlDir = join(dataDir, 'control');
  const accountDir = join(dataDir, 'accounts', 'a');
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(accountDir, { recursive: true });
  return { dataDir, controlDir, accountDir };
}

function boot({ dataDir, controlDir }: Layout): ServerLock {
  const lock = acquireServerLock(dataDir, controlDir);
  if (!lock) throw new Error('server.lock ocupado');
  locks.push(lock);
  return lock;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

/** Lanza el hijo y devuelve su primera línea: `ready <bootId>` o `busy`. */
async function launch({ dataDir, controlDir, accountDir }: Layout): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, ['--no-warnings', childPath, dataDir, controlDir, accountDir], {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  children.push(child);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve(out.trim());
    });
    child.once('exit', (code) => { if (!out) reject(new Error(`salida ${code}`)); });
  });
  return { child, line };
}

/** Un proceso vivo que no es este: la orden por `compose exec` del contrato. */
function liveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

function writeLock(dir: string, content: { pid: number; serverBootId?: string; nonce?: string }): string {
  const text = JSON.stringify({ nonce: 'de-otro', startedAt: new Date(0).toISOString(), ...content });
  writeFileSync(join(dir, WRITER_LOCK_FILE), text);
  return text;
}

function serverOptions(dataDir: string, auth: OAuthHttpAuth) {
  return { dataDir, secrets: new MemorySecretStore(), multiuser: true, config: httpConfigFor('http://127.0.0.1', 0),
    version: '0.0.0-test', authConfigured: () => true, loadAuth: async () => auth };
}

async function multiuserAuth(dataDir: string): Promise<OAuthHttpAuth> {
  const registry = await AccountRegistry.open(dataDir);
  return { ...staticBearerAuth('token'), accounts: registry,
    provider: { attachRemotePairing() {}, invalidateAccount: async () => 0 },
    lumbreOrigin: 'https://app.lumbre.pro' } as unknown as OAuthHttpAuth;
}

describe('control/server.lock', () => {
  it('un proceso vivo excluye a otro serve-http; un SIGKILL lo libera sin limpiar nada', async () => {
    const paths = layout();
    const { child, line } = await launch(paths);
    expect(line).toMatch(/^ready /);

    expect(acquireServerLock(paths.dataDir, paths.controlDir)).toBeNull();
    expect((await launch(paths)).line).toBe('busy');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const auth = await multiuserAuth(paths.dataDir);
    await expect(startServeHttp(serverOptions(paths.dataDir, auth))).rejects.toBeInstanceOf(WriterRequiredError);

    await killAndWait(child);

    const handle = await startServeHttp(serverOptions(paths.dataDir, auth));
    handles.push(handle);
    expect(existsSync(join(paths.controlDir, SERVER_LOCK_FILE))).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it('el writer.lock del servidor muerto queda obsoleto aunque su PID siga vivo en otro proceso', async () => {
    const paths = layout();
    const { child, line } = await launch(paths);
    const previousBoot = line.split(' ')[1]!;
    const left = JSON.parse(readFileSync(join(paths.accountDir, WRITER_LOCK_FILE), 'utf8')) as Record<string, unknown>;
    expect(left).toMatchObject({ pid: child.pid, serverBootId: previousBoot });
    await killAndWait(child);

    const current = boot(paths);
    expect(current.bootId).not.toBe(previousBoot);
    // Mismo arranque anterior, con el PID reutilizado por un proceso que no tiene nada que ver.
    const unrelated = liveProcess();
    writeLock(paths.accountDir, { pid: unrelated.pid!, serverBootId: previousBoot });
    expect(classifyWriterLock(paths.accountDir)).toBe('stale');
  }, SPAWN_TIMEOUT_MS);

  it('dos arranques en el mismo proceso: el segundo no toma nada ni suelta el primero', () => {
    const paths = layout();
    const first = boot(paths);
    expect(acquireServerLock(paths.dataDir, paths.controlDir)).toBeNull();
    const writer = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(writer.tryAcquire()).toBe(true);
    expect(JSON.parse(readFileSync(writer.path, 'utf8')).serverBootId).toBe(first.bootId);
    writer.release();
  });

  it('soltarlo deja entrar a otro arranque con otro identificador, y deja el fichero en su sitio', async () => {
    const paths = layout();
    const first = boot(paths);
    first.release();
    first.release();
    const path = join(paths.controlDir, SERVER_LOCK_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(paths.controlDir)).toEqual([SERVER_LOCK_FILE]);
    const second = boot(paths);
    expect(second.bootId).not.toBe(first.bootId);
    expect((await launch(paths)).line).toBe('busy');
  }, SPAWN_TIMEOUT_MS);
});

describe('classifyWriterLock', () => {
  it('sin fichero: none', () => {
    const paths = layout();
    boot(paths);
    expect(classifyWriterLock(paths.accountDir)).toBe('none');
    expect(classifyWriterLock(join(paths.accountDir, 'no-existe'))).toBe('none');
  });

  it('SIGKILL con el PID repetido: otro arranque y este PID, obsoleto; se limpia al tomarlo', () => {
    const paths = layout();
    const current = boot(paths);
    writeLock(paths.accountDir, { pid: process.pid, serverBootId: 'arranque-anterior' });
    expect(classifyWriterLock(paths.accountDir)).toBe('stale');
    const writer = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(writer.tryAcquire()).toBe(true);
    expect(JSON.parse(readFileSync(writer.path, 'utf8'))).toMatchObject({ pid: process.pid, serverBootId: current.bootId });
    writer.release();
    expect(classifyWriterLock(paths.accountDir)).toBe('none');
  });

  it('un binario anterior a D22 murió con este PID (sin identificador): obsoleto', () => {
    const paths = layout();
    boot(paths);
    writeLock(paths.accountDir, { pid: process.pid });
    expect(classifyWriterLock(paths.accountDir)).toBe('stale');
    const writer = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(writer.tryAcquire()).toBe(true);
    writer.release();
  });

  it('de este arranque: no se le quita a su dueño, ni desde el mismo proceso', () => {
    const paths = layout();
    boot(paths);
    const holder = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(holder.tryAcquire()).toBe(true);
    expect(classifyWriterLock(paths.accountDir)).toBe('this-boot');
    const second = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(second.tryAcquire()).toBe(false);
    expect(holder.verify()).toBe(true);
    holder.release();
    expect(second.tryAcquire()).toBe(true);
    second.release();
  });

  it('una orden externa viva bloquea y la apertura falla; al morir, queda obsoleta y se abre', async () => {
    const paths = layout();
    boot(paths);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const open = () => openServeContext({ dataDir: paths.accountDir, secrets: null, writerOnly: true,
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false } } });
    // La biblioteca ya existe: sin ella, un lector espera a que el escritor la cree.
    await (await open()).close();
    const external = liveProcess();
    const text = writeLock(paths.accountDir, { pid: external.pid! });
    expect(classifyWriterLock(paths.accountDir)).toBe('other-process');
    await expect(open()).rejects.toBeInstanceOf(WriterRequiredError);
    expect(readFileSync(join(paths.accountDir, WRITER_LOCK_FILE), 'utf8')).toBe(text);

    await killAndWait(external);
    expect(classifyWriterLock(paths.accountDir)).toBe('stale');
    const opened = await open();
    expect(classifyWriterLock(paths.accountDir)).toBe('this-boot');
    await opened.close();
    expect(classifyWriterLock(paths.accountDir)).toBe('none');
  }, SPAWN_TIMEOUT_MS);

  it('abrir limpia el obsoleto con el mismo PID, y lo que abre lleva este arranque', async () => {
    const paths = layout();
    const current = boot(paths);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeLock(paths.accountDir, { pid: process.pid, serverBootId: 'arranque-anterior' });
    const opened = await openServeContext({ dataDir: paths.accountDir, secrets: null, writerOnly: true,
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false } } });
    expect(JSON.parse(readFileSync(join(paths.accountDir, WRITER_LOCK_FILE), 'utf8')).serverBootId).toBe(current.bootId);
    await opened.close();
  });

  it('un proceso muerto, sin arranque que valga: obsoleto', async () => {
    const paths = layout();
    boot(paths);
    writeLock(paths.accountDir, { pid: await deadPid() });
    expect(classifyWriterLock(paths.accountDir)).toBe('stale');
  });

  it('ilegible: alguien lo está escribiendo; pasados 10 s, obsoleto', () => {
    const paths = layout();
    boot(paths);
    const path = join(paths.accountDir, WRITER_LOCK_FILE);
    writeFileSync(path, '');
    const written = statSync(path).mtimeMs;
    expect(classifyWriterLock(paths.accountDir, { now: () => written + 1_000 })).toBe('other-process');
    expect(classifyWriterLock(paths.accountDir, { now: () => written + 60_000 })).toBe('stale');
  });

  it('el identificador se ve bajo la raíz, también en un espacio, y no fuera de ella', () => {
    const paths = layout();
    const current = boot(paths);
    const space = join(paths.accountDir, 'spaces', 's');
    mkdirSync(space, { recursive: true });
    const inSpace = new WriterLock({ dataDir: space, releaseOnExit: false });
    expect(inSpace.tryAcquire()).toBe(true);
    expect(JSON.parse(readFileSync(inSpace.path, 'utf8')).serverBootId).toBe(current.bootId);
    inSpace.release();

    const outside = layout();
    const foreign = new WriterLock({ dataDir: outside.accountDir, releaseOnExit: false });
    expect(foreign.tryAcquire()).toBe(true);
    expect(JSON.parse(readFileSync(foreign.path, 'utf8'))).not.toHaveProperty('serverBootId');
    foreign.release();
  });

  it('fuera de serve-http: un mismo PID no se puede probar anterior, y el servidor vivo bloquea', () => {
    const paths = layout();
    writeLock(paths.accountDir, { pid: process.pid });
    expect(classifyWriterLock(paths.accountDir)).toBe('this-boot');
    const server = liveProcess();
    writeLock(paths.accountDir, { pid: server.pid!, serverBootId: 'del-servidor-vivo' });
    expect(classifyWriterLock(paths.accountDir)).toBe('other-process');
    const order = new WriterLock({ dataDir: paths.accountDir, releaseOnExit: false });
    expect(order.tryAcquire()).toBe(false);
  });
});
