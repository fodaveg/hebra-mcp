/**
 * `hebra_edit_sheet` (H-80) con el motor real: `NodeLibraryPort` en SQLite, el escritor de
 * documentos (`runDocumentRequest`, op `documentOps`) con el formato de `createSheetDocumentFormat`
 * registrado como `ods` (el alta de producción es de H-177), la lectura común de hojas y el motor
 * de fórmulas en su hilo (`src/sheet-engine-worker.ts`, empaquetado aquí con esbuild como en
 * `read-sheet.test.ts`, porque un hilo de Node no carga las fuentes `.ts`).
 *
 * Lo único que el test pone entre medias es un envoltorio del formato (`hooks`): deja hacer algo
 * entre la fase 2 y la 3 (otra persona escribe, el fichero pasa a una carpeta privada, el espacio
 * queda de solo lectura) y cortar la fase 3 justo después de confirmar el append, antes de
 * responder. Y `openSheetRead` se cuenta (`reads`): cada lectura que se abre se cierra, también en
 * un deshacer, que no llega a calcular.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - quitar la guarda de la fase 3 (el bucle de `batch.guards` en `applyOp`): cae «en la misma
 *   celda da precondition_failed sin escribir»;
 * - no traducir el fallo de la fase 3 al comando (`explainFailure` devuelve el error tal cual):
 *   cae el mismo test por `opIndex: 1`;
 * - sacar `turn.operations.finish` de `inTx` en `document-ops.ts`: cae «un corte entre el append y
 *   la respuesta» (el reintento ya no es `already`: vuelve a aplicar y los ids deterministas de la
 *   fila chocan con los de la primera vez);
 * - quitar la comprobación de `expectedLayout` de la fase 3 en `document-ops.ts`: cae «una
 *   expectedLayout que caduca entre la fase 2 y la 3»; quitarla además de la fase 2 hace caer
 *   «una expectedLayout caducada no aplica nada»;
 * - no llamar a `handle.close` en `runDocumentRequest`: caen los tres de deshacer y el del corte
 *   (el reintento lo responde la fase 1) por lecturas sin cerrar;
 * - volver a contar `expectedLayout` como garantía en `assertAddressRule`: cae «la regla de
 *   direcciones es la misma»;
 * - escribir en `dryRun` (quitar la salida temprana de `runDocumentOps`): cae «dryRun sobre un
 *   documento con cabecera»;
 * - un error de uno en la búsqueda de `commandLocator`: cae su test.
 * - quitar el tope `max(MAX_AXIS_PX)` del esquema de `setAxisSize` (H-VENDOR-2): cae «una medida
 *   fuera de tope» (el lote llega al escritor y lo rechaza `compileBatch`, no el esquema).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import type { PrivacyConfig } from '../../src/privacy/config';
import { PrivacyFilter } from '../../src/privacy/filter';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import {
  commandLocator,
  createSheetDocumentFormat,
  runEditSheet,
  type EditSheetInput,
  type EditSheetWriter,
  type SheetEditOp
} from '../../src/server/tools/edit-sheet';
import { openSheetRead } from '../../src/server/tools/sheet-read';
import { createEditorData, type SheetCommand, type SheetModel, type SheetModelSheet } from '../../src/sheets';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { assertAddressRule, DocumentAddressError } from '../../src/store/document-address';
import { registerDocumentFormat, runDocumentRequest } from '../../src/store/document-service';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { SyncStorePort } from '../../src/store/sync-port';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { IDENTITY } from '../sync/devices';

/** Lecturas de hojas abiertas y cerradas en todo el proceso del test. */
const reads = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock('../../src/server/tools/sheet-read', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/server/tools/sheet-read')>();
  return {
    ...real,
    openSheetRead: async (...args: Parameters<typeof real.openSheetRead>) => {
      const opened = await real.openSheetRead(...args);
      reads.opened += 1;
      return {
        ...opened,
        close: async () => {
          reads.closed += 1;
          await opened.close();
        }
      };
    }
  };
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const SPACE: PrivacyConfig = { privateFolders: [], privateTags: [] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];
const live = new AbortController().signal;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Lo que el test pone en el formato. `betweenPhases` corre una vez, en la petición que lo
 * encuentra, después del cálculo y antes de la fase 3; `cut` corta la fase 3 de esa petición
 * después del append (en la proyección de después, ya fuera de la transacción), antes de responder.
 */
const hooks: { betweenPhases: (() => Promise<void>) | null; cut: boolean } = { betweenPhases: null, cut: false };

beforeAll(async () => {
  // El hilo del motor, empaquetado y autónomo como `dist/sheet-engine-worker.mjs`.
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-edit-sheet-engine-'));
  directories.push(dir);
  const outfile = join(dir, 'sheet-engine-worker.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'sheet-engine-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile,
    tsconfig: join(ROOT, 'tsconfig.json'),
    logLevel: 'silent'
  });
  const sheets = createSheetDocumentFormat({ engineWorkerUrl: pathToFileURL(outfile) });
  registerDocumentFormat<SheetModel, SheetEditOp>('ods', {
    async forDocument(source, fileId, signal, sha256) {
      const handle = await sheets.forDocument(source, fileId, signal, sha256);
      const between = hooks.betweenPhases;
      hooks.betweenPhases = null;
      const inner = handle.adapter;
      let applied = false;
      const adapter: DocFormatAdapter<SheetModel, SheetEditOp> = {
        ...inner,
        applyOp(doc, op, ctx) {
          const inverse = inner.applyOp(doc, op, ctx);
          applied = true;
          return inverse;
        },
        async project(bytes, doc, projectSignal) {
          if (hooks.cut && applied) {
            hooks.cut = false;
            throw new Error('corte antes de la respuesta');
          }
          return inner.project(bytes, doc, projectSignal);
        }
      };
      return {
        ...handle,
        adapter,
        compute: async (job, computeSignal) => {
          const result = await handle.compute(job, computeSignal);
          if (between) await between();
          return result;
        }
      };
    }
  });
});

