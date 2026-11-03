import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import { AccountRegistry, accountDataDir } from '../../src/accounts/registry';
import { AccountRemovalService } from '../../src/accounts/removal';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import { MemorySecretStore } from '../../src/secrets';

const dirs: string[] = [];
const grant: ActiveGrant = { active: true, credentialId: '00000000-0000-4000-8000-000000000001',
  clientId: 'hebra-mcp-claude', resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp',
  accountId: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z',
  pairedCredentialId: '10000000-0000-4000-8000-000000000001', syncVaultId: '1'.repeat(32),
  opaqueDeviceId: '2'.repeat(32) };

afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });

describe('AccountRemovalService', () => {
  it('no borra hasta confirmar la revocación y reanuda la lápida tras reiniciar', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-removal-'));
    dirs.push(dataDir);
    const registry = await AccountRegistry.open(dataDir);
    const account = await registry.commitAccount({ sub: 'mikel', grant });
    const personal = accountDataDir(dataDir, account);
    await mkdir(personal, { recursive: true });
    await writeFile(join(personal, 'library.sqlite'), 'personal');
    const contexts = new AccountContexts(registry, async () => { throw new Error('unexpected_open'); });
    let available = false;
    const service = new AccountRemovalService({ dataDir, registry, contexts,
      oauth: { invalidateAccount: async () => 1 },
      revokeDevice: async () => { if (!available) throw new Error('unavailable'); },
      legacySecrets: new MemorySecretStore() });

    await expect(service.remove(account)).rejects.toThrow('unavailable');
    expect(registry.findById(account.id)).toMatchObject({ state: 'removing', generation: 2 });
    expect(await readFile(join(personal, 'library.sqlite'), 'utf8')).toBe('personal');

    available = true;
    await service.resumePending();
    expect(registry.findById(account.id)).toMatchObject({ state: 'removed', generation: 2 });
    await expect(readFile(join(personal, 'library.sqlite'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delega el inventario legado sin borrar la raíz de control global', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-removal-'));
    dirs.push(dataDir);
    const registry = await AccountRegistry.open(dataDir);
    const account = await registry.claimLegacy({ sub: 'david', grant });
    await writeFile(join(dataDir, 'oauth-tokens.json'), 'global');
    await writeFile(join(dataDir, 'library.sqlite'), 'personal');
    const secrets = new MemorySecretStore();
    await secrets.set('lumbre-connection', 'personal');
    await secrets.set('hebra-mcp-sumego-refresh-key', 'global');
    const service = new AccountRemovalService({ dataDir, registry,
      contexts: new AccountContexts(registry, async () => { throw new Error('unexpected_open'); }),
      oauth: { invalidateAccount: async () => 1 }, revokeDevice: async () => undefined,
      legacySecrets: secrets });

    await service.remove(account);
    expect(await secrets.get('lumbre-connection')).toBeNull();
    expect(await secrets.get('hebra-mcp-sumego-refresh-key')).toBe('global');
    expect(await readFile(join(dataDir, 'oauth-tokens.json'), 'utf8')).toBe('global');
    await expect(readFile(join(dataDir, 'library.sqlite'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reanuda tras borrar datos sin intentar revocar otra vez una credencial ya eliminada', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-removal-'));
    dirs.push(dataDir);
    const registry = await AccountRegistry.open(dataDir);
    const account = await registry.commitAccount({ sub: 'mikel', grant });
    const personal = accountDataDir(dataDir, account);
    await mkdir(personal, { recursive: true });
    await writeFile(join(personal, 'library.sqlite'), 'personal');
    let revocations = 0;
    const originalAdvance = registry.advanceRemoval.bind(registry);
    let failAfterErase = true;
    registry.advanceRemoval = async (ref, phase) => {
      if (phase === 'data-erased' && failAfterErase) { failAfterErase = false; throw new Error('crash_after_erase'); }
      return originalAdvance(ref, phase);
    };
    const service = new AccountRemovalService({ dataDir, registry,
      contexts: new AccountContexts(registry, async () => { throw new Error('unexpected_open'); }),
      oauth: { invalidateAccount: async () => 1 },
      revokeDevice: async () => { revocations += 1; }, legacySecrets: new MemorySecretStore() });

    await expect(service.remove(account)).rejects.toThrow('crash_after_erase');
    expect(registry.findById(account.id)).toMatchObject({ state: 'removing', removalPhase: 'remote-revoked' });
    await service.resumePending();
    expect(revocations).toBe(1);
    expect(registry.findById(account.id)).toMatchObject({ state: 'removed', removalPhase: 'data-erased' });
  });

  it('retirar A conserva registro, datos y autorización de B', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-removal-'));
    dirs.push(dataDir);
    const registry = await AccountRegistry.open(dataDir);
    const a = await registry.commitAccount({ sub: 'a', grant });
    const grantB = { ...grant, credentialId: '00000000-0000-4000-8000-000000000002',
      accountId: 'b'.repeat(64), pairedCredentialId: '10000000-0000-4000-8000-000000000002',
      syncVaultId: '3'.repeat(32), opaqueDeviceId: '4'.repeat(32) };
    const b = await registry.commitAccount({ sub: 'b', grant: grantB });
    await mkdir(accountDataDir(dataDir, a), { recursive: true });
    await mkdir(accountDataDir(dataDir, b), { recursive: true });
    await writeFile(join(accountDataDir(dataDir, a), 'library.sqlite'), 'a');
    await writeFile(join(accountDataDir(dataDir, b), 'library.sqlite'), 'b');
    const service = new AccountRemovalService({ dataDir, registry,
      contexts: new AccountContexts(registry, async () => { throw new Error('unexpected_open'); }),
      oauth: { invalidateAccount: async () => 1 }, revokeDevice: async () => undefined,
      legacySecrets: new MemorySecretStore() });

    await service.remove(a);
    expect(registry.findById(a.id)).toMatchObject({ state: 'removed' });
    expect(registry.authorize(grantB, 'b')).toMatchObject({ id: b.id, generation: 1 });
    expect(await readFile(join(accountDataDir(dataDir, b), 'library.sqlite'), 'utf8')).toBe('b');
  });
});
