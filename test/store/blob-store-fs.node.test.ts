/**
 * `FsBlobStore` (`src/store/blob-store-fs.ts`): escritura/lectura sobre disco de verdad
 * y, sobre todo, `clear()` para «Descargar la biblioteca del servidor»
 * (`libraryReset`, §6.6 de Hebra). La atomicidad de los bytes en disco NO es la de la
 * transacción SQLite que ya vació la tabla `blobs` antes de llamar aquí: por eso
 * `clear()` es de MEJOR ESFUERZO (como `OpfsBlobStore.clear()` de Hebra) y un fallo de
 * E/S al borrar se traga en vez de rechazar la promesa.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsBlobStore } from '../../src/store/blob-store-fs';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // Por si un test recortó permisos y no los restauró: sin esto, el borrado de la
    // propia carpeta temporal podría fallar y dejar basura entre tests.
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-mcp-blob-store-'));
  dirs.push(dir);
  return dir;
}

describe('FsBlobStore', () => {
  it('write/read/size hacen un viaje de ida y vuelta', async () => {
    const store = new FsBlobStore(await tempRoot());
    const sha256 = 'a'.repeat(64);

    await store.write(sha256, new Uint8Array([1, 2, 3]));

    expect(await store.size(sha256)).toBe(3);
    expect(await store.read(sha256)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('read/size de un hash que nunca se escribió devuelven null', async () => {
    const store = new FsBlobStore(await tempRoot());
    const sha256 = 'z'.repeat(64);

    expect(await store.read(sha256)).toBeNull();
    expect(await store.size(sha256)).toBeNull();
  });

  it('clear() borra los bytes escritos: read y size vuelven a null', async () => {
    const store = new FsBlobStore(await tempRoot());
    const sha256 = 'b'.repeat(64);
    await store.write(sha256, new Uint8Array([9]));

    await store.clear();

    expect(await store.read(sha256)).toBeNull();
    expect(await store.size(sha256)).toBeNull();
  });

  it('clear() sin ningún blob escrito antes (sin blobs/) no revienta', async () => {
    const store = new FsBlobStore(await tempRoot());

    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('clear() es de MEJOR ESFUERZO: un fallo de E/S al borrar no rechaza la promesa', async () => {
    const root = await tempRoot();
    const store = new FsBlobStore(root);
    const sha256 = 'c'.repeat(64);
    await store.write(sha256, new Uint8Array([7]));

    // El permiso que decide si `unlink` puede borrar un fichero es el de escritura del
    // DIRECTORIO que lo contiene, no el del fichero: sin él, `rm` falla con `EACCES` al
    // intentar vaciarlo, y ni `force` ni `recursive` tragan ese error. Si `clear()` no lo
    // capturara, esta promesa rechazaría con la biblioteca ya vacía en la base.
    const leafDir = join(root, 'blobs', sha256.slice(0, 2), sha256.slice(2, 4));
    await chmod(leafDir, 0o500);
    try {
      await expect(store.clear()).resolves.toBeUndefined();
    } finally {
      // Deja el árbol borrable para el afterEach.
      await chmod(leafDir, 0o700).catch(() => undefined);
    }
  });
});