afterAll(() => {
  registerDocumentFormat('ods', null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  reads.opened = 0;
  reads.closed = 0;
});

afterEach(async () => {
  hooks.betweenPhases = null;
  hooks.cut = false;
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  // Ninguna lectura queda abierta: tampoco la de un deshacer o la de un rechazo de la fase 1.
  expect(reads.closed).toBe(reads.opened);
});

async function open(shared = false): Promise<NodeLibraryPort> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-edit-sheet-'));
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
      binding: { ...IDENTITY, libraryInstance: 'edit-sheet-test' },
      relayHasRecords: true
    });
  }
  return port;
}

/** Una nota compartida que exige un cliente más nuevo: el espacio queda de solo lectura. */
function readOnlyPage(): Parameters<SyncStorePort['syncApplyPage']>[0] {
  return [
    {
      id: 'shared-note',
      rev: 1,
      minClient: 3,
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

/**
 * Una biblioteca con un `.ods` subido, sin cabecera de documento (nunca abierto en el editor), en
 * `Hojas` o en la carpeta privada `Diario`; o en un espacio compartido (`shared`).
 */
async function world(options: { folder?: 'Hojas' | 'Diario'; shared?: boolean } = {}) {
  const port = await open(options.shared === true);
  const config = options.shared === true ? SPACE : CONFIG;
  const bytes = buildOds();
  const { fileId, diario } = await port.writeExclusive(async (store) => {
    const hojas = (await store.folderCreate('root', 'Hojas')).id;
    const diarioId = (await store.folderCreate('root', 'Diario')).id;
    await store.blobPut(bytes, { mime: 'application/vnd.oasis.opendocument.spreadsheet', expectedSha256: sha(bytes) });
    const file = await store.fileCreate(options.folder === 'Diario' ? diarioId : hojas, 'datos.ods', sha(bytes));
    return { fileId: file.id, diario: diarioId };
  });
  const ctx = await contextOf(port, config);
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
  const edit = (input: Omit<EditSheetInput, 'id'>, context: ToolContext = ctx) => runEditSheet(context, { id: fileId, ...input }, writer);
  return { port, ctx, writer, edit, fileId, diario, bytes, calls: () => calls };
}

/** El contexto de una llamada, con el filtro de privados de `filterConfig` (por defecto el real). */
async function contextOf(port: NodeLibraryPort, config: PrivacyConfig, filterConfig = config): Promise<ToolContext> {
  const privacy = await (await PrivacyFilter.build(port, filterConfig)).ensureAll();
  return { port, privacy, privacyConfig: config, status: new UnlinkedStatusSource() };
}

const ADDRESSES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'C2', 'D1', 'E1'] as const;
type Address = (typeof ADDRESSES)[number];

function cellOf(sheet: SheetModelSheet, address: string): unknown {
  const match = /^([A-Z]+)(\d+)$/.exec(address)!;
  const col = [...match[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  return sheet.cells.get(`${sheet.rows.idAt(row)}:${sheet.cols.idAt(col)}`) ?? null;
}

/** Lo que vería `hebra_read_sheet` de la hoja `Datos`: revisiones, filas y unas celdas. */
async function readState(h: { port: NodeLibraryPort; fileId: string; bytes: Uint8Array }) {
  const opened = await openSheetRead(h.port.documentSource(), { id: h.fileId, sha256: sha(h.bytes) }, live, 'empty');
  try {
    const sheet = opened.read.model.sheets.find((s) => s.name === 'Datos')!;
    const cells = Object.fromEntries(ADDRESSES.map((address) => [address, cellOf(sheet, address)])) as Record<Address, unknown>;
    return { revision: opened.read.revision, layoutRevision: opened.read.layoutRevision, rows: sheet.rows.length(), cells };
  } finally {
    await opened.close();
  }
}

/** Lo guardado del documento: cabecera y cuántos updates tiene. Lo que cambiaría una escritura. */
async function stored(h: { port: NodeLibraryPort; fileId: string }) {
  const state = await h.port.documentSource().port.docRead(h.fileId);
  return { head: state.head, updates: state.segments.length + state.pending.length };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).code).toBe(code);
  return error as ToolError;
}

const set = (start: string, rows: unknown[][], expectValue?: Record<string, unknown>): SheetCommand => ({
  type: 'setCells',
  sheet: 'Datos',
  start,
  rows,
  ...(expectValue ? { expect: expectValue } : {})
});

describe('hebra_edit_sheet (H-80)', () => {
  it('un .ods sin cabecera: casa con la revisión de su lectura, escribe la cabecera y el lote', async () => {
    const h = await world();
    const before = await readState(h);
    expect((await stored(h)).head).toBeNull();
    const out = await h.edit({
      operationId: 'op-1',
      expectedRevision: before.revision,
      expectedLayout: before.layoutRevision,
      ops: [set('A1', [[10]])]
    });
    expect(out).toMatchObject({ outcome: 'saved', previousRevision: before.revision, undoAvailable: true, changed: { cells: 1, sheets: 1 } });
    expect((await stored(h)).head).toMatchObject({ format: 'ods' });
    const after = await readState(h);
    expect(after.cells.A1).toBe(10);
    expect(after.revision).toBe(out.revision);
  });

  it('un expect viejo da precondition_failed y no escribe nada', async () => {
    const h = await world();
    const before = await readState(h);
    await expectCode(h.edit({ operationId: 'op-1', ops: [set('A1', [[5]], { A1: 'otro' })] }), 'precondition_failed');
    expect((await stored(h)).updates).toBe(0);
    expect((await readState(h)).cells.A1).toBe(before.cells.A1);
  });

  it('una expectedRevision vieja da precondition_failed con target expectedRevision', async () => {
    const h = await world();
    const before = await readState(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A2', [[7]])] });
    const error = await expectCode(
      h.edit({ operationId: 'op-2', expectedRevision: before.revision, ops: [set('A1', [[8]])] }),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ target: 'expectedRevision' });
    expect((await readState(h)).cells.A1).toBe(before.cells.A1);
  });

  it('WEBSERVICE o una imagen por URL dan batch_invalid sin llegar al escritor', async () => {
    const h = await world();
    const before = await readState(h);
    await expectCode(
      h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [['=WEBSERVICE("https://ejemplo.com")']])] }),
      'batch_invalid'
    );
    await expectCode(
      h.edit({ operationId: 'op-2', expectedRevision: before.revision, ops: [set('A1', [[1]])], assets: [{ ref: 'x', url: 'https://ejemplo.com/a.png' }] }),
      'batch_invalid'
    );
    expect(h.calls()).toBe(0);
  });

  it('el lote es atómico: un comando que no casa en la fase 2 deja sin escribir los de antes', async () => {
    const h = await world();
    const error = await expectCode(
      h.edit({ operationId: 'op-1', ops: [set('C2', [['nuevo']], { C2: null }), set('A1', [[5]], { A1: 999 })] }),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ opIndex: 1, target: 'ops.1' });
    expect(await stored(h)).toMatchObject({ updates: 0 });
    expect((await readState(h)).cells.C2).toBeNull();
  });
});

