/**
 * C-29 (R-04): las guardas de la importación de ofimática, con el motor real del MCP. Una
 * carpeta privada, un fichero dentro de ella, uno en la papelera, etiquetas privadas y un
 * espacio de solo lectura. En cada caso rechazado no se escribe nada.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { assertOfficeWritable, type OfficeWriteTarget } from '../../src/store/office-guards';
import type { PrivacyConfig } from '../../src/privacy/config';
import type { SyncStorePort } from '../../src/store/sync-port';
import { IDENTITY } from '../sync/devices';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(shared = false) {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-office-guards-'));
  directories.push(directory);
  const spaceAccess = {
    spaceId: '955480b0-c2c3-471f-aa5d-3f37ed46fe68',
    scope: 'fixture',
    authorize: async () => {},
    assertActive: () => {}
  };
  const port = await openNodeLibraryPort({
    sqlitePath: join(directory, 'library.sqlite'),
    ...(shared ? { spaceAccess } : {})
  });
  ports.push(port);
  if (shared) {
    await port.syncStorePort().libraryConnect({
      binding: { ...IDENTITY, libraryInstance: 'office-guards-test' },
      relayHasRecords: true
    });
  }
  return port;
}

/** Un fichero suelto de texto en `folderId`. */
async function addFile(port: NodeLibraryPort, folderId: string, name: string, text: string) {
  return port.writeExclusive(async (store) => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await store.blobPut(bytes, { mime: 'text/plain', expectedSha256: sha256 });
    return store.fileCreate(folderId, name, sha256);
  });
}

interface World {
  port: NodeLibraryPort;
  publica: string;
  diario: string;
  abierto: string;
  enDiario: string;
  enPapelera: string;
}

async function world(): Promise<World> {
  const port = await open();
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  const abierto = (await addFile(port, publica, 'abierto.txt', 'visible')).id;
  const enDiario = (await addFile(port, diario, 'secreto.txt', 'privado')).id;
  const enPapelera = (await addFile(port, publica, 'viejo.txt', 'papelera')).id;
  await port.writeExclusive(async (store) => {
    await store.fileTrash(enPapelera);
  });
  // Una nota pública, para que el recuento de notas no sea cero.
  await port.noteCreate(publica);
  return { port, publica, diario, abierto, enDiario, enPapelera };
}

/** Lo que cambiaría una escritura: carpetas, ficheros y notas, tal como están guardados. */
async function snapshot(port: NodeLibraryPort): Promise<string> {
  const notes = (await port.libraryOpen()).notesCount;
  return port.writeExclusive(async (store) =>
    JSON.stringify({ folders: store.foldersList(), files: store.filesIndex(), notes })
  );
}

/** Corre la guarda dentro de un turno, como lo hará el escritor de C-26. */
function guard(port: NodeLibraryPort, target: OfficeWriteTarget): Promise<void> {
  return port.writeExclusive(async (store) => assertOfficeWritable({ store, privacy: CONFIG }, target));
}

describe('assertOfficeWritable (C-29)', () => {
  it('deja pasar un destino visible, con y sin fichero de origen y con etiquetas públicas', async () => {
    const w = await world();
    await expect(guard(w.port, { folderId: w.publica })).resolves.toBeUndefined();
    await expect(guard(w.port, { folderId: 'root' })).resolves.toBeUndefined();
    await expect(
      guard(w.port, { folderId: w.publica, sourceFileId: w.abierto, resultTags: ['proyectos', 'proyectos/a'] })
    ).resolves.toBeUndefined();
  });

  it('una carpeta privada como destino da not_found, igual que una que no existe, y no escribe', async () => {
    const w = await world();
    const before = await snapshot(w.port);
    await expect(guard(w.port, { folderId: w.diario })).rejects.toMatchObject({ code: 'not_found' });
    await expect(guard(w.port, { folderId: 'no-existe' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await snapshot(w.port)).toBe(before);
  });

  it('un fichero de origen privado, en la papelera o inexistente da not_found, y no escribe', async () => {
    const w = await world();
    const before = await snapshot(w.port);
    for (const sourceFileId of [w.enDiario, w.enPapelera, 'no-existe']) {
      await expect(guard(w.port, { folderId: w.publica, sourceFileId })).rejects.toMatchObject({
        code: 'not_found'
      });
    }
    expect(await snapshot(w.port)).toBe(before);
  });

  it('una nota resultante con etiqueta privada (o descendiente) da not_found, y no escribe', async () => {
    const w = await world();
    const before = await snapshot(w.port);
    await expect(guard(w.port, { folderId: w.publica, resultTags: ['secreto'] })).rejects.toMatchObject({
      code: 'not_found'
    });
    await expect(
      guard(w.port, { folderId: w.publica, resultTags: ['proyectos', 'secreto'] })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await snapshot(w.port)).toBe(before);
  });

  it('una carpeta vacía es invalid_input', async () => {
    const w = await world();
    await expect(guard(w.port, { folderId: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('rol del espacio de destino (R-04)', () => {
  /** Sin carpetas privadas: el espacio de prueba no tiene la `Diario` de la configuración. */
  const SPACE_CONFIG: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };

  function incoming(minClient: number): Parameters<SyncStorePort['syncApplyPage']>[0] {
    return [
      {
        id: 'shared-note',
        rev: 1,
        minClient,
        deleted: false,
        plaintextHash: 'fixture-1',
        fields: {
          kind: 'note', folderId: 'root', body: '# Compartida', favorite: false,
          createdAt: 1, updatedAt: 1, trashedAt: null, conflictOf: null,
          conflictAt: null, conflictDevice: null
        }
      }
    ];
  }

  it('un espacio de solo lectura rechaza el turno entero: la guarda ni corre y no se escribe', async () => {
    const port = await open(true);
    await port.syncStorePort().syncApplyPage(incoming(3));
    const before = await port.libraryOpen();
    let ran = false;
    await expect(
      port.writeExclusive(async (store) => {
        ran = true;
        assertOfficeWritable({ store, privacy: SPACE_CONFIG }, { folderId: 'root' });
        await store.folderCreate('root', 'Intruso');
      })
    ).rejects.toMatchObject({ code: 'client_outdated' });
    expect(ran).toBe(false);
    const after = await port.libraryOpen();
    expect(after.notesCount).toBe(before.notesCount);
    expect(after.foldersCount).toBe(before.foldersCount);
  });

  it('el mismo espacio con escritura sí deja pasar la guarda', async () => {
    const port = await open(true);
    await expect(
      port.writeExclusive(async (store) => assertOfficeWritable({ store, privacy: SPACE_CONFIG }, { folderId: 'root' }))
    ).resolves.toBeUndefined();
  });
});
