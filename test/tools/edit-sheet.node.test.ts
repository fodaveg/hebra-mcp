/**
 * `hebra_edit_sheet` (H-80) con el motor real: `NodeLibraryPort` en SQLite, el escritor de
 * documentos (`runDocumentRequest`, op `documentOps`) con el formato de `createSheetDocumentFormat`
 * registrado como `ods` (el alta de producción es de H-177) y la lectura común de hojas.
 *
 * Primera tanda (entrega parcial de H-80): un `.ods` sin cabecera se edita con la revisión de su
 * lectura, un `expect` viejo da `precondition_failed` sin escribir y una función de red da
 * `batch_invalid` sin llegar al escritor. El resto de la ficha queda listado en la entrega.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy/config';
import { PrivacyFilter } from '../../src/privacy/filter';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { createSheetDocumentFormat, runEditSheet, type EditSheetWriter } from '../../src/server/tools/edit-sheet';
import { openSheetRead } from '../../src/server/tools/sheet-read';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { registerDocumentFormat, runDocumentRequest } from '../../src/store/document-service';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];
const live = new AbortController().signal;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

beforeAll(() => {
  // Sin fórmulas en estos lotes: el motor no llega a arrancar.
  registerDocumentFormat('ods', createSheetDocumentFormat({ engine: () => { throw new Error('sin motor'); } }));
});
afterAll(() => registerDocumentFormat('ods', null));
afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Una biblioteca con un `.ods` subido, sin cabecera de documento (nunca abierto en el editor). */
async function world() {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-edit-sheet-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), dataDir: directory });
  ports.push(port);
  const bytes = buildOds();
  const fileId = await port.writeExclusive(async (store) => {
    const folder = (await store.folderCreate('root', 'Hojas')).id;
    await store.folderCreate('root', 'Diario');
    await store.blobPut(bytes, { mime: 'application/vnd.oasis.opendocument.spreadsheet', expectedSha256: sha(bytes) });
    return (await store.fileCreate(folder, 'datos.ods', sha(bytes))).id;
  });
  const privacy = await (await PrivacyFilter.build(port, CONFIG)).ensureAll();
  const ctx: ToolContext = { port, privacy, privacyConfig: CONFIG, status: new UnlinkedStatusSource() };
  let calls = 0;
  const writer: EditSheetWriter = async (request) => {
    calls += 1;
    const outcome = await runDocumentRequest(
      { port, writeExclusive: (operation) => port.writeExclusive(operation) },
      { opsVersion: DOCUMENT_OPS_VERSION, ...request },
      { afterCommit: async () => ({ sync: 'not_linked' }) }
    );
    if ('created' in outcome) throw new Error('documentOps devolvió una creación');
    return outcome;
  };
  return { port, ctx, writer, fileId, bytes, calls: () => calls };
}

/** Lo que vería `hebra_read_sheet`: revisiones y el valor de una celda de la primera hoja. */
async function readState(port: NodeLibraryPort, fileId: string, bytes: Uint8Array) {
  const opened = await openSheetRead(port.documentSource(), { id: fileId, sha256: sha(bytes) }, live, 'empty');
  try {
    const sheet = opened.read.model.sheets[0]!;
    const at = (row: number, col: number) => sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`) ?? null;
    return { revision: opened.read.revision, layoutRevision: opened.read.layoutRevision, name: sheet.name, a1: at(0, 0), a2: at(1, 0) };
  } finally {
    await opened.close();
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  return error as ToolError;
}

describe('hebra_edit_sheet (H-80)', () => {
  it('un .ods sin cabecera: casa con la revisión de su lectura, escribe la cabecera y el lote', async () => {
    const h = await world();
    const before = await readState(h.port, h.fileId, h.bytes);
    expect((await h.port.documentSource().port.docRead(h.fileId)).head).toBeNull();
    const out = await runEditSheet(
      h.ctx,
      {
        id: h.fileId,
        operationId: 'op-1',
        expectedRevision: before.revision,
        expectedLayout: before.layoutRevision,
        ops: [{ type: 'setCells', sheet: before.name, start: 'A1', rows: [[10]] }]
      },
      h.writer
    );
    expect(out).toMatchObject({ outcome: 'saved', previousRevision: before.revision, undoAvailable: true, changed: { cells: 1, sheets: 1 } });
    expect((await h.port.documentSource().port.docRead(h.fileId)).head).toMatchObject({ format: 'ods' });
    const after = await readState(h.port, h.fileId, h.bytes);
    expect(after.a1).toBe(10);
    expect(after.revision).toBe(out.revision);
  });

  it('un expect viejo da precondition_failed y no escribe nada', async () => {
    const h = await world();
    const before = await readState(h.port, h.fileId, h.bytes);
    await expectCode(
      runEditSheet(h.ctx, { id: h.fileId, operationId: 'op-1', ops: [{ type: 'setCells', sheet: before.name, start: 'A1', rows: [[5]], expect: { A1: 'otro' } }] }, h.writer),
      'precondition_failed'
    );
    const state = await h.port.documentSource().port.docRead(h.fileId);
    expect(state.segments.length + state.pending.length).toBe(0);
    expect((await readState(h.port, h.fileId, h.bytes)).a1).toBe(before.a1);
  });

  it('una expectedRevision vieja da precondition_failed con target expectedRevision', async () => {
    const h = await world();
    const before = await readState(h.port, h.fileId, h.bytes);
    await runEditSheet(h.ctx, { id: h.fileId, operationId: 'op-1', expectedRevision: before.revision, ops: [{ type: 'setCells', sheet: before.name, start: 'A2', rows: [[7]] }] }, h.writer);
    const error = await expectCode(
      runEditSheet(h.ctx, { id: h.fileId, operationId: 'op-2', expectedRevision: before.revision, ops: [{ type: 'setCells', sheet: before.name, start: 'A1', rows: [[8]] }] }, h.writer),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ target: 'expectedRevision' });
    expect((await readState(h.port, h.fileId, h.bytes)).a1).toBe(before.a1);
  });

  it('WEBSERVICE o una imagen por URL dan batch_invalid sin llegar al escritor', async () => {
    const h = await world();
    const before = await readState(h.port, h.fileId, h.bytes);
    await expectCode(
      runEditSheet(h.ctx, { id: h.fileId, operationId: 'op-1', expectedRevision: before.revision, ops: [{ type: 'setCells', sheet: before.name, start: 'A1', rows: [['=WEBSERVICE("https://ejemplo.com")']] }] }, h.writer),
      'batch_invalid'
    );
    await expectCode(
      runEditSheet(h.ctx, { id: h.fileId, operationId: 'op-2', expectedRevision: before.revision, ops: [{ type: 'setCells', sheet: before.name, start: 'A1', rows: [[1]] }], assets: [{ ref: 'x', url: 'https://ejemplo.com/a.png' }] }, h.writer),
      'batch_invalid'
    );
    expect(h.calls()).toBe(0);
  });
});
