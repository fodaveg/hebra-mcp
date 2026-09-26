/**
 * Reenvío de escrituras entre procesos `serve` REALES (SPEC.md §8): Claude Code lanza un
 * proceso por sesión, el primero toma `writer.lock` y los demás son lectores. Aquí cada
 * «sesión» es `dist/cli.mjs serve` como proceso hijo, hablando MCP por stdio con el
 * cliente del SDK, sobre un directorio de datos temporal y sin emparejar (sin relé: el
 * sync no entra en juego; el conflicto con sync está en `test/forward/forward.test.ts`).
 *
 * Cada test mata sus procesos al acabar (`afterEach`): con `client.close()` los que
 * siguen vivos y con SIGKILL los que quedaran, para no dejar huérfanos.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WRITER_SOCKET_FILE } from '../../src/ipc/writer-socket';
import { WRITER_LOCK_FILE, processIsAlive } from '../../src/lock/writer-lock';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.mjs');

/** Cebos: si alguno aparece en el stderr de algún proceso, se filtró contenido (§6.4). */
const BAIT_BODY = 'CEBO-CUERPO-reenvio-7f3a';
const BAIT_TEXT = 'CEBO-TEXTO-reenvio-91c2';
const BAIT_TITLE = 'CEBO-TITULO-reenvio-5d0e';