describe('carpeta privada y espacio de solo lectura', () => {
  it('una carpeta privada da not_found sin llegar al escritor; el escritor también la rechaza en su turno', async () => {
    const h = await world({ folder: 'Diario' });
    await expectCode(h.edit({ operationId: 'op-1', ops: [set('A1', [[1]], { A1: 1 })] }), 'not_found');
    expect(h.calls()).toBe(0);
    // Un filtro de la llamada que no conoce la carpeta privada (la configuración cambió por medio):
    // la herramienta deja pasar y el turno del escritor la rechaza con la de verdad, sin poner
    // siquiera la cabecera.
    const blind = await contextOf(h.port, CONFIG, { privateFolders: [], privateTags: [] });
    await expectCode(h.edit({ operationId: 'op-2', ops: [set('A1', [[2]], { A1: 1 })] }, blind), 'not_found');
    expect(h.calls()).toBe(1);
    expect(await stored(h)).toEqual({ head: null, updates: 0 });
  });

  it('un fichero que pasa a una carpeta privada entre la fase 2 y la 3 da not_found sin escribir', async () => {
    const h = await world();
    const before = await readState(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A2', [[20]])] });
    const written = await stored(h);
    hooks.betweenPhases = async () => {
      await h.port.writeExclusive(async (store) => store.fileMove(h.fileId, h.diario));
    };
    await expectCode(h.edit({ operationId: 'op-2', ops: [set('A1', [[10]], { A1: 1 })] }), 'not_found');
    expect((await stored(h)).updates).toBe(written.updates);
    expect((await readState(h)).cells.A1).toBe(1);
  });

  it('un espacio de solo lectura rechaza el lote sin escribir, ni la cabecera; con escritura, entra', async () => {
    const writable = await world({ shared: true });
    const before = await readState(writable);
    await writable.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [[10]])] });
    expect((await readState(writable)).cells.A1).toBe(10);

    const readonly = await world({ shared: true });
    await readonly.port.syncStorePort().syncApplyPage(readOnlyPage());
    await expectCode(readonly.edit({ operationId: 'op-1', ops: [set('A1', [[10]], { A1: 1 })] }), 'client_outdated');
    expect(await stored(readonly)).toEqual({ head: null, updates: 0 });
  });

  it('un espacio que queda de solo lectura entre la fase 2 y la 3 rechaza el lote en el turno del escritor', async () => {
    const h = await world({ shared: true });
    const before = await readState(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A2', [[20]])] });
    const written = await stored(h);
    hooks.betweenPhases = async () => {
      await h.port.syncStorePort().syncApplyPage(readOnlyPage());
    };
    await expectCode(h.edit({ operationId: 'op-2', ops: [set('A1', [[10]], { A1: 1 })] }), 'client_outdated');
    expect((await stored(h)).updates).toBe(written.updates);
    expect((await readState(h)).cells.A1).toBe(1);
  });
});

