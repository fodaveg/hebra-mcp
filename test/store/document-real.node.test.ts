/**
 * B-M04b: escribir y deshacer lotes con las piezas REALES: `createDocSession`, el adaptador de
 * hojas de `vendor/hebra` (`createSheetAdapter`), SQLite en fichero y `NodeLibraryPort`. Lo
 * único inyectado es `compute` (el hilo de la fase 2, que no es de este paquete).
 *
 * Antes de B-M04b los dos paquetes anteriores (B-M03, B-M04) solo se habían probado con un doble
 * de sesión y dejaban tres fallos que un doble no ve:
 * - interbloqueo: `sessionPortOf` escribe por la cola y la fase 3 ya está dentro de un turno;
 * - deshacer no exacto: la inversa del recibo de `DocSession.apply` no lleva `expect`, y la
 *   guarda de `prepareUndo` es por identidad y se pierde al guardar la inversa en SQLite;
 * - sin enganchar: `node-port` no creaba la tabla ni ponía el registro en el turno.
 *
 * El interbloqueo se detecta sin tiempos: mientras corre el turno, cualquier entrada en la cola
 * (`NodeLibraryPort.write`) lanza `QueueEnteredInTurn` en el acto en vez de esperarse a sí misma.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `openDocumentSession` de `node-port` con un puerto que entra por la cola (`docAppendWith` de
 *   `documentSource().port`): caen los tests de escribir y de deshacer con `QueueEnteredInTurn`;
 * - quitar `steps` al guardar (`captureUndo` fuera de `runDocumentOps`): caen el de «un cambio
 *   posterior en la misma celda» (la inversa pisa el cambio) y el de reabrir la base;
 * - no llamar a `ensureDocumentUndoTable` en `node-port`: cae todo lo de deshacer (sin tabla).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { PrivacyConfig } from '../../src/privacy/config';
import { runDocumentOps, type DocumentOpsStore } from '../../src/store/document-ops';
import { documentTurnOf, undoDocumentOps, type DocumentUndoOpsStore } from '../../src/store/document-undo';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { DocumentError } from '../../src/store/document-types';
import type { SheetOp } from '../../vendor/hebra/src/lib/sheets/contracts/ops';
import { readAxisMeta } from '../../vendor/hebra/src/lib/sheets/ops/apply-axis';
import { createSheetAdapter, prepareSheetBase, type SheetAdapter } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';

const CONFIG: PrivacyConfig = { privateFolders: [], privateTags: [] };
const live = new AbortController().signal;
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Entrar en la cola con un turno abierto: el interbloqueo, detectado sin esperar. */
class QueueEnteredInTurn extends Error {
  constructor() {
    super('queue-entered-in-turn');
  }
}

/** Una celda de `Datos` (A1 a A3 valen 1, 2 y 3 en el fichero; `b<fila>:b<columna>`). */
type At = { sheet: string; row: string; col: string };
const A1: At = { sheet: 's0', row: 'b0', col: 'b0' };
const A2: At = { sheet: 's0', row: 'b1', col: 'b0' };
const A3: At = { sheet: 's0', row: 'b2', col: 'b0' };
const setCell = (at: At, value: number | string): SheetOp => ({ type: 'cell.set', ...at, value, replaces: [] });

interface Harness {
  directory: string;
  path: string;
  bytes: Uint8Array;
  fileId: string;
  generation: string;
  port: NodeLibraryPort;
  adapter: SheetAdapter;
  clock: number;
  inTurn: boolean;
  ops: DocumentOpsStore;
  undo: DocumentUndoOpsStore;
}

/** Instala el vigilante de la cola sobre un puerto: dentro de un turno, entrar en ella lanza. */
function watchQueue(h: Harness): void {
  const queue = h.port as unknown as { write: (operation: () => unknown) => Promise<unknown> };
  const real = queue.write.bind(h.port);
  vi.spyOn(queue, 'write').mockImplementation((operation) => {
    if (h.inTurn) throw new QueueEnteredInTurn();
    return real(operation);
  });
}

function wire(h: Harness): void {
  const turn = <T>(operation: (turn: ReturnType<typeof documentTurnOf>) => Promise<T>): Promise<T> =>
    h.port.writeExclusive(async (store) => {
      h.inTurn = true;
      try {
        return await operation(documentTurnOf(store, CONFIG));
      } finally {
        h.inTurn = false;
      }
    });
  h.ops = {
    now: () => h.clock,
    turn,
    compute: async () => ({ ok: true, revision: 'calculada' })
  };
  h.undo = { now: () => h.clock, turn };
  watchQueue(h);
}

