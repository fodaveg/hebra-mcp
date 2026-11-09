/** CLI real: el método owner antiguo no abre el servidor ni modifica el emparejado. */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  // Node 22 avisa por stderr de que node:sqlite es experimental; ese aviso es del runtime,
  // no del CLI, y rompe el JSON.parse del stderr. Solo se calla ese tipo de aviso.
  const child = spawn('node', ['--disable-warning=ExperimentalWarning', cliPath, ...args], { env: { ...process.env, HEBRA_MCP_DATA_DIR: dataDir,
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

  it('control-secrets-rollback copia de vuelta sin borrar control/secrets.json y no imprime valores', async () => {
    const value = JSON.stringify({ ['A'.repeat(22)]: 'a1'.repeat(32) });
    await mkdir(join(dataDir, 'control'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'secrets.json'), JSON.stringify({ 'recovery-code': 'personal-sintetico' }), { mode: 0o600 });
    writeFileSync(join(dataDir, 'control', 'secrets.json'), JSON.stringify({ 'hebra-mcp-oauth-grants': value }), { mode: 0o600 });

    const result = await run(['control-secrets-rollback']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ restored: ['hebra-mcp-oauth-grants'] });
    expect(result.stdout + result.stderr).not.toContain('a1'.repeat(32));
    expect(JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8'))).toEqual({
      'recovery-code': 'personal-sintetico', 'hebra-mcp-oauth-grants': value
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'control', 'secrets.json'), 'utf8'))).toMatchObject({
      'hebra-mcp-oauth-grants': value
    });
  });

  it('control-secrets-rollback rechaza el llavero, un conflicto y argumentos de más sin tocar nada', async () => {
    await mkdir(join(dataDir, 'control'), { recursive: true, mode: 0o700 });
    const control = JSON.stringify({ 'hebra-mcp-oauth-grants': '{}' });
    const legacy = JSON.stringify({ 'hebra-mcp-oauth-grants': '{"distinto":"x"}' });
    writeFileSync(join(dataDir, 'control', 'secrets.json'), control, { mode: 0o600 });
    writeFileSync(join(dataDir, 'secrets.json'), legacy, { mode: 0o600 });

    expect((await run(['control-secrets-rollback'], { HEBRA_MCP_SECRET_STORE: 'keychain' })).code).toBe(1);
    expect((await run(['control-secrets-rollback', 'de-mas'])).code).toBe(1);
    const conflict = await run(['control-secrets-rollback']);

    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stderr)).toMatchObject({ code: 'control_secrets_conflict' });
    expect(readFileSync(join(dataDir, 'control', 'secrets.json'), 'utf8')).toBe(control);
    expect(readFileSync(join(dataDir, 'secrets.json'), 'utf8')).toBe(legacy);
  });
});