describe('dryRun', () => {
  it('dryRun ensaya, informa y no escribe nada: ni cabecera, ni updates, ni registro de la operación', async () => {
    const h = await world();
    const before = await readState(h);
    const out = await h.edit({ operationId: 'op-1', dryRun: true, expectedRevision: before.revision, ops: [set('A1', [[10], [20]])] });
    expect(out).toMatchObject({ outcome: 'validated', revision: before.revision, layoutRevision: before.layoutRevision, sync: 'not_applicable', changed: { cells: 2, sheets: 1 } });
    expect(out.undoAvailable).toBeUndefined();
    expect(await stored(h)).toEqual({ head: null, updates: 0 });
    expect((await readState(h)).cells.A1).toBe(1);
    // El ensayo no ocupó el `operationId`: el mismo lote de verdad escribe.
    const real = await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [[10], [20]])] });
    expect(real.outcome).toBe('saved');
    expect((await readState(h)).cells).toMatchObject({ A1: 10, A2: 20 });
  });

  it('dryRun sobre un documento con cabecera y estado tampoco añade un update', async () => {
    const h = await world();
    const before = await readState(h);
    const real = await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [[10]])] });
    const written = await stored(h);
    const out = await h.edit({ operationId: 'op-2', dryRun: true, ops: [set('A1', [[99]], { A1: 10 })] });
    expect(out).toMatchObject({ outcome: 'validated', revision: real.revision, changed: { cells: 1 } });
    expect((await stored(h)).updates).toBe(written.updates);
    expect((await readState(h)).cells.A1).toBe(10);
  });

  it('dryRun también rechaza lo que no casa, sin escribir', async () => {
    const h = await world();
    const error = await expectCode(
      h.edit({ operationId: 'op-1', dryRun: true, ops: [set('C2', [['x']], { C2: null }), set('A1', [[5]], { A1: 999 })] }),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ opIndex: 1 });
    expect(await stored(h)).toEqual({ head: null, updates: 0 });
  });
});

