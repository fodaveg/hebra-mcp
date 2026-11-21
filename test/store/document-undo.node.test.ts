/**
 * B-M04: deshacer un lote con su inversa. El almacén es el real (privacidad de
 * `document-privacy`), el registro de operaciones y el de deshacer son los reales sobre una SQLite
 * en memoria y la sesión es un doble que confirma el update, la inversa y el registro en una
 * transacción de esa misma SQLite. Los lotes se aplican con `runDocumentOps` para que la inversa
 * guardada sea la que de verdad deja B-M03.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import type { PrivacyConfig } from '../../src/privacy/config';
import { runDocumentOps, type DocumentOpsStore, type DocumentOpsTurn } from '../../src/store/document-ops';
import {
  ensureDocumentUndoTable,
  sqliteDocumentUndoStore,
  undoDocumentOps,
  type DocumentUndoInput,
  type DocumentUndoOpsStore,
  type DocumentUndoStore,
  type DocumentUndoTurn
} from '../../src/store/document-undo';
import { UNDO_ENTRY_MAX_BYTES, UNDO_MAX_AGE_DAYS, UNDO_MAX_ENTRIES } from '../../src/store/document-limits';
import type { DocSessionLike } from '../../src/store/document-types';
import { ensureOperationsTable, sqliteOperationStore } from '../../src/store/operations';
import { StoreError } from '../../src/store/errors';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const DAY_MS = 24 * 60 * 60 * 1000;
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * La inversa lleva un `expect` sobre lo que escribió el lote (como `prepareUndo` del adaptador
 * real). Prueba negativa del paquete: ponerlo a `false` y ver caer el test de «un cambio posterior».
 */
const INVERSE_WITH_EXPECT = true;

type Op = { kind: 'set'; key: string; value: string; expect?: Record<string, unknown> };
const adapter = { format: 'ods' } as unknown as DocFormatAdapter<unknown, Op>;
const set = (key: string, value: string): Op => ({ kind: 'set', key, value });

/** El documento de los tests: celdas y revisión, más la SQLite donde se confirma todo. */
class FakeDocument {
  readonly db = new DatabaseSync(':memory:');
  cells: Record<string, string> = { A1: 'base', B1: 'otro' };
  revision = 1;
  opened = 0;
  closed = 0;
  hugeInverse = false;