interface Session {
  client: Client;
  pid: number;
  stderr(): string;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function call(
  session: Session,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; value: Record<string, unknown> }> {
  const result = (await session.client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: result.isError === true, value: JSON.parse(textOf(result)) };
}

function lockPid(dataDir: string): number {
  return JSON.parse(readFileSync(join(dataDir, WRITER_LOCK_FILE), 'utf8')).pid as number;
}

function socketMode(dataDir: string): number {
  return statSync(join(dataDir, WRITER_SOCKET_FILE)).mode & 0o777;
}

function socketInode(dataDir: string): number {
  return statSync(join(dataDir, WRITER_SOCKET_FILE)).ino;
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid)) {
    if (Date.now() > deadline) throw new Error('el proceso no murió');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Líneas JSON de stderr con ese `event`. */
function events(session: Session, event: string): Array<Record<string, unknown>> {
  return session
    .stderr()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

describe('reenvío de escrituras entre procesos serve reales (SPEC.md §8)', () => {
  let dataDir: string;
  let sessions: Session[] = [];

  beforeAll(() => {
    execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  }, 30_000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-fwd-'));
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      if (processIsAlive(session.pid)) await session.client.close();
      if (processIsAlive(session.pid)) process.kill(session.pid, 'SIGKILL');
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  async function start(): Promise<Session> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'serve'],
      // Servicio del llavero propio y vacío, como `stdio-server.test.ts`: `serve` lo lee
      // al arrancar y este test no puede leer nunca los secretos reales.
      env: {
        ...process.env,
        HEBRA_MCP_DATA_DIR: dataDir,
        HEBRA_MCP_KEYRING_SERVICE: `hebra-mcp-fwd-${process.pid}-${Date.now()}`
      } as Record<string, string>,
      stderr: 'pipe'
    });
    const chunks: string[] = [];
    transport.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const client = new Client({ name: 'hebra-mcp-fwd', version: '0.0.0' });
    await client.connect(transport);
    const session: Session = { client, pid: transport.pid!, stderr: () => chunks.join('') };
    sessions.push(session);
    return session;
  }

  function expectNoBaitInStderr(): void {
    for (const session of sessions) {
      const stderr = session.stderr();
      for (const bait of [BAIT_BODY, BAIT_TEXT, BAIT_TITLE]) expect(stderr).not.toContain(bait);
      // `write.forward` y `writer.socket.request` no llevan ids de nota (§6.4).
      for (const entry of [
        ...events(session, 'write.forward'),
        ...events(session, 'writer.socket.request')
      ]) {
        expect(Object.keys(entry).sort()).not.toContain('id');
        expect(JSON.stringify(entry)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
    }
  }

  it('con escritor y lector vivos: crear y añadir desde el lector, visible en los dos', async () => {
    const writer = await start();
    const reader = await start();

    expect((await call(writer, 'hebra_status')).value).toMatchObject({ writer: 'this' });
    expect((await call(reader, 'hebra_status')).value).toMatchObject({
      linked: false,
      writer: 'other_instance'
    });
    expect(lockPid(dataDir)).toBe(writer.pid);
    expect(socketMode(dataDir)).toBe(0o600);

    const body = `# ${BAIT_TITLE}\n\n${BAIT_BODY}\n`;
    const created = await call(reader, 'hebra_create_note', { body });
    expect(created.isError).toBe(false);
    expect(created.value).toMatchObject({ title: BAIT_TITLE });
    const id = created.value.id as string;

    for (const session of [writer, reader]) {
      const read = await call(session, 'hebra_read_note', { id });
      expect(read.value).toMatchObject({ id, body });
    }

    const appended = await call(reader, 'hebra_append_to_note', { id, text: BAIT_TEXT });
    expect(appended.value).toEqual({ id, outcome: 'saved' });
    for (const session of [writer, reader]) {
      expect((await call(session, 'hebra_read_note', { id })).value.body).toBe(
        `${body}\n\n${BAIT_TEXT}`
      );
    }

    // El lector sigue siendo lector: las escrituras las hizo el escritor.
    expect((await call(reader, 'hebra_status')).value).toMatchObject({ writer: 'other_instance' });
    expect(events(reader, 'write.forward').map((entry) => [entry.op, entry.outcome])).toEqual(
      expect.arrayContaining([
        ['createNote', 'forwarded'],
        ['appendToNote', 'forwarded'],
        ['status', 'forwarded']
      ])
    );
    expect(
      events(writer, 'writer.socket.request').filter((entry) => entry.outcome === 'ok')
    ).toHaveLength(4); // 2 status + createNote + appendToNote
    expectNoBaitInStderr();

    // Cierre limpio del escritor: se lleva su socket y su bloqueo.
    await writer.client.close();
    await waitUntilDead(writer.pid);
    expect(existsSync(join(dataDir, WRITER_SOCKET_FILE))).toBe(false);
    expect(existsSync(join(dataDir, WRITER_LOCK_FILE))).toBe(false);

    // Sin escritor ni socket: el lector toma el relevo en la siguiente escritura.
    const again = await call(reader, 'hebra_append_to_note', { id, text: 'tras el cierre' });
    expect(again.value).toEqual({ id, outcome: 'saved' });
    expect(lockPid(dataDir)).toBe(reader.pid);
    expect(events(reader, 'write.forward').at(-1)).toMatchObject({
      op: 'appendToNote',
      outcome: 'takeover',
      reason: 'no_socket'
    });
  }, 60_000);

  it('SIGKILL del escritor: la siguiente escritura del lector toma el bloqueo y escribe', async () => {
    const writer = await start();
    const reader = await start();
    const staleInode = socketInode(dataDir);

    process.kill(writer.pid, 'SIGKILL');
    await waitUntilDead(writer.pid);
    // Sin limpieza: el bloqueo y el socket del muerto siguen ahí.
    expect(lockPid(dataDir)).toBe(writer.pid);
    expect(existsSync(join(dataDir, WRITER_SOCKET_FILE))).toBe(true);

    const created = await call(reader, 'hebra_create_note', { body: `# Tras SIGKILL\n\n${BAIT_BODY}` });
    expect(created.isError).toBe(false);
    expect(created.value).toMatchObject({ title: 'Tras SIGKILL' });

    expect(lockPid(dataDir)).toBe(reader.pid);
    expect(socketInode(dataDir)).not.toBe(staleInode);
    expect(socketMode(dataDir)).toBe(0o600);
    expect((await call(reader, 'hebra_status')).value).toMatchObject({ writer: 'this' });
    expect(events(reader, 'write.forward').at(-1)).toMatchObject({
      op: 'createNote',
      outcome: 'takeover',
      reason: 'refused'
    });
    expect(
      (await call(reader, 'hebra_read_note', { id: created.value.id as string })).value
    ).toMatchObject({ title: 'Tras SIGKILL' });
    expectNoBaitInStderr();
  }, 60_000);

  it('bloqueo y socket huérfanos tras SIGKILL: un serve nuevo los recupera y atiende a los lectores', async () => {
    const first = await start();
    const reader = await start();
    const staleInode = socketInode(dataDir);

    process.kill(first.pid, 'SIGKILL');
    await waitUntilDead(first.pid);

    const next = await start();
    expect((await call(next, 'hebra_status')).value).toMatchObject({ writer: 'this' });
    expect(lockPid(dataDir)).toBe(next.pid);
    expect(socketInode(dataDir)).not.toBe(staleInode);
    expect(socketMode(dataDir)).toBe(0o600);

    // El lector de antes reenvía al escritor nuevo, sin tomar él el relevo.
    const created = await call(reader, 'hebra_create_note', { body: `# Al nuevo\n\n${BAIT_BODY}` });
    expect(created.isError).toBe(false);
    expect(events(reader, 'write.forward').at(-1)).toMatchObject({
      op: 'createNote',
      outcome: 'forwarded'
    });
    expect((await call(reader, 'hebra_status')).value).toMatchObject({ writer: 'other_instance' });
    expect(
      (await call(next, 'hebra_read_note', { id: created.value.id as string })).value
    ).toMatchObject({ title: 'Al nuevo' });
    expectNoBaitInStderr();
  }, 60_000);
});
