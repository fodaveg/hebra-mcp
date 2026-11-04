/**
 * Cuánto cuesta `oauth-tokens.json` sin máximo de familias (D22, SPEC.md §12.10): una rotación de
 * refresh (la escritura atómica entera, con sus `fsync`), una verificación de access y abrir el
 * fichero, con 100, 1 000, 5 000 y 10 000 familias. Fuera de la suite normal, porque mide milisegundos:
 * `npx vitest run --config vitest.perf.config.ts test/perf/oauth-tokens.perf.ts --maxWorkers=1`.
 *
 * Familias con la forma de una de Sumego, con su refresh cifrado de un tamaño real. Directorio
 * temporal que se borra al terminar. Imprime en stderr una línea JSON por tamaño (`oauth.tokens.perf`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tokensFilePath } from '../../src/oauth/files';
import { TokenStore } from '../../src/oauth/token-store';

const SIZES = [100, 1_000, 5_000, 10_000];
const WRITES = 50;
const VERIFICATIONS = 500;
const CLIENT = 'hebra-mcp-claude-ai';
const RESOURCE = 'https://mcp.hebra.pro/mcp';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

function percentile95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!;
}

function syntheticFamily(index: number, now: number): object {
  const expiresAt = new Date(now + 30 * 86400_000).toISOString();
  return {
    id: randomBytes(16).toString('base64url'), clientId: CLIENT, scope: 'hebra:mcp', resource: RESOURCE, createdAt: now,
    expiresAt: Date.parse(expiresAt), refreshHash: sha256(`r${index}`), previousRefreshHash: sha256(`p${index}`), rotatedAt: now,
    access: Array.from({ length: 4 }, (_, access) => ({ hash: sha256(`a${index}-${access}`), expiresAt: now + 3_600_000 })),
    grant: { active: true, credentialId: randomUUID(), clientId: CLIENT, resource: RESOURCE, scope: 'hebra:mcp',
      accountId: sha256(`cuenta-${index % 50}`), pairedCredentialId: randomUUID(), syncVaultId: sha256(`v${index}`).slice(0, 32),
      opaqueDeviceId: sha256(`d${index}`).slice(0, 32), expiresAt },
    sub: `sumego|persona-${index % 50}`, sid: randomUUID(),
    sumegoRefresh: randomBytes(180).toString('base64url'), sumegoRenewedAt: now
  };
}

describe('oauth-tokens.json con muchas familias', () => {
  it.each(SIZES)('%i familias', async (size) => {
    const dir = mkdtempSync(join(tmpdir(), 'hebra-tokens-perf-'));
    dirs.push(dir);
    const now = Date.now();
    writeFileSync(tokensFilePath(dir), JSON.stringify({ version: 3,
      families: Array.from({ length: size - 1 }, (_, index) => syntheticFamily(index, now)) }));

    const openStart = performance.now();
    const store = await TokenStore.open(dir);
    const openMs = performance.now() - openStart;

    const first = await store.issueFamily({ clientId: CLIENT, scope: 'hebra:mcp', resource: RESOURCE, authorizedAt: now,
      grant: { active: true, credentialId: randomUUID(), clientId: CLIENT, resource: RESOURCE, scope: 'hebra:mcp',
        accountId: sha256('medida'), pairedCredentialId: randomUUID(), syncVaultId: 'ab'.repeat(16), opaqueDeviceId: 'cd'.repeat(16),
        expiresAt: new Date(now + 30 * 86400_000).toISOString() },
      identity: { sub: 'sumego|medida', sid: null } }, 0, async () => undefined);
    expect(store.liveFamilyCount(0)).toBe(size);

    let current = first.refreshToken;
    let access = first.accessToken;
    const writes: number[] = [];
    for (let index = 0; index < WRITES; index += 1) {
      const start = performance.now();
      const outcome = await store.rotateRefresh(current, CLIENT, 0);
      writes.push(performance.now() - start);
      if (!outcome.ok) throw new Error(outcome.reason);
      current = outcome.tokens.refreshToken;
      access = outcome.tokens.accessToken;
    }

    const verifications: number[] = [];
    for (let index = 0; index < VERIFICATIONS; index += 1) {
      const start = performance.now();
      expect(store.verifyAccess(access, 0)).not.toBeNull();
      verifications.push(performance.now() - start);
    }

    process.stderr.write(`${JSON.stringify({
      event: 'oauth.tokens.perf', families: size, fileBytes: statSync(tokensFilePath(dir)).size,
      openMs: Math.round(openMs * 10) / 10,
      writeMsMedian: Math.round(median(writes) * 10) / 10, writeMsP95: Math.round(percentile95(writes) * 10) / 10,
      verifyMsMedian: Math.round(median(verifications) * 100) / 100, verifyMsP95: Math.round(percentile95(verifications) * 100) / 100
    })}\n`);
  }, 120_000);
});