  constructor() {
    ensureOperationsTable(this.db);
    ensureDocumentUndoTable(this.db);
    this.db.exec('CREATE TABLE updates (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  }

  get updates(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM updates').get() as { n: number }).n;
  }

  /** Una edición de otra persona: cambia la celda y la revisión sin pasar por un lote. */
  editFromOutside(key: string, value: string): void {
    this.cells = { ...this.cells, [key]: value };
    this.revision += 1;
  }

  session(): DocSessionLike<unknown, Op> {
    this.opened += 1;
    return {
      revision: () => `r${this.revision}`,
      layoutRevision: () => `l${this.revision}`,
      flush: async () => undefined,
      close: async () => void (this.closed += 1),
      apply: async (ops, _origin, options) => {
        const next = { ...this.cells };
        const inverse: Op[] = [];
        for (let index = 0; index < ops.length; index += 1) {
          const op = ops[index]!;
          for (const [key, wanted] of Object.entries(op.expect ?? {})) {
            // Como el adaptador real: `expect` contra el estado de AHORA.
            if (next[key] !== wanted) return { ok: false, code: 'precondition_failed', opIndex: index };
          }
          inverse.unshift({
            kind: 'set',
            key: op.key,
            value: next[op.key] ?? '',
            ...(INVERSE_WITH_EXPECT ? { expect: { [op.key]: op.value } } : {})
          });
          next[op.key] = op.value;
        }
        const changed = JSON.stringify(next) !== JSON.stringify(this.cells);
        const revision = changed ? this.revision + 1 : this.revision;
        if (changed) {
          this.db.exec('BEGIN');
          try {
            this.db.prepare('INSERT INTO updates (body) VALUES (?)').run(JSON.stringify(ops));
            options.inTx?.({
              update: new Uint8Array(1),
              inverse: this.hugeInverse
                ? [{ kind: 'set', key: 'x', value: 'y'.repeat(UNDO_ENTRY_MAX_BYTES) }]
                : inverse,
              revision: `r${revision}`
            });
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
          }
          this.cells = next;
          this.revision = revision;
        }
        return { ok: true, changed, revision: `r${revision}`, layoutRevision: `l${revision}`, inverse };
      }
    };
  }
}

interface Harness {
  port: NodeLibraryPort;
  document: FakeDocument;
  /** El registro de deshacer, el mismo que usan el lote y el deshacer. */
  undoStore: DocumentUndoStore;
  ops: DocumentOpsStore;
  undo: DocumentUndoOpsStore;
  fileId: string;
  diario: string;
  turns: number;
  /** Hace fallar el turno número N (1 es el primero) con este error. */
  failTurn: { at: number; error: Error } | null;
  clock: number;
}

async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-undo-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite') });
  ports.push(port);
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  const fileId = await port.writeExclusive(async (store) => {
    await store.blobPut(new TextEncoder().encode('hoja'), {
      mime: 'application/vnd.oasis.opendocument.spreadsheet',
      expectedSha256: sha('hoja')
    });
    return (await store.fileCreate(publica, 'hoja.ods', sha('hoja'))).id;
  });
  const document = new FakeDocument();
  const operations = sqliteOperationStore(document.db);
  const undoStore = sqliteDocumentUndoStore(document.db);
  const h: Harness = {
    port,
    document,
    undoStore,
    fileId,
    diario,
    turns: 0,
    failTurn: null,
    clock: Date.UTC(2026, 10, 21),
    ops: undefined as unknown as DocumentOpsStore,
    undo: undefined as unknown as DocumentUndoOpsStore
  };
  const open = <T>(operation: (turn: DocumentUndoTurn) => Promise<T>): Promise<T> => {
    h.turns += 1;
    const number = h.turns;
    return port.writeExclusive(async (store) => {
      if (h.failTurn?.at === number) throw h.failTurn.error;
      return operation({
        store,
        privacy: CONFIG,
        operations,
        undo: undoStore,
        openSession: async () => document.session() as DocSessionLike<never, never>
      });
    });
  };
  h.ops = {
    now: () => h.clock,
    turn: (operation) => open((turn) => operation(turn as DocumentOpsTurn)),
    compute: async () => ({ ok: true, revision: `r${document.revision}`, layoutRevision: `l${document.revision}` })
  };
  h.undo = { now: () => h.clock, turn: open };
  return h;
}

/** Aplica un lote con `runDocumentOps`, que deja su inversa en el registro. */
async function apply(h: Harness, operationId: string, ops: Op[]): Promise<void> {
  const result = await runDocumentOps(h.ops, { id: h.fileId, operationId, ops }, adapter);
  expect(result.ok).toBe(true);
}

const undoInput = (h: Harness, operationId: string, undoOperationId: string, extra: Record<string, unknown> = {}) =>
  ({ id: h.fileId, operationId, undoOperationId, ...extra }) as DocumentUndoInput;

function operationState(h: Harness, operationId: string): string | null {
  return sqliteOperationStore(h.document.db).lookup(operationId)?.state ?? null;
}

describe('undoDocumentOps: exacto', () => {
  it('deshace el lote entero y deja el documento como estaba', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'nuevo'), set('C3', 'otra'), set('A1', 'final')]);
    expect(h.document.cells).toEqual({ A1: 'final', B1: 'otro', C3: 'otra' });
    const updatesBefore = h.document.updates;