describe('hojas ocultas (H-OCULTAR-HOJA)', () => {
  const sheetsOf = async (h: { port: NodeLibraryPort; fileId: string; bytes: Uint8Array }) => {
    const opened = await openSheetRead(h.port.documentSource(), { id: h.fileId, sha256: sha(h.bytes) }, live, 'empty');
    try {
      return opened.read.model.sheets.map((sheet) => [sheet.name, sheet.hidden === true]);
    } finally {
      await opened.close();
    }
  };

  it('oculta y muestra una hoja; hebra_read_sheet la ve hidden y el deshacer la devuelve', async () => {
    const h = await world();
    expect(await sheetsOf(h)).toEqual([['Datos', false], ['Resumen', false]]);
    await h.edit({ operationId: 'op-1', ops: [{ type: 'setSheetHidden', sheet: 'Resumen', hidden: true }] });
    expect(await sheetsOf(h)).toEqual([['Datos', false], ['Resumen', true]]);
    await h.edit({ operationId: 'op-2', ops: [{ type: 'setSheetHidden', sheet: 'Resumen', hidden: false }] });
    expect(await sheetsOf(h)).toEqual([['Datos', false], ['Resumen', false]]);
    await h.edit({ operationId: 'op-3', ops: [{ type: 'setSheetHidden', sheet: 'Resumen', hidden: true }] });
    await h.edit({ operationId: 'op-u', undoOperationId: 'op-3' });
    expect(await sheetsOf(h)).toEqual([['Datos', false], ['Resumen', false]]);
  });

  it('ocultar la última hoja visible da batch_invalid sin escribir', async () => {
    const h = await world();
    await h.edit({ operationId: 'op-1', ops: [{ type: 'setSheetHidden', sheet: 'Resumen', hidden: true }] });
    const before = await stored(h);
    await expectCode(h.edit({ operationId: 'op-2', ops: [{ type: 'setSheetHidden', sheet: 'Datos', hidden: true }] }), 'batch_invalid');
    expect(await stored(h)).toEqual(before);
    expect(await sheetsOf(h)).toEqual([['Datos', false], ['Resumen', true]]);
  });
});

describe('deshacer', () => {
  it('deshace el lote exacto, una sola vez, y el reintento devuelve lo mismo', async () => {
    const h = await world();
    const before = await readState(h);
    const out = await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [[10], [20]]), set('C2', [['nuevo']])] });
    expect(out).toMatchObject({ outcome: 'saved', undoAvailable: true });
    expect(typeof out.undoUntil).toBe('string');

    const undone = await h.edit({ operationId: 'op-u', undoOperationId: 'op-1' });
    expect(undone).toMatchObject({ outcome: 'saved', undoAvailable: false, previousRevision: out.revision });
    const after = await readState(h);
    expect(after.cells).toMatchObject({ A1: 1, A2: 2, C2: null });
    expect(after.revision).toBe(undone.revision);

    const replay = await h.edit({ operationId: 'op-u', undoOperationId: 'op-1' });
    expect(replay).toMatchObject({ outcome: 'already', replayed: true });
    // Ya deshecho: otro deshacer no encuentra la entrada.
    await expectCode(h.edit({ operationId: 'op-u2', undoOperationId: 'op-1' }), 'not_found');
    expect((await readState(h)).revision).toBe(after.revision);
  });

  it('deshace una fila insertada', async () => {
    const h = await world();
    const before = await readState(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [{ type: 'insertAxis', sheet: 'Datos', axis: 'row', at: 1, count: 1 }] });
    expect((await readState(h)).rows).toBe(before.rows + 1);
    await h.edit({ operationId: 'op-u', undoOperationId: 'op-1' });
    const after = await readState(h);
    expect(after.rows).toBe(before.rows);
    expect(after.cells).toMatchObject({ A1: 1, A2: 2, A3: 3 });
  });

  it('si otra persona cambió lo mismo después, el deshacer da precondition_failed sin escribir', async () => {
    const h = await world();
    const before = await readState(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [set('A1', [[10]])] });
    await h.edit({ operationId: 'op-2', ops: [set('A1', [[30]], { A1: 10 })] });
    const written = await stored(h);
    await expectCode(h.edit({ operationId: 'op-u', undoOperationId: 'op-1' }), 'precondition_failed');
    expect((await stored(h)).updates).toBe(written.updates);
    expect((await readState(h)).cells.A1).toBe(30);
  });

  it('deshacer no admite dryRun ni garantías del lote', async () => {
    const h = await world();
    await expectCode(h.edit({ operationId: 'op-u', undoOperationId: 'op-1', dryRun: true }), 'invalid_input');
    await expectCode(h.edit({ operationId: 'op-u', undoOperationId: 'op-1', expectedLayout: 'x' }), 'invalid_input');
    expect(h.calls()).toBe(0);
  });
});

