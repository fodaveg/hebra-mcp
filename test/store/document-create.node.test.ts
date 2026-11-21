/**
 * B-N20 (R30): crear un `.ods` y un `.odp` desde el MCP, con el motor real. Una carpeta
 * privada da `not_found`, un espacio de solo lectura rechaza el turno y un nombre que choca
 * da `file_exists`. En cada caso rechazado no se escribe nada (ni fila ni blob).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeOdfZip } from '../../vendor/hebra/src/lib/documents/odf/zip-write';
import type { PrivacyConfig } from '../../src/privacy/config';
import { createDocumentFile } from '../../src/store/document-create';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { SyncStorePort } from '../../src/store/sync-port';
import { IDENTITY } from '../sync/devices';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const text = (value: string) => new TextEncoder().encode(value);
const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const MIME = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
} as const;

/** Un paquete ODF mínimo válido (`mimetype` primero y sin comprimir, manifiesto y contenido). */
function odfPackage(format: 'ods' | 'odp', marker: string): Uint8Array {
  const mime = MIME[format];
  return writeOdfZip(
    [],
    [
      { path: 'mimetype', bytes: text(mime) },
      {
        path: 'META-INF/manifest.xml',
        bytes: text(
          '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
            `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/>` +
            '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'
        )
      },
      { path: 'content.xml', bytes: text(`<?xml version="1.0" encoding="UTF-8"?><office:document-content>${marker}</office:document-content>`) }
    ]
  );
}

async function open(shared = false) {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-create-'));
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
      binding: { ...IDENTITY, libraryInstance: 'document-create-test' },
      relayHasRecords: true
    });
  }
  return port;
}

async function world() {
  const port = await open();
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  return { port, publica, diario };
}

/** Lo que cambiaría una escritura: carpetas y ficheros, tal como están guardados. */
async function snapshot(port: NodeLibraryPort): Promise<string> {
  return port.writeExclusive(async (store) =>
    JSON.stringify({ folders: store.foldersList(), files: store.filesIndex() })
  );
}

/** Los ficheros vivos de una carpeta, con el SHA de su contenido. */
async function filesIn(port: NodeLibraryPort, folderId: string) {
  return port.writeExclusive(async (store) => {
    const index = store.filesIndex();
    return index.files
      .filter((file) => file.folderId === folderId && file.trashedAt === null)
      .map((file) => ({ id: file.id, name: file.name }));
  });
}

function create(
  port: NodeLibraryPort,
  input: Omit<Parameters<typeof createDocumentFile>[1], 'operationId'> & { operationId?: string },
  privacy: PrivacyConfig = CONFIG
) {
  const operationId = input.operationId ?? crypto.randomUUID();
  return port.writeExclusive(async (store) => createDocumentFile({ store, privacy }, { ...input, operationId }));
}