    const result = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);

    expect(result).toMatchObject({
      ok: true,
      out: { id: h.fileId, outcome: 'saved', previousRevision: 'r2', revision: 'r3', sync: 'pending', undoAvailable: false }
    });
    // A1 vuelve a su valor original; C3 no existía y queda con el valor que le puso la inversa.
    expect(h.document.cells).toMatchObject({ A1: 'base', B1: 'otro', C3: '' });
    expect(h.document.updates).toBe(updatesBefore + 1);
    expect(operationState(h, 'des-1')).toBe('done');
    // Un lote se deshace una vez: la entrada se consumió en la misma transacción.
    expect(h.undoStore.lookup('lote-1', h.clock)).toBeNull();
    expect(h.document.closed).toBe(2);
  });

  it('dos lotes seguidos se deshacen de el más nuevo al más antiguo, aunque la revisión haya cambiado', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    await apply(h, 'lote-2', [set('B1', 'dos')]);
    expect((await undoDocumentOps(h.undo, undoInput(h, 'des-2', 'lote-2'), adapter)).ok).toBe(true);
    expect((await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter)).ok).toBe(true);
    expect(h.document.cells).toEqual({ A1: 'base', B1: 'otro' });
  });

  it('un cambio posterior en lo que escribió el lote da precondition_failed y no escribe', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'del lote')]);
    h.document.editFromOutside('A1', 'de la persona');
    const updatesBefore = h.document.updates;

    const result = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);

    expect(result).toEqual({
      ok: false,
      error: { code: 'precondition_failed', opIndex: 0, target: 'inverse[0]' }
    });
    expect(h.document.cells.A1).toBe('de la persona');
    expect(h.document.updates).toBe(updatesBefore);
    // La entrada sigue ahí: la persona puede revisar y volver a intentarlo.
    expect(h.undoStore.lookup('lote-1', h.clock)).not.toBeNull();
    expect(h.document.closed).toBe(2);
  });

  it('un cambio en otra celda no impide deshacer', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'del lote')]);
    h.document.editFromOutside('B1', 'de la persona');
    expect((await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter)).ok).toBe(true);
    expect(h.document.cells).toMatchObject({ A1: 'base', B1: 'de la persona' });
  });

  it('expectedRevision y expectedLayout se comparan con lo de ahora', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'del lote')]);
    expect(await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1', { expectedRevision: 'r1' }), adapter)).toEqual({
      ok: false,
      error: { code: 'precondition_failed', opIndex: 0, target: 'expectedRevision' }
    });
    expect(await undoDocumentOps(h.undo, undoInput(h, 'des-2', 'lote-1', { expectedLayout: 'l1' }), adapter)).toMatchObject({
      ok: false,
      error: { code: 'precondition_failed', target: 'expectedLayout' }
    });
    expect(h.document.cells.A1).toBe('del lote');
    const ok = await undoDocumentOps(
      h.undo,
      undoInput(h, 'des-3', 'lote-1', { expectedRevision: 'r2', expectedLayout: 'l2' }),
      adapter
    );
    expect(ok.ok).toBe(true);
  });
});

describe('undoDocumentOps: idempotencia y registro', () => {
  it('un reintento con el mismo operationId da already sin aplicar otra vez', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'del lote')]);
    const body = undoInput(h, 'des-1', 'lote-1');
    await undoDocumentOps(h.undo, body, adapter);
    const updates = h.document.updates;
    const again = await undoDocumentOps(h.undo, body, adapter);
    expect(again).toMatchObject({ ok: true, out: { outcome: 'already', replayed: true } });
    expect(h.document.updates).toBe(updates);
  });

  it('el mismo operationId para deshacer otro lote es operation_id_reused', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    await apply(h, 'lote-2', [set('B1', 'dos')]);
    await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-2'), adapter);
    const updates = h.document.updates;
    const other = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);
    expect(other).toEqual({ ok: false, error: { code: 'operation_id_reused' } });
    expect(h.document.updates).toBe(updates);
  });

  it('un lote ya deshecho no se deshace dos veces con otro operationId', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);
    const updates = h.document.updates;
    const second = await undoDocumentOps(h.undo, undoInput(h, 'des-2', 'lote-1'), adapter);
    expect(second).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(h.document.updates).toBe(updates);
  });

  it('un corte tras confirmar deja el deshacer registrado: el reintento no lo repite', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    const body = undoInput(h, 'des-1', 'lote-1');
    const session = h.document.session.bind(h.document);
    h.document.session = () => {
      const real = session();
      return {
        ...real,
        apply: async (...args) => {
          await real.apply(...args);
          throw new Error('corte antes de la respuesta');
        }
      };
    };
    await expect(undoDocumentOps(h.undo, body, adapter)).rejects.toThrow('corte antes de la respuesta');
    expect(operationState(h, 'des-1')).toBe('done');
    h.document.session = session;
    const retry = await undoDocumentOps(h.undo, body, adapter);
    expect(retry).toMatchObject({ ok: true, out: { outcome: 'already', replayed: true } });
    expect(h.document.cells.A1).toBe('base');
  });

  it('una inversa que no cambia nada responde already, no escribe y no pide ronda', async () => {
    const h = await harness();
    h.undoStore.record({
      operationId: 'lote-1',
      documentId: h.fileId,
      inverse: [set('A1', 'base')],
      revision: 'r1',
      createdAt: h.clock
    });
    const updates = h.document.updates;
    let rounds = 0;
    h.undo.afterCommit = async () => {
      rounds += 1;
      return { sync: 'uploaded' };
    };
    const result = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'already', undoAvailable: false } });
    expect(h.document.updates).toBe(updates);
    expect(rounds).toBe(0);
  });

  it('la ronda de sync informa del estado sin cambiar el resultado', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    h.undo.afterCommit = async () => ({ sync: 'error', syncError: 'offline' });
    const result = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'saved', sync: 'error', syncError: 'offline' } });
  });
});

