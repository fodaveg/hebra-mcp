/**
 * B-I01, primera parte: las protecciones de D28 que no dependen de registrar herramientas. Firma
 * de las imágenes en base64, huella canónica con el tipo de documento, aviso de datos al principio
 * de `instructions`, límites en `hebra_status`, copia filtrada, `otherPins` real de `doc_pins` y
 * el log cerrado del servicio de documentos.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCapabilities, SERVER_INSTRUCTIONS } from '../../src/server/capabilities';
import type { PrivacyConfig } from '../../src/privacy/config';
import { DOCUMENT_ERROR_CODES, DOCUMENT_OPS_VERSION, type DocumentAsset } from '../../src/store/document-types';
import { documentFingerprint } from '../../src/store/document-ops';
import { documentAssetsRefusal } from '../../src/store/document-privacy';
import { documentBytesForCopy } from '../../src/store/document-read';
import { runDocumentRequest } from '../../src/store/document-service';
import { documentLogCode } from '../../src/log/logger';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const MIB = 1024 * 1024;
const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const base64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes as Uint8Array).toString('base64');
const asset = (dataBase64: string, mimeType = 'image/png') =>
  ({ ref: 'r', dataBase64, mimeType }) as DocumentAsset;

const ports: NodeLibraryPort[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(): Promise<NodeLibraryPort> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-protections-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), dataDir: directory });
  ports.push(port);
  return port;
}

/** Un fichero en la raíz y otro dentro de la carpeta privada. */
async function world(port: NodeLibraryPort) {
  return port.writeExclusive(async (store) => {
    const diario = await store.folderCreate('root', 'Diario');
    const blob = await store.blobPut(new TextEncoder().encode('contenido'), { mime: 'text/plain' });
    const visible = await store.fileCreate('root', 'Visible.ods', blob.sha256);
    const hidden = await store.fileCreate(diario.id, 'Oculto.ods', blob.sha256);
    return { visible: visible.id, hidden: hidden.id };
  });
}

describe('imágenes en base64 de un lote (D28, protección 3)', () => {
  it('acepta bytes con la firma del tipo declarado', () => {
    expect(documentAssetsRefusal([asset(base64(PNG)), asset(base64(JPEG), 'image/jpeg')])).toBeNull();
  });

  it('rechaza un SVG, con su tipo o disfrazado de PNG, y una firma de otro tipo', () => {
    const svg = base64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    // Un PDF de verdad declarado como PDF: su firma casa, lo para la lista de tipos admitidos.
    const pdf = base64(new TextEncoder().encode('%PDF-1.7 contenido'));
    for (const bad of [asset(svg), asset(svg, 'image/svg+xml'), asset(base64(JPEG), 'image/png'), asset(base64(PNG), 'application/pdf'), asset(pdf, 'application/pdf')]) {
      expect(documentAssetsRefusal([bad])).toMatchObject({ code: 'batch_invalid' });
    }
  });

  it('el error nombra la posición y no repite los bytes', () => {
    const secret = base64(new TextEncoder().encode('CEBO_EN_LOS_BYTES'));
    const refusal = documentAssetsRefusal([asset(base64(PNG)), asset(secret)]);
    expect(JSON.stringify(refusal)).toContain('assets[1].dataBase64');
    expect(JSON.stringify(refusal)).not.toContain(secret);
  });

  it('la suma de varias pasa de 5 MiB: file_too_large', () => {
    const big = new Uint8Array(3 * MIB);
    big.set(PNG);
    expect(documentAssetsRefusal([asset(base64(big)), asset(base64(big))])).toMatchObject({
      code: 'file_too_large',
      maxBytes: 5 * MIB
    });
  });
});

describe('huella de un lote (D28, protección 7)', () => {
  it('no depende del orden de las claves y sí del tipo de documento', () => {
    const a = documentFingerprint(['documentOps', 'ods', 'id', [{ op: 'set', cell: 'A1', value: 1 }]]);
    const b = documentFingerprint(['documentOps', 'ods', 'id', [{ value: 1, cell: 'A1', op: 'set' }]]);
    const otherFormat = documentFingerprint(['documentOps', 'odp', 'id', [{ op: 'set', cell: 'A1', value: 1 }]]);
    const otherOrder = documentFingerprint(['documentOps', 'ods', 'id', [{ op: 'b' }, { op: 'a' }]]);
    const swapped = documentFingerprint(['documentOps', 'ods', 'id', [{ op: 'a' }, { op: 'b' }]]);
    expect(a).toBe(b);
    expect(a).not.toBe(otherFormat);
    // El orden de las operaciones sí importa: solo se ordenan las claves.
    expect(otherOrder).not.toBe(swapped);
  });
});