describe('createDocumentFile (B-N20)', () => {
  it('crea un .ods y un .odp visibles en su carpeta, con sus bytes y su tipo', async () => {
    const { port, publica } = await world();
    const ods = odfPackage('ods', 'hoja');
    const odp = odfPackage('odp', 'diapositivas');
    const a = await create(port, { format: 'ods', folderId: publica, name: 'Cuentas.ods', bytes: ods });
    const b = await create(port, { format: 'odp', folderId: publica, name: 'Charla.odp', bytes: odp });
    expect(a.sha256).toBe(sha256Of(ods));
    expect(b.sha256).toBe(sha256Of(odp));
    const files = await filesIn(port, publica);
    expect(files.map((file) => file.name).sort()).toEqual(['Charla.odp', 'Cuentas.ods']);
    expect(files.find((file) => file.name === 'Cuentas.ods')?.id).toBe(a.fileId);
    expect(files.find((file) => file.name === 'Charla.odp')?.id).toBe(b.fileId);
    await port.writeExclusive(async (store) => {
      expect(Array.from((await store.blobRead(a.sha256)) ?? [])).toEqual(Array.from(ods));
      expect(Array.from((await store.blobRead(b.sha256)) ?? [])).toEqual(Array.from(odp));
    });
  });

  it('también crea en la raíz', async () => {
    const { port } = await world();
    const made = await create(port, { format: 'ods', folderId: 'root', name: 'Raiz.ods', bytes: odfPackage('ods', 'r') });
    expect((await filesIn(port, 'root')).map((file) => file.id)).toContain(made.fileId);
  });

  it('una carpeta privada o inexistente da not_found, y no escribe', async () => {
    const { port, diario } = await world();
    const before = await snapshot(port);
    for (const folderId of [diario, 'no-existe']) {
      await expect(
        create(port, { format: 'ods', folderId, name: 'Secreto.ods', bytes: odfPackage('ods', 's') })
      ).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await snapshot(port)).toBe(before);
  });

  it('un homónimo visible es file_exists y un nombre o formato inválido es invalid_input, sin escribir', async () => {
    const { port, publica } = await world();
    await create(port, { format: 'ods', folderId: publica, name: 'Cuentas.ods', bytes: odfPackage('ods', 'uno') });
    const before = await snapshot(port);
    await expect(
      create(port, { format: 'ods', folderId: publica, name: 'cuentas.ODS', bytes: odfPackage('ods', 'dos') })
    ).rejects.toMatchObject({ code: 'file_exists' });
    for (const input of [
      { format: 'odp' as const, name: 'Cuentas.ods', bytes: odfPackage('odp', 'x') },
      { format: 'ods' as const, name: 'a/b.ods', bytes: odfPackage('ods', 'x') },
      { format: 'ods' as const, name: 'Vacio.ods', bytes: new Uint8Array() }
    ]) {
      await expect(create(port, { ...input, folderId: publica })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(await snapshot(port)).toBe(before);
  });

  it('operationId: obligatorio, el reintento no crea otro y otra petición con él se rechaza', async () => {
    const { port, publica } = await world();
    const bytes = odfPackage('ods', 'idempotente');
    const input = { format: 'ods' as const, folderId: publica, name: 'Una.ods', bytes };
    await expect(create(port, { ...input, operationId: '' })).rejects.toMatchObject({ code: 'invalid_input' });
    const first = await create(port, { ...input, operationId: 'op-1' });
    expect(first.replayed).toBeUndefined();
    const again = await create(port, { ...input, operationId: 'op-1' });
    expect(again).toEqual({ fileId: first.fileId, sha256: first.sha256, replayed: true });
    expect(await filesIn(port, publica)).toHaveLength(1);
    await expect(
      create(port, { ...input, name: 'Otra.ods', operationId: 'op-1' })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
    expect(await filesIn(port, publica)).toHaveLength(1);
  });

  it('reintentar sobre lo creado que ya está en la papelera da not_found y no crea otro', async () => {
    const { port, publica } = await world();
    const input = { format: 'ods' as const, folderId: publica, name: 'Una.ods', bytes: odfPackage('ods', 'p'), operationId: 'op-1' };
    const made = await create(port, input);
    await port.writeExclusive(async (store) => store.fileTrash(made.fileId));
    await expect(create(port, input)).rejects.toMatchObject({ code: 'not_found' });
    expect(await filesIn(port, publica)).toEqual([]);
  });

  it('un corte entre fileCreate y el registro: el reintento reconoce su fichero y no crea otro', async () => {
    const { port, publica } = await world();
    const input = { format: 'ods' as const, folderId: publica, name: 'Una.ods', bytes: odfPackage('ods', 'c'), operationId: 'op-1' };
    await expect(
      port.writeExclusive(async (store) => {
        const cut = new Proxy(store, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key === 'operations') {
              return {
                ...target.operations,
                finish() {
                  throw new Error('corte');
                }
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        return createDocumentFile({ store: cut, privacy: CONFIG }, input);
      })
    ).rejects.toThrow('corte');
    const [written] = await filesIn(port, publica);
    const retry = await create(port, input);
    expect(retry).toMatchObject({ fileId: written!.id, replayed: true });
    expect(await filesIn(port, publica)).toHaveLength(1);
  });

  it('el tipo sale del contenido: un ZIP sin mimetype ODF o de otro formato es invalid_input', async () => {
    const { port, publica } = await world();
    const before = await snapshot(port);
    for (const bytes of [text('PK\u0003\u0004 no es un ODF, aunque se llame .ods'), odfPackage('odp', 'otro')]) {
      await expect(
        create(port, { format: 'ods', folderId: publica, name: 'Falso.ods', bytes })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(await snapshot(port)).toBe(before);
  });

  it('un espacio de solo lectura rechaza el turno entero y no escribe; con escritura, crea', async () => {
    const space: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
    const incoming = (minClient: number): Parameters<SyncStorePort['syncApplyPage']>[0] => [
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
    const bytes = odfPackage('ods', 'espacio');
    const readonly = await open(true);
    await readonly.syncStorePort().syncApplyPage(incoming(3));
    // Un espacio de solo lectura tampoco deja abrir un turno para mirar: se compara por lectura.
    const before = JSON.stringify([await readonly.libraryOpen(), await readonly.filesIndex()]);
    await expect(
      create(readonly, { format: 'ods', folderId: 'root', name: 'Espacio.ods', bytes }, space)
    ).rejects.toMatchObject({ code: 'client_outdated' });
    expect(JSON.stringify([await readonly.libraryOpen(), await readonly.filesIndex()])).toBe(before);

    const writable = await open(true);
    const made = await create(writable, { format: 'ods', folderId: 'root', name: 'Espacio.ods', bytes }, space);
    expect((await filesIn(writable, 'root')).map((file) => file.id)).toContain(made.fileId);
  });
});
