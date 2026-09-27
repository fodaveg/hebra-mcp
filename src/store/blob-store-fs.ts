/**
 * `BlobBytesStore` (`library/blob-store` de Hebra, tipo reexportado por `../hebra`)
 * sobre el disco: `<dir>/blobs/aa/bb/<sha256>`, escritura atómica (fichero temporal +
 * `rename`, que en el mismo sistema de ficheros es atómico en POSIX). El motor solo
 * llama a `write` cuando el hash no está ya presente (`blobPut`, `sqlite-engine.ts`), así
 * que no hace falta comprobar duplicados aquí.
 *
 * `clear()` («Descargar la biblioteca del servidor», `libraryReset`): el motor ya vació
 * `blobs` en la MISMA transacción SQLite (`sqlite-engine.ts`) antes de llamar aquí, así
 * que la atomicidad de la fila y la del fichero en disco son dos cosas distintas — un
 * corte a mitad de este borrado nunca deja una fila de `blobs` sin bytes, como mucho
 * bytes huérfanos que ningún `blobRead` vuelve a alcanzar. Por eso, igual que
 * `OpfsBlobStore.clear()` de Hebra, esto es de MEJOR ESFUERZO: un error de E/S al borrar
 * (permisos, disco ocupado por otro proceso) se traga en vez de propagarse, para que un
 * `libraryReset` que ya comprometió la base no acabe rechazando la promesa entera y
 * pareciendo fallido cuando la base sí quedó vacía.
 */
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BlobBytesStore } from '../hebra';

/** Ruta relativa del adjunto dentro del directorio de datos: `blobs/aa/bb/<sha256>`. */
export function blobStorePath(root: string, sha256: string): string {
  return join(root, 'blobs', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export class FsBlobStore implements BlobBytesStore {
  constructor(private readonly root: string) {}

  async write(sha256: string, bytes: Uint8Array): Promise<void> {
    const finalPath = blobStorePath(this.root, sha256);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const tmpPath = join(dirname(finalPath), `.tmp-${randomUUID()}`);
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);
  }

  async read(sha256: string): Promise<Uint8Array | null> {
    try {
      const bytes = await readFile(blobStorePath(this.root, sha256));
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async size(sha256: string): Promise<number | null> {
    try {
      const info = await stat(blobStorePath(this.root, sha256));
      return info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(join(this.root, 'blobs'), { recursive: true, force: true }).catch(() => undefined);
  }
}
