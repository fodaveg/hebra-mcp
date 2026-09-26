/**
 * `dist/cli.mjs` como proceso real para el conector remoto (SPEC.md §12.2):
 * - `serve-http` sin el secreto del dueño no arranca: sale con 1 y lo dice en stderr sin
 *   abrir la biblioteca ni el bloqueo.
 * - `oauth-set-secret` lee el secreto por stdin (nunca argumentos ni entorno); con él,
 *   `serve-http` arranca, `/healthz` responde y `/mcp` sin token da 401 con
 *   `resource_metadata`; `oauth-revoke-all` sale con 0.
 *
 * Almacén de secretos del dispositivo en fichero (`HEBRA_MCP_SECRET_STORE=file`, C1): así
 * el test no toca nunca el llavero de David.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.mjs');
const SECRET = 'secreto-e2e-del-dueño-0123456789-abcdefghij';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe('hebra-mcp serve-http y oauth-* (proceso real)', () => {
  let dataDir: string;
  let children: ChildProcess[] = [];

  beforeAll(() => {
    execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  }, 30_000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-e2e-http-'));
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    children = [];
    await rm(dataDir, { recursive: true, force: true });
  });

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, HEBRA_MCP_DATA_DIR: dataDir, HEBRA_MCP_SECRET_STORE: 'file', ...extra };
  }

  function run(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn('node', [cliPath, ...args], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdin!.end(stdin ?? '');
    return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
  }

  it('serve-http sin el secreto del dueño sale con 1 y no abre la biblioteca', async () => {
    const { code, stderr } = await run(['serve-http']);
    expect(code).toBe(1);
    expect(stderr).toContain('oauth-set-secret');
    expect(stderr).toContain('"code":"auth_not_configured"');
    expect(existsSync(join(dataDir, 'library.sqlite'))).toBe(false);
    expect(existsSync(join(dataDir, 'writer.lock'))).toBe(false);
  }, 20_000);

  it('oauth-set-secret por stdin, serve-http arranca con 401 en /mcp, y oauth-revoke-all', async () => {
    const tooShort = await run(['oauth-set-secret'], 'corto\n');
    expect(tooShort.code).toBe(1);

    const set = await run(['oauth-set-secret'], `${SECRET}\n`);
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(SECRET);
    expect(readFileSync(join(dataDir, 'oauth-owner.json'), 'utf8')).not.toContain(SECRET);

    const port = await freePort();
    const server = spawn('node', [cliPath, 'serve-http'], {
      env: env({ HEBRA_MCP_HTTP_PORT: String(port), HEBRA_MCP_PUBLIC_URL: 'http://127.0.0.1' }),
      stdio: ['ignore', 'ignore', 'pipe']
    });
    children.push(server);
    let serverStderr = '';
    server.stderr!.on('data', (chunk: Buffer) => (serverStderr += chunk.toString('utf8')));

    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const health = await fetch(`${origin}/healthz`).catch(() => null);
      if (health?.status === 204) break;
      if (Date.now() > deadline) throw new Error(`serve-http no arrancó: ${serverStderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const unauthorized = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"'
    );

    const revoke = await run(['oauth-revoke-all']);
    expect(revoke.code).toBe(0);

    const exited = new Promise<number | null>((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(serverStderr).not.toContain(SECRET);
  }, 30_000);
});