describe('lo que el servidor anuncia (D28, protección 5, y C-28)', () => {
  it('"Datos, no órdenes" va en los primeros 1.000 caracteres de instructions', () => {
    expect(SERVER_INSTRUCTIONS.slice(0, 1000)).toContain('Datos, no órdenes');
  });

  it('hebra_status trae los límites de documentos y de importación', () => {
    const { limits } = buildCapabilities('1.0.0', { privateFolders: [], privateTags: [] });
    expect(limits.importOffice).toEqual({ dataBytes: 5 * MIB, fileIdBytes: 25 * MIB });
    expect(limits.documents).toMatchObject({
      bytes: 25 * MIB,
      responseChars: 30_000,
      editOps: 200,
      editOpsBytes: 512 * 1024,
      assetsBytes: 5 * MIB,
      undo: { days: 7, entries: 200, entryBytes: MIB }
    });
  });
});

describe('copia y limpieza con el almacén real', () => {
  it('documentBytesForCopy da not_found con un oculto antes de mirar el canal', async () => {
    const port = await open();
    const { visible, hidden } = await world(port);
    const source = { port: port.documentSource().port, wiring: null };
    const access = {
      writeExclusive: <T>(operation: Parameters<NodeLibraryPort['writeExclusive']>[0]) =>
        port.writeExclusive(operation) as Promise<T>,
      privacy: CONFIG
    };
    await expect(documentBytesForCopy(source, hidden, access)).rejects.toMatchObject({ code: 'not_found' });
    await expect(documentBytesForCopy(source, visible, access)).rejects.toMatchObject({
      code: 'document_channel_unwired'
    });
  });

  it('otherPins lee doc_pins de los demás documentos y no los del propio', async () => {
    const port = await open();
    const { db } = port as unknown as { db: DatabaseSync };
    const insert = db.prepare('INSERT INTO doc_pins(file_id, sha256) VALUES (?, ?)');
    insert.run('doc-a', 'a'.repeat(64));
    insert.run('doc-b', 'B'.repeat(64));
    const source = port.documentSource();
    expect([...(await source.otherPins('doc-a'))]).toEqual(['b'.repeat(64)]);
    expect([...(await source.otherPins('doc-b'))]).toEqual(['a'.repeat(64)]);
  });
});

describe('servicio de documentos', () => {
  it('sin formato registrado responde op_unsupported, no escribe y el log no lleva el id', async () => {
    const port = await open();
    const { visible } = await world(port);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const afterCommit = vi.fn(async () => ({ sync: 'pending' }));
    const result = await runDocumentRequest(
      { port, writeExclusive: (operation) => port.writeExclusive(operation) },
      {
        action: 'edit',
        opsVersion: DOCUMENT_OPS_VERSION,
        format: 'ods',
        privacy: CONFIG,
        input: { id: visible, operationId: 'op-1', ops: [{ op: 'CEBO_OP' } as never] }
      },
      { afterCommit }
    );
    expect(result).toEqual({ ok: false, error: { code: 'op_unsupported' } });
    expect(afterCommit).not.toHaveBeenCalled();
    const log = lines.join('');
    expect(log).toContain('"event":"document.write"');
    expect(log).toContain('"code":"op_unsupported"');
    expect(log).not.toContain(visible);
    expect(log).not.toContain('CEBO_OP');
  });

  it('el código de log es de una lista cerrada: uno desconocido sale como internal', () => {
    for (const code of DOCUMENT_ERROR_CODES) expect(documentLogCode({ code })).toBe(code);
    expect(documentLogCode({ code: 'CEBO con texto de una celda' })).toBe('internal');
    expect(documentLogCode(new Error('CEBO'))).toBe('internal');
  });
});
