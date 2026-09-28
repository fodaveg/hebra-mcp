/** CLI real: el método owner antiguo no abre el servidor ni modifica el emparejado. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.mjs');
let dataDir: string;

beforeAll(() => { execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' }); }, 30_000);
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-e2e-http-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

function run(args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn('node', [cliPath, ...args], { env: { ...process.env, HEBRA_MCP_DATA_DIR: dataDir,
    HEBRA_MCP_SECRET_STORE: 'file', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
}

describe('serve-http y mantenimiento OAuth', () => {
  it('sin broker configurado sale antes de abrir biblioteca o writer.lock', async () => {
    const result = await run(['serve-http']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('HEBRA_MCP_BACKCHANNEL_SECRET');
    expect(existsSync(join(dataDir, 'library.sqlite'))).toBe(false);
    expect(existsSync(join(dataDir, 'writer.lock'))).toBe(false);
  });

  it('oauth-set-secret falla explícitamente y oauth-revoke-all usa la marca v2', async () => {
    const old = await run(['oauth-set-secret']);
    expect(old.code).toBe(1);
    expect(old.stderr).toContain('sustituido');
    expect(existsSync(join(dataDir, 'oauth-owner.json'))).toBe(false);
    const revoked = await run(['oauth-revoke-all']);
    expect(revoked.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dataDir, 'oauth-revocations-v2.json'), 'utf8'))).toMatchObject({ version: 2 });
  });
});
