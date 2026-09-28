/** Recuperación de una concesión en ambos lados del commit de oauth-tokens.json. */
import { describe, expect, it } from 'vitest';
import { GrantSecrets } from '../../src/oauth/grants';
import { MemorySecretStore } from '../../src/secrets';

const codeHash = 'ab'.repeat(32);
const bearer = 'cd'.repeat(32);
const familyId = 'A'.repeat(22);

describe('promoción durable de una concesión', () => {
  it('si se corta antes del commit de la familia, reiniciar revoca el bearer upstream', async () => {
    const store = new MemorySecretStore();
    const first = await GrantSecrets.open(store, []);
    await first.stage(codeHash, bearer);
    await first.markPromoting(codeHash, familyId);
    await first.set(familyId, bearer, [familyId]);
    const reopened = await GrantSecrets.open(store, []); // oauth-tokens.json aún no contiene la familia
    const revoked: string[] = [];
    await GrantSecrets.recoverPending(store, [], reopened, async (token) => { revoked.push(token); });
    expect(revoked).toEqual([bearer]);
    expect(reopened.get(familyId)).toBeNull();
    expect(await store.get('hebra-mcp-oauth-pending')).toBe('{}');
  });

  it('si el commit ya contiene la familia, reiniciar conserva su bearer y limpia la marca', async () => {
    const store = new MemorySecretStore();
    const first = await GrantSecrets.open(store, []);
    await first.stage(codeHash, bearer);
    await first.markPromoting(codeHash, familyId);
    await first.set(familyId, bearer, [familyId]);
    const reopened = await GrantSecrets.open(store, [familyId]); // familia durable en oauth-tokens.json
    const revoked: string[] = [];
    await GrantSecrets.recoverPending(store, [familyId], reopened, async (token) => { revoked.push(token); });
    expect(revoked).toEqual([]);
    expect(reopened.get(familyId)).toBe(bearer);
    expect(await store.get('hebra-mcp-oauth-pending')).toBe('{}');
  });
});