/**
 * Anchos y altos de la hoja `Datos` como los pinta la rejilla (y `hebra_render_sheet`): los datos
 * del editor (`createEditorData`) sobre la lectura común. `visibleSize` es la medida en píxeles CSS.
 */
async function axisSizes(h: { port: NodeLibraryPort; fileId: string; bytes: Uint8Array }) {
  const opened = await openSheetRead(h.port.documentSource(), { id: h.fileId, sha256: sha(h.bytes) }, live, 'empty');
  const data = await createEditorData({ doc: opened.read.doc, base: opened.base });
  try {
    const sheet = opened.read.model.sheets.find((s) => s.name === 'Datos')!;
    const cols = data.colsAxis(sheet.id);
    const rows = data.rowsAxis(sheet.id);
    return { colA: cols.visibleSize(0), colB: cols.visibleSize(1), colC: cols.visibleSize(2), row1: rows.visibleSize(0), row2: rows.visibleSize(1) };
  } finally {
    data.dispose();
    await opened.close();
  }
}

describe('medidas de filas y columnas (setAxisSize)', () => {
  it('cambia el ancho de una columna y el alto de una fila en puntos, y una lectura lo ve', async () => {
    const h = await world();
    const before = await readState(h);
    const sizes = await axisSizes(h);
    expect(sizes.colB).not.toBe(150);
    const out = await h.edit({
      operationId: 'op-1',
      expectedRevision: before.revision,
      ops: [
        { type: 'setAxisSize', sheet: 'Datos', axis: 'col', at: 2, count: 1, size: 150 },
        // 30 pt son 40 px (96 por pulgada contra 72).
        { type: 'setAxisSize', sheet: 'Datos', axis: 'row', at: 2, count: 1, size: 30, unit: 'pt' }
      ]
    });
    expect(out).toMatchObject({ outcome: 'saved' });
    const after = await axisSizes(h);
    expect(after).toEqual({ ...sizes, colB: 150, row2: 40 });
    // Las celdas no se mueven y la revisión de la lectura es la de la respuesta.
    const read = await readState(h);
    expect(read.cells).toEqual(before.cells);
    expect(read.revision).toBe(out.revision);
  });

  it('un tramo de columnas sale con una sola medida y deshacer devuelve la del fichero', async () => {
    const h = await world();
    const before = await readState(h);
    const sizes = await axisSizes(h);
    await h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [{ type: 'setAxisSize', sheet: 'Datos', axis: 'col', at: 1, count: 3, size: 90 }] });
    expect(await axisSizes(h)).toEqual({ ...sizes, colA: 90, colB: 90, colC: 90 });
    await h.edit({ operationId: 'op-u', undoOperationId: 'op-1' });
    expect(await axisSizes(h)).toEqual(sizes);
  });

  it('una medida fuera de tope es batch_invalid y no escribe: por esquema en px, por compileBatch en pt', async () => {
    const h = await world();
    const before = await readState(h);
    const sizes = await axisSizes(h);
    await expectCode(
      h.edit({ operationId: 'op-1', expectedRevision: before.revision, ops: [{ type: 'setAxisSize', sheet: 'Datos', axis: 'col', at: 1, count: 1, size: 10_001 }] }),
      'batch_invalid'
    );
    // La forma la rechaza el esquema, antes de llegar al escritor.
    expect(h.calls()).toBe(0);
    // 7.600 pt son 10.133 px: pasa la forma, pero no el tope del núcleo.
    await expectCode(
      h.edit({ operationId: 'op-2', expectedRevision: before.revision, ops: [{ type: 'setAxisSize', sheet: 'Datos', axis: 'col', at: 1, count: 1, size: 7600, unit: 'pt' }] }),
      'batch_invalid'
    );
    await expectCode(
      h.edit({ operationId: 'op-3', ops: [{ type: 'setAxisSize', sheet: 'Datos', axis: 'col', at: 1, count: 1, size: 80 }] }),
      'batch_invalid'
    );
    // Sin `expect` ni `expectedRevision`, la regla de direcciones también vale para las medidas.
    // Ningún lote escribe un update (la cabecera puede quedar, como en el resto de rechazos).
    expect((await stored(h)).updates).toBe(0);
    expect(await axisSizes(h)).toEqual(sizes);
  });
});