describe('undoDocumentOps: privacidad, espacio y entrada', () => {
  it('un documento movido a una carpeta privada da not_found sin escribir ni abrir la sesión', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    await h.port.writeExclusive(async (store) => {
      await store.fileMove(h.fileId, h.diario);
    });
    const opened = h.document.opened;
    const updates = h.document.updates;
    await expect(undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter)).rejects.toMatchObject({
      code: 'not_found'
    });
    expect(h.document.opened).toBe(opened);
    expect(h.document.updates).toBe(updates);
    expect(operationState(h, 'des-1')).toBeNull();
    expect(h.undoStore.lookup('lote-1', h.clock)).not.toBeNull();
  });

  it('un espacio revocado se rechaza sin escribir', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    h.failTurn = { at: h.turns + 1, error: new StoreError('space_access_denied') };
    await expect(undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter)).rejects.toMatchObject({
      code: 'space_access_denied'
    });
    expect(h.document.cells.A1).toBe('uno');
  });

  it('un documento inexistente da not_found', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    await expect(
      undoDocumentOps(h.undo, { ...undoInput(h, 'des-1', 'lote-1'), id: 'no-existe' }, adapter)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('un lote de otro documento o que no existe da not_found y no registra nada', async () => {
    const h = await harness();
    h.undoStore.record({ operationId: 'ajeno', documentId: 'otro-doc', inverse: [set('A1', 'x')], revision: 'r9', createdAt: h.clock });
    expect(await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'ajeno'), adapter)).toEqual({
      ok: false,
      error: { code: 'not_found' }
    });
    expect(await undoDocumentOps(h.undo, undoInput(h, 'des-2', 'nunca-existio'), adapter)).toEqual({
      ok: false,
      error: { code: 'not_found' }
    });
    expect(operationState(h, 'des-1')).toBeNull();
    expect(h.document.opened).toBe(0);
  });

  it('ids vacios, dryRun o el mismo id del lote son batch_invalid sin abrir turno', async () => {
    const h = await harness();
    for (const bad of [
      undoInput(h, '', 'lote-1'),
      undoInput(h, 'des-1', ''),
      undoInput(h, 'lote-1', 'lote-1'),
      undoInput(h, 'des-1', 'lote-1', { dryRun: true }),
      { ...undoInput(h, 'des-1', 'lote-1'), id: '' }
    ]) {
      expect(await undoDocumentOps(h.undo, bad, adapter)).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    }
    expect(h.turns).toBe(0);
  });
});

