/**
 * SPEC.md §6.1 (`Permisos: directorio 0700, ficheros 0600`). Fallo medido: tras el
 * primer emparejado real, `library.sqlite` quedó en 0644 porque `node:sqlite` crea el
 * fichero con el modo por defecto del SO (no acepta uno propio al crear), y
 * `journalMode: 'WAL'` añade `-wal`/`-shm` con el mismo problema. El directorio (0700,
 * `mkdir` en `node-port.ts`) y los blobs (0600, `blob-store-fs.ts`) ya se probaban antes
 * en otro sitio; aquí solo `library.sqlite` y sus dos ficheros de WAL.
 */
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const ports: NodeLibraryPort[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('permisos de los ficheros del escritor', () => {
  it('deja library.sqlite, -wal y -shm en 0600 tras abrir y escribir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-file-perms-'));
    dirs.push(dataDir);
    const sqlitePath = join(dataDir, 'library.sqlite');

    const writer = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(writer);
    // Una escritura de verdad, para que `-wal`/`-shm` existan sin depender de si el
    // esquema que crea `SqliteLibraryEngine.open` ya bastó para generarlos.
    const created = await writer.noteCreate(null);
    await writer.noteSave({
      id: created.id,
      body: '# Nota\n\nTexto.',
      title: 'Nota',
      titleNorm: 'nota',
      excerpt: 'Texto.',
      expectedLocalSeq: created.localSeq,
      baseBodySha256: created.bodySha256
    });

    expect(await modeOf(sqlitePath)).toBe(0o600);
    expect(await modeOf(`${sqlitePath}-wal`)).toBe(0o600);
    expect(await modeOf(`${sqlitePath}-shm`)).toBe(0o600);
  });

  it('corrige un library.sqlite preexistente con permisos más abiertos', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-file-perms-'));
    dirs.push(dataDir);
    const sqlitePath = join(dataDir, 'library.sqlite');

    // Una base ya creada (por ejemplo, por una versión anterior del código) con 0644.
    const seed = await openNodeLibraryPort({ sqlitePath, dataDir });
    seed.close();
    await chmod(sqlitePath, 0o644);
    expect(await modeOf(sqlitePath)).toBe(0o644);

    const writer = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(writer);

    expect(await modeOf(sqlitePath)).toBe(0o600);
  });
});