describe('persona a la vez entre la fase 2 y la 3', () => {
  it('en la misma celda da precondition_failed sin escribir, con el comando que falló', async () => {
    const h = await world();
    hooks.betweenPhases = async () => {
      await h.edit({ operationId: 'otra-persona', ops: [set('A1', [[50]], { A1: 1 })] });
    };
    const error = await expectCode(
      h.edit({ operationId: 'op-1', ops: [set('C2', [['nuevo']], { C2: null }), set('A1', [[100]], { A1: 1 })] }),
      'precondition_failed'
    );
    // El comando del LLM que falló, no la operación de la sesión (siempre la 0).
    expect(error.extra).toMatchObject({ opIndex: 1, target: 'ops.1' });
    const after = await readState(h);
    expect(after.cells).toMatchObject({ A1: 50, C2: null });
    expect((await stored(h)).updates).toBe(1);
  });

  it('una operación compilada que falla se cuenta en su comando (commandLocator)', async () => {
    const h = await world();
    const opened = await openSheetRead(h.port.documentSource(), { id: h.fileId, sha256: sha(h.bytes) }, live, 'empty');
    try {
      // 4 operaciones del primer comando, ninguna del segundo (`freeze` no direcciona celdas y da
      // una), 1 del tercero.
      const batch = { type: 'sheet.batch' as const, seed: 'op-1', commands: [set('A1', [[1, 2], [3, 4]]), { type: 'freeze', sheet: 'Datos', rows: 1, cols: 0 } as SheetCommand, set('D1', [[5]])] };
      const commandOf = commandLocator(opened.read.model, batch, opened.read.revision);
      expect([0, 1, 2, 3, 4, 5].map(commandOf)).toEqual([0, 0, 0, 0, 1, 2]);
    } finally {
      await opened.close();
    }
  });

  it('en otra celda entra sin copia de conflicto y no pierde la otra escritura', async () => {
    const h = await world();
    const filesBefore = (await h.port.filesIndex()).files.length;
    hooks.betweenPhases = async () => {
      await h.edit({ operationId: 'otra-persona', ops: [set('A3', [[70]], { A3: 3 })] });
    };
    const out = await h.edit({ operationId: 'op-1', ops: [set('A1', [[100]], { A1: 1 })] });
    expect(out.outcome).toBe('saved');
    expect((await readState(h)).cells).toMatchObject({ A1: 100, A3: 70 });
    expect((await h.port.filesIndex()).files.length).toBe(filesBefore);
  });
});

describe('expectedLayout', () => {
  it('una expectedLayout caducada no aplica nada, aunque el destino desplazado siga vacío', async () => {
    const h = await world();
    const before = await readState(h);
    // Otra persona inserta una fila antes de A4 (vacía): la nueva A4 también está vacía.
    await h.edit({ operationId: 'otra-persona', expectedRevision: before.revision, ops: [{ type: 'insertAxis', sheet: 'Datos', axis: 'row', at: 4, count: 1 }] });
    const written = await stored(h);
    const error = await expectCode(
      h.edit({ operationId: 'op-1', expectedLayout: before.layoutRevision, ops: [set('A4', [['total']], { A4: null })] }),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ target: 'expectedLayout' });
    expect((await stored(h)).updates).toBe(written.updates);
    expect((await readState(h)).cells).toMatchObject({ A4: null, A5: null });
  });

  it('una expectedLayout que caduca entre la fase 2 y la 3 tampoco aplica nada', async () => {
    const h = await world();
    const before = await readState(h);
    hooks.betweenPhases = async () => {
      await h.edit({ operationId: 'otra-persona', ops: [{ type: 'insertAxis', sheet: 'Datos', axis: 'row', at: 4, count: 1, expect: { A4: null } }] });
    };
    const error = await expectCode(
      h.edit({ operationId: 'op-1', expectedLayout: before.layoutRevision, ops: [set('A4', [['total']], { A4: null })] }),
      'precondition_failed'
    );
    expect(error.extra).toMatchObject({ target: 'expectedLayout' });
    const after = await readState(h);
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cells).toMatchObject({ A4: null, A5: null });
    expect((await stored(h)).updates).toBe(1);
  });
});

