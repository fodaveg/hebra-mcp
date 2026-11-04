import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountControlDir, openAccountControlServer } from '../../src/accounts/control-ipc';
import { openControlSecretStore } from '../../src/accounts/control-secrets';
import { eraseLegacyAccountData } from '../../src/accounts/legacy-inventory';
import { PendingUploadList, pendingUploadsTemporaryName } from '../../src/accounts/pending-sweep';
import { acquireServerLock } from '../../src/lock/server-lock';
import { WriterLock } from '../../src/lock/writer-lock';
import { MemorySecretStore } from '../../src/secrets';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/**
 * La retirada de la cuenta del legado falla con `legacy_inventory_unknown` ante cualquier fichero
 * de `control/` que no conozca. Aquí `control/` se puebla con el código real de quien lo escribe
 * (bloqueo del servidor, bloqueo de la vuelta atrás, socket, secretos globales, lista de subidas
 * pendientes y su temporal), no con nombres copiados.
 */
describe('inventario de la retirada y control/', () => {
  it('conoce todo lo que un servidor real deja en control/', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-inventory-'));
    dirs.push(dataDir);
    const control = accountControlDir(dataDir);
    await mkdir(control, { recursive: true, mode: 0o700 });

    const server = acquireServerLock(dataDir, control);
    expect(server).not.toBeNull();
    const rollbackLock = new WriterLock({ dataDir: control, releaseOnExit: false });
    expect(rollbackLock.tryAcquire()).toBe(true);
    await openControlSecretStore(dataDir).set('recovery-code', 'x');
    const pending = await PendingUploadList.open(control);
    await pending.put({ id: 'a', generation: 1 }, null, false);
    const socket = await openAccountControlServer(dataDir, async () => undefined);
    // Lo que un corte deja a medias.
    await writeFile(join(control, pendingUploadsTemporaryName()), '{}');
    // Con la clave global ya en `control/`, un `secrets.json` raíz solo trae un temporal huérfano.
    await writeFile(join(dataDir, 'library.sqlite'), 'personal');

    try {
      const present = await readdir(control);
      expect(present).toEqual(expect.arrayContaining([
        'server.lock', 'writer.lock', 'accounts.sock', 'secrets.json', 'pending-uploads-v1.json'
      ]));
      await eraseLegacyAccountData({ dataDir, secrets: new MemorySecretStore() });
      // Nada de control/ se borra, y lo personal sí.
      expect((await readdir(control)).sort()).toEqual(present.sort());
      expect(await readdir(dataDir)).not.toContain('library.sqlite');
    } finally {
      await socket.close();
      rollbackLock.release();
      server?.release();
    }
  });

  it.each(['server.lock-journal', 'server.lock-wal', 'server.lock-shm'])(
    'conoce %s, lo que SQLite deja junto a server.lock', async (name) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'hebra-inventory-'));
      dirs.push(dataDir);
      const control = accountControlDir(dataDir);
      await mkdir(control, { recursive: true, mode: 0o700 });
      await writeFile(join(control, name), '');
      await expect(eraseLegacyAccountData({ dataDir, secrets: new MemorySecretStore() })).resolves.toBeUndefined();
    });

  it('un fichero desconocido en control/ sigue deteniendo la retirada', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-inventory-'));
    dirs.push(dataDir);
    const control = accountControlDir(dataDir);
    await mkdir(control, { recursive: true, mode: 0o700 });
    await writeFile(join(control, 'sin-clasificar.json'), '{}');
    await expect(eraseLegacyAccountData({ dataDir, secrets: new MemorySecretStore() }))
      .rejects.toThrow('legacy_inventory_unknown');
  });
});