describe('registro de deshacer: topes', () => {
  it('caduca a los 7 días: el último instante vale y un milisegundo más no', async () => {
    const h = await harness();
    await apply(h, 'lote-1', [set('A1', 'uno')]);
    const created = h.clock;
    expect(h.undoStore.lookup('lote-1', created + UNDO_MAX_AGE_DAYS * DAY_MS)).not.toBeNull();
    expect(h.undoStore.lookup('lote-1', created + UNDO_MAX_AGE_DAYS * DAY_MS + 1)).toBeNull();

    h.clock = created + UNDO_MAX_AGE_DAYS * DAY_MS + 1;
    const result = await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter);
    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(h.document.cells.A1).toBe('uno');
    // Y el turno purga lo caducado.
    const rows = h.document.db.prepare('SELECT COUNT(*) AS n FROM hebra_mcp_document_undo').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('la entrada 201 echa a la más antigua y se queda con 200', async () => {
    const h = await harness();
    for (let index = 0; index <= UNDO_MAX_ENTRIES; index += 1) {
      h.undoStore.record({
        operationId: `lote-${index}`,
        documentId: h.fileId,
        inverse: [set('A1', String(index))],
        revision: `r${index}`,
        createdAt: h.clock + index
      });
    }
    const now = h.clock + UNDO_MAX_ENTRIES;
    const rows = h.document.db.prepare('SELECT COUNT(*) AS n FROM hebra_mcp_document_undo').get() as { n: number };
    expect(rows.n).toBe(UNDO_MAX_ENTRIES);
    expect(h.undoStore.lookup('lote-0', now)).toBeNull();
    expect(h.undoStore.lookup('lote-1', now)).not.toBeNull();
    expect(h.undoStore.lookup(`lote-${UNDO_MAX_ENTRIES}`, now)).not.toBeNull();
  });

  it('una inversa de más de 1 MiB no se guarda: el lote responde undoAvailable false y deshacer da not_found', async () => {
    const h = await harness();
    h.document.hugeInverse = true;
    const result = await runDocumentOps(h.ops, { id: h.fileId, operationId: 'lote-1', ops: [set('A1', 'uno')] }, adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'saved', undoAvailable: false } });
    expect(h.undoStore.lookup('lote-1', h.clock)).toBeNull();
    expect(await undoDocumentOps(h.undo, undoInput(h, 'des-1', 'lote-1'), adapter)).toEqual({
      ok: false,
      error: { code: 'not_found' }
    });
  });

  it('el propio registro rechaza una inversa por encima del tope, y la que cabe justo se guarda', async () => {
    const h = await harness();
    const pad = (bytes: number): unknown[] => ['x'.repeat(bytes - JSON.stringify(['']).length)];
    h.undoStore.record({ operationId: 'justo', documentId: h.fileId, inverse: pad(UNDO_ENTRY_MAX_BYTES), revision: 'r1', createdAt: h.clock });
    h.undoStore.record({ operationId: 'pasado', documentId: h.fileId, inverse: pad(UNDO_ENTRY_MAX_BYTES + 1), revision: 'r1', createdAt: h.clock });
    expect(h.undoStore.lookup('justo', h.clock)).not.toBeNull();
    expect(h.undoStore.lookup('pasado', h.clock)).toBeNull();
  });
});

describe('registro de deshacer: pasos del formato (B-M04b)', () => {
  const steps = [{ op: { type: 'cell.set', value: 1 }, expect: [{ map: 'cells', key: 's0/b0:b0', values: ['2'] }] }];

  it('guarda y devuelve los pasos tal cual; una entrada sin pasos no los lleva', () => {
    const db = new DatabaseSync(':memory:');
    ensureDocumentUndoTable(db);
    const store = sqliteDocumentUndoStore(db);
    store.record({ operationId: 'con', documentId: 'd', inverse: [{ a: 1 }], steps, revision: 'r', createdAt: 1000 });
    store.record({ operationId: 'sin', documentId: 'd', inverse: [{ a: 1 }], revision: 'r', createdAt: 1000 });
    expect(store.lookup('con', 1000)?.steps).toEqual(steps);
    expect(store.lookup('sin', 1000)).not.toHaveProperty('steps');
  });

  it('los pasos cuentan para el tope de bytes de la entrada', () => {
    const db = new DatabaseSync(':memory:');
    ensureDocumentUndoTable(db);
    const store = sqliteDocumentUndoStore(db, { maxEntries: 10, maxEntryBytes: 100 });
    store.record({ operationId: 'grande', documentId: 'd', inverse: [], steps: ['x'.repeat(200)], revision: 'r', createdAt: 1000 });
    expect(store.lookup('grande', 1000)).toBeNull();
  });

  it('una tabla de antes de B-M04b (sin columna steps) se actualiza y conserva sus entradas', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE hebra_mcp_document_undo (
      operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision TEXT NOT NULL,
      inverse TEXT NOT NULL, inverse_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    db.prepare('INSERT INTO hebra_mcp_document_undo VALUES (?, ?, ?, ?, ?, ?)').run('vieja', 'd', 'r', '[{"a":1}]', 9, 1000);
    ensureDocumentUndoTable(db);
    ensureDocumentUndoTable(db);
    const store = sqliteDocumentUndoStore(db);
    expect(store.lookup('vieja', 1000)).toMatchObject({ inverse: [{ a: 1 }] });
    store.record({ operationId: 'nueva', documentId: 'd', inverse: [], steps, revision: 'r', createdAt: 1000 });
    expect(store.lookup('nueva', 1000)?.steps).toEqual(steps);
  });
});