describe('un corte entre el append y la respuesta', () => {
  it('el reintento con el mismo operationId no repite el lote: un solo efecto', async () => {
    const h = await world();
    const before = await readState(h);
    // Una fila antes de la 10 (vacía) con `expect` en ella: tras insertarla, la 10 sigue vacía y el
    // `expect` vuelve a casar, así que solo el registro de la operación evita una segunda fila.
    const input = {
      operationId: 'op-1',
      ops: [{ type: 'insertAxis', sheet: 'Datos', axis: 'row', at: 10, count: 1, expect: { A10: null } } as SheetCommand]
    };
    hooks.cut = true;
    await expect(h.edit(input)).rejects.toBeInstanceOf(ToolError);
    expect(hooks.cut).toBe(false);
    // El append y el registro se confirmaron juntos.
    expect((await readState(h)).rows).toBe(before.rows + 1);

    const retry = await h.edit(input);
    expect(retry).toMatchObject({ outcome: 'already', replayed: true });
    const after = await readState(h);
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cells).toMatchObject({ A1: 1, A2: 2, A3: 3 });
  });
});

describe('errores de fórmula con el motor real', () => {
  it('un lote con fórmulas da recalculated y el #DIV/0! en formulaErrors', async () => {
    const h = await world();
    const before = await readState(h);
    const input = { expectedRevision: before.revision, ops: [set('D1', [['=A1*2', '=1/0']])] };
    const dry = await h.edit({ operationId: 'op-1', dryRun: true, ...input });
    const out = await h.edit({ operationId: 'op-1', ...input });
    for (const result of [dry, out]) {
      expect(result.calculated).toBeUndefined();
      expect(result.formulaErrors).toEqual([{ sheet: 'Datos', cell: 'E1', error: '#DIV/0!' }]);
      // Las fórmulas del libro de después: B1 y Resumen.A1 del fichero, y las dos escritas.
      expect(result.recalculated?.cells).toBe(4);
      expect(result.recalculated?.ms).toBeGreaterThanOrEqual(0);
    }
    const after = await readState(h);
    expect(after.cells.D1).toMatchObject({ f: expect.anything() });
    expect(after.cells.E1).toMatchObject({ f: expect.anything() });
  });

  it('un lote sin fórmulas no arranca el motor', async () => {
    const h = await world();
    const out = await h.edit({ operationId: 'op-1', ops: [set('A1', [[5]], { A1: 1 })] });
    expect(out).toMatchObject({ recalculated: { cells: 0, ms: 0 }, formulaErrors: [] });
  });
});

describe('la regla de direcciones es la misma en hebra_edit_sheet y en assertAddressRule', () => {
  it('caso por caso: expect, expectedRevision, expect con expectedLayout, solo expectedLayout y nada', async () => {
    const h = await world();
    const before = await readState(h);
    const bare = set('A1', [[5]]);
    const guarded = set('A1', [[5]], { A1: 1 });
    const cases: Array<{ name: string; command: SheetCommand; guards: { expectedRevision?: string; expectedLayout?: string }; ok: boolean }> = [
      { name: 'expect', command: guarded, guards: {}, ok: true },
      { name: 'expectedRevision', command: bare, guards: { expectedRevision: before.revision }, ok: true },
      { name: 'expect y expectedLayout', command: guarded, guards: { expectedLayout: before.layoutRevision }, ok: true },
      { name: 'solo expectedLayout', command: bare, guards: { expectedLayout: before.layoutRevision }, ok: false },
      { name: 'nada', command: bare, guards: {}, ok: false }
    ];
    const isAddressed = (command: SheetCommand) => 'start' in command || 'range' in command || 'at' in command;
    for (const [index, item] of cases.entries()) {
      const tool = await h.edit({ operationId: `op-${index}`, dryRun: true, ops: [item.command], ...item.guards }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof ToolError && error.code === 'batch_invalid') return false;
          throw error;
        }
      );
      let rule = true;
      try {
        assertAddressRule<SheetCommand>({ ops: [item.command], ...item.guards }, isAddressed);
      } catch (error) {
        if (!(error instanceof DocumentAddressError)) throw error;
        rule = false;
      }
      expect({ name: item.name, tool, rule }).toEqual({ name: item.name, tool: item.ok, rule: item.ok });
    }
    expect(await stored(h)).toEqual({ head: null, updates: 0 });
  });
});