/** Abre la base del fichero con un puerto nuevo (un reinicio del MCP). */
async function reopen(h: Harness): Promise<void> {
  await h.port.closeWhenIdle();
  ports.splice(ports.indexOf(h.port), 1);
  vi.restoreAllMocks();
  h.port = await openNodeLibraryPort({ sqlitePath: h.path, dataDir: h.directory });
  ports.push(h.port);
  wire(h);
}

async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-real-'));
  directories.push(directory);
  const path = join(directory, 'library.sqlite');
  const port = await openNodeLibraryPort({ sqlitePath: path, dataDir: directory });
  ports.push(port);
  const bytes = buildOds();
  const adapter = createSheetAdapter(await prepareSheetBase(bytes));
  const fileId = await port.writeExclusive(async (store) => {
    const folder = (await store.folderCreate('root', 'Hojas')).id;
    await store.blobPut(bytes, {
      mime: 'application/vnd.oasis.opendocument.spreadsheet',
      expectedSha256: sha(bytes)
    });
    return (await store.fileCreate(folder, 'hoja.ods', sha(bytes))).id;
  });
  // Cabecera y estado inicial, como los deja la creación de un `.ods`: andamio del fichero en V2.
  const generation = 'g-b-m04b';
  const source = port.documentSource().port;
  await source.docSetHead(fileId, newDocumentHead('ods', generation, sha(bytes)), [sha(bytes)]);
  const scaffold = new Y.Doc();
  adapter.scaffold(bytes, scaffold);
  await source.docAppend(fileId, generation, Y.encodeStateAsUpdateV2(scaffold));
  scaffold.destroy();
  const h: Harness = {
    directory,
    path,
    bytes,
    fileId,
    generation,
    port,
    adapter,
    clock: Date.UTC(2026, 10, 21),
    inTurn: false,
    ops: undefined as unknown as DocumentOpsStore,
    undo: undefined as unknown as DocumentUndoOpsStore
  };
  wire(h);
  return h;
}

/** El `Y.Doc` del documento tal como lo deja el almacén: lanza si algún update no es V2. */
async function stored(h: Harness): Promise<{ doc: Y.Doc; pending: number }> {
  const state = await h.port.documentSource().port.docRead(h.fileId);
  const doc = new Y.Doc();
  for (const piece of [...state.segments, ...state.pending]) Y.applyUpdateV2(doc, piece);
  return { doc, pending: state.pending.length };
}

/** Lo que ve una persona en una celda de `Datos`. */
async function cell(h: Harness, at: At): Promise<unknown> {
  const { doc } = await stored(h);
  const model = await h.adapter.project(h.bytes, doc, live);
  const value = model.sheets[0]!.cells.get(`${at.row}:${at.col}`);
  doc.destroy();
  return value === undefined ? null : value;
}

