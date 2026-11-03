import { deferred } from '../fixtures/deferred';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AccountRegistry } from '../../src/accounts/registry';
import { openServeContext } from '../../src/server/serve';
import { NO_PRIVATE } from '../fixtures/no-private';

it('revalidates a personal write after it waited in the real writer FIFO', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'hm-write-'));
  const registry = await AccountRegistry.open(dataDir);
  const account = await registry.commitAccount({ sub: 'owner', grant: {
    active: true, credentialId: '00000000-0000-4000-8000-000000000001',
    clientId: 'hebra-mcp-claude', resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp',
    accountId: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z',
    pairedCredentialId: '10000000-0000-4000-8000-000000000001',
    syncVaultId: '1'.repeat(32), opaqueDeviceId: '2'.repeat(32)
  } });
  const assertActive = () => registry.assertActive(account);
  const options = { dataDir, secrets: null, writerOnly: true,
    authorize: async () => assertActive(), assertActive,
    instance: { checkIntervalMs: null } };
  const serve = await openServeContext(options);
  const gate = deferred();
  const entered = deferred();
  const queued = deferred();
  const holder = serve.instance.writeExclusive(async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  const original = serve.instance.writeExclusive.bind(serve.instance);
  serve.instance.writeExclusive = (operation) => {
    const result = original(operation);
    queued.resolve();
    return result;
  };
  const write = serve.ctx.write!.createNote({ body: '# Must not be written', privacy: NO_PRIVATE });
  const observed = write.then(() => null, (error: unknown) => error);
  try {
    await queued.promise;
    await registry.beginRemoval(account);
    gate.resolve();
    await holder;
    expect(await observed).toBeInstanceOf(Error);
    expect((await serve.instance.port.libraryOpen()).notesCount).toBe(0);
  } finally {
    gate.resolve();
    await serve.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
