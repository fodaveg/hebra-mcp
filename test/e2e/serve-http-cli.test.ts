/**
 * `dist/cli.mjs serve-http` como proceso real (SPEC.md §12.2): sin el secreto del dueño
 * no arranca, sale con 1 y lo dice en stderr sin abrir la biblioteca ni el bloqueo.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.mjs');

describe('hebra-mcp serve-http (proceso real)', () => {
  let dataDir: string;

  beforeAll(() => {
    execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  }, 30_000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-e2e-http-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('sin el secreto del dueño sale con 1 y no abre la biblioteca', async () => {
    const child = spawn('node', [cliPath, 'serve-http'], {
      env: {
        ...process.env,
        HEBRA_MCP_DATA_DIR: dataDir,
        HEBRA_MCP_KEYRING_SERVICE: `hebra-mcp-e2e-${process.pid}-${Date.now()}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('oauth-set-secret');
    expect(stderr).toContain('"code":"auth_not_configured"');
    expect(existsSync(join(dataDir, 'library.sqlite'))).toBe(false);
    expect(existsSync(join(dataDir, 'writer.lock'))).toBe(false);
  }, 20_000);
});