async function rowCount(h: Harness): Promise<number> {
  const { doc } = await stored(h);
  const model = await h.adapter.project(h.bytes, doc, live);
  const rows = model.sheets[0]!.rows;
  doc.destroy();
  return rows.length();
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

async function write(h: Harness, ops: SheetOp[], operationId = nextId('lote')) {
  const result = await runDocumentOps(h.ops, { id: h.fileId, operationId, ops }, h.adapter);
  return { operationId, result };
}

async function applied(h: Harness, ops: SheetOp[]): Promise<string> {
  const { operationId, result } = await write(h, ops);
  expect(result).toMatchObject({ ok: true, out: { outcome: 'saved', undoAvailable: true } });
  return operationId;
}

function undo(h: Harness, undoOperationId: string) {
  return undoDocumentOps(h.undo, { id: h.fileId, operationId: nextId('des'), undoOperationId }, h.adapter);
}

/** Una edición de OTRA persona: otra réplica del documento, otro `clientID`, directo al almacén. */
async function personEdits(h: Harness, op: SheetOp): Promise<void> {
  const { doc } = await stored(h);
  const person = new Y.Doc();
  Y.applyUpdateV2(person, Y.encodeStateAsUpdateV2(doc));
  doc.destroy();
  person.clientID = 4242;
  const before = Y.encodeStateVector(person);
  person.transact(() => {
    h.adapter.applyOp(person, op, { newId: (() => { let n = 0; return () => `persona-${n++}`; })() });
  }, 'user');
  await h.port.documentSource().port.docAppend(h.fileId, h.generation, Y.encodeStateAsUpdateV2(person, before));
  person.destroy();
}

const precondition = (index = 0): DocumentError => ({
  code: 'precondition_failed',
  opIndex: index,
  target: `inverse[${index}]`
});

describe('escribir con la sesión y el adaptador reales', () => {
  it('un lote de cell.set se aplica sin entrar en la cola y llega al almacén en V2', async () => {
    const h = await harness();
    const { result } = await write(h, [setCell(A1, 10), setCell(A2, 'texto')]);

    expect(result).toMatchObject({ ok: true, out: { id: h.fileId, outcome: 'saved', undoAvailable: true } });
    // `stored` lanza con `Unexpected end of array` si la sesión escribiera V1.
    const { pending } = await stored(h);
    expect(pending).toBe(2);
    expect(await cell(h, A1)).toBe(10);
    expect(await cell(h, A2)).toBe('texto');
    expect(await cell(h, A3)).toBe(3);
  });

  it('con una operación imposible no escribe nada y la cola sigue libre', async () => {
    const h = await harness();
    const { result } = await write(h, [setCell(A1, 10), { type: 'axis.delete', sheet: 's0', axis: 'row', ids: ['no-existe'] }]);
    expect(result.ok).toBe(false);
    expect((await stored(h)).pending).toBe(1);
    expect(await cell(h, A1)).toBe(1);
    // La cola sigue usable: otro lote entra.
    expect((await write(h, [setCell(A1, 11)])).result.ok).toBe(true);
  });
});

describe('deshacer con la sesión y el adaptador reales', () => {
  it('devuelve el contenido exacto: la primera edición de una celda del fichero vuelve a su valor', async () => {
    const h = await harness();
    const lote = await applied(h, [setCell(A1, 10), setCell(A2, 'texto')]);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await cell(h, A1)).toBe(1);
    expect(await cell(h, A2)).toBe(2);
    // Una entrada se consume: no se deshace dos veces.
    expect(await undo(h, lote)).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('dos lotes seguidos sobre la misma celda se deshacen del más nuevo al más antiguo', async () => {
    const h = await harness();
    const uno = await applied(h, [setCell(A1, 10)]);
    const dos = await applied(h, [setCell(A1, 20), setCell(A3, 30)]);
    expect((await undo(h, dos)).ok).toBe(true);
    expect(await cell(h, A1)).toBe(10);
    expect(await cell(h, A3)).toBe(3);
    expect((await undo(h, uno)).ok).toBe(true);
    expect(await cell(h, A1)).toBe(1);
  });

  it('un cambio posterior en la misma celda da precondition_failed y no escribe', async () => {
    const h = await harness();
    const lote = await applied(h, [setCell(A1, 10)]);
    await personEdits(h, setCell(A1, 99));
    const before = (await stored(h)).pending;

    expect(await undo(h, lote)).toEqual({ ok: false, error: precondition() });
    expect((await stored(h)).pending).toBe(before);
    expect(await cell(h, A1)).toBe(99);

    // También si el cambio posterior es de otro lote del propio agente: el anterior ya no se puede.
    const h2 = await harness();
    const a = await applied(h2, [setCell(A1, 10)]);
    await applied(h2, [setCell(A1, 20)]);
    expect(await undo(h2, a)).toEqual({ ok: false, error: precondition() });
    expect(await cell(h2, A1)).toBe(20);
  });

  it('un cambio en otra celda no impide deshacer', async () => {
    const h = await harness();
    const lote = await applied(h, [setCell(A1, 10)]);
    await personEdits(h, setCell(A2, 'de la persona'));
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await cell(h, A1)).toBe(1);
    expect(await cell(h, A2)).toBe('de la persona');
  });

  it('sobrevive a cerrar y reabrir la base, con la guarda intacta', async () => {
    const h = await harness();
    const exacto = await applied(h, [setCell(A1, 10)]);
    const pisado = await applied(h, [setCell(A2, 20)]);
    await personEdits(h, setCell(A2, 'de la persona'));
    await reopen(h);

    expect(await undo(h, pisado)).toEqual({ ok: false, error: precondition() });
    expect((await undo(h, exacto)).ok).toBe(true);
    expect(await cell(h, A1)).toBe(1);
    expect(await cell(h, A2)).toBe('de la persona');
  });

  it('un reintento con el mismo operationId devuelve lo guardado sin deshacer otra vez', async () => {
    const h = await harness();
    const lote = await applied(h, [setCell(A1, 10)]);
    const operationId = nextId('des');
    const first = await undoDocumentOps(h.undo, { id: h.fileId, operationId, undoOperationId: lote }, h.adapter);
    const again = await undoDocumentOps(h.undo, { id: h.fileId, operationId, undoOperationId: lote }, h.adapter);
    expect(first.ok).toBe(true);
    expect(again).toMatchObject({ ok: true, out: { outcome: 'already', replayed: true } });
  });
});

describe('ejes: lo que hace la inversa (medido)', () => {
  const INSERT_ROW: SheetOp = { type: 'axis.insert', sheet: 's0', axis: 'row', after: 'b0', ids: ['n'] };
  const ADD_SHEET: SheetOp = { type: 'sheet.add', sheet: 's9', name: 'Nueva' };

  /** El id de la fila recién insertada (la segunda de `Datos`). */
  async function insertedRow(h: Harness): Promise<string> {
    const { doc } = await stored(h);
    const model = await h.adapter.project(h.bytes, doc, live);
    const id = model.sheets[0]!.rows.idAt(1);
    doc.destroy();
    return id;
  }

  async function sheetCount(h: Harness): Promise<number> {
    const { doc } = await stored(h);
    const model = await h.adapter.project(h.bytes, doc, live);
    doc.destroy();
    return model.sheets.length;
  }

  it('insertar una fila: si otra persona escribió en ella, deshacer da precondition_failed, no escribe y la fila y su celda siguen', async () => {
    const h = await harness();
    const before = await rowCount(h);
    const lote = await applied(h, [INSERT_ROW]);
    const inserted = await insertedRow(h);
    const ajena = { sheet: 's0', row: inserted, col: 'b0' };
    await personEdits(h, setCell(ajena, 'ajena'));
    const pending = (await stored(h)).pending;

    expect(await undo(h, lote)).toEqual({ ok: false, error: precondition() });
    expect((await stored(h)).pending).toBe(pending);
    expect(await rowCount(h)).toBe(before + 1);
    expect(await cell(h, ajena)).toBe('ajena');
  });

  it('insertar una fila: si nadie escribió en ella, deshacer la borra', async () => {
    const h = await harness();
    const before = await rowCount(h);
    const lote = await applied(h, [INSERT_ROW]);
    expect(await rowCount(h)).toBe(before + 1);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await rowCount(h)).toBe(before);
  });

  it('hoja creada por el lote: si otra persona escribió en ella, deshacer da precondition_failed y la hoja sigue', async () => {
    const h = await harness();
    const before = await sheetCount(h);
    const lote = await applied(h, [ADD_SHEET]);
    expect(await sheetCount(h)).toBe(before + 1);
    await personEdits(h, setCell({ sheet: 's9', row: 'b0', col: 'b0' }, 'ajena'));

    expect(await undo(h, lote)).toEqual({ ok: false, error: precondition() });
    expect(await sheetCount(h)).toBe(before + 1);
  });

  it('hoja creada por el lote: si nadie escribió en ella, deshacer la borra', async () => {
    const h = await harness();
    const before = await sheetCount(h);
    const lote = await applied(h, [ADD_SHEET]);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await sheetCount(h)).toBe(before);
  });

  it('la protección de lo creado sobrevive a cerrar y reabrir la base (created llega al registro SQLite)', async () => {
    const h = await harness();
    const before = await rowCount(h);
    const lote = await applied(h, [INSERT_ROW]);
    const inserted = await insertedRow(h);
    await personEdits(h, setCell({ sheet: 's0', row: inserted, col: 'b0' }, 'ajena'));
    await reopen(h);

    expect(await undo(h, lote)).toEqual({ ok: false, error: precondition() });
    expect(await rowCount(h)).toBe(before + 1);
  });

  it('tras reabrir la base, una fila creada que nadie tocó se sigue borrando al deshacer', async () => {
    const h = await harness();
    const before = await rowCount(h);
    const lote = await applied(h, [INSERT_ROW]);
    await reopen(h);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await rowCount(h)).toBe(before);
  });

  it('borrar una fila: la inversa es axis.restore y la fila vuelve con sus celdas', async () => {
    const h = await harness();
    const lote = await applied(h, [setCell(A2, 'antes'), { type: 'axis.delete', sheet: 's0', axis: 'row', ids: ['b1'] }]);
    const before = await rowCount(h);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await rowCount(h)).toBe(before + 1);
    expect(await cell(h, A2)).toBe(2);
  });

  it('axis.size: la inversa de la primera medida es px null; si otra persona la cambió, precondition_failed', async () => {
    const h = await harness();
    const lote = await applied(h, [{ type: 'axis.size', sheet: 's0', axis: 'row', id: 'b0', px: 40 }]);
    const sizeOf = async () => {
      const { doc } = await stored(h);
      const size = readAxisMeta(doc, 's0', 'row', 'b0').size;
      doc.destroy();
      return size;
    };
    expect(await sizeOf()).toBe(40);
    expect((await undo(h, lote)).ok).toBe(true);
    expect(await sizeOf()).toBeNull();

    const otro = await applied(h, [{ type: 'axis.size', sheet: 's0', axis: 'row', id: 'b1', px: 30 }]);
    await personEdits(h, { type: 'axis.size', sheet: 's0', axis: 'row', id: 'b1', px: 70 });
    expect(await undo(h, otro)).toEqual({ ok: false, error: precondition() });
  });
});
