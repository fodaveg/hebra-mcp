/**
 * B-M03 (R18 y R22): la escritura por lotes en tres fases. El almacén es el real (privacidad de
 * `document-privacy`), el registro de operaciones es el real sobre una SQLite en memoria y la
 * sesión es un doble que confirma el update y `inTx` en una transacción de esa misma SQLite: así
 * un corte entre el append y la respuesta se prueba de verdad, no con una bandera.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import type { PrivacyConfig } from '../../src/privacy/config';
import {
  runDocumentOps,
  type DocumentComputeJob,
  type DocumentComputeResult,
  type DocumentOpsStore,
  type DocumentOpsTurn,
  type DocumentUndoEntry
} from '../../src/store/document-ops';
import type { DocSessionLike, DocumentAsset } from '../../src/store/document-types';
import { UNDO_ENTRY_MAX_BYTES } from '../../src/store/document-limits';
import { ensureOperationsTable, sqliteOperationStore } from '../../src/store/operations';
import { StoreError } from '../../src/store/errors';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

type Op = { kind: 'set'; key: string; value: string; expect?: Record<string, unknown> };
const adapter = { format: 'ods' } as unknown as DocFormatAdapter<unknown, Op>;
const set = (key: string, value: string, expectValue?: string): Op => ({
  kind: 'set',
  key,
  value,
  ...(expectValue === undefined ? {} : { expect: { [key]: expectValue } })
});

/** El documento de los tests: celdas y revisión, más la SQLite donde se confirma todo. */
class FakeDocument {
  readonly db = new DatabaseSync(':memory:');
  cells: Record<string, string> = { A1: 'base', B1: 'otro' };
  revision = 1;
  opened = 0;
  closed = 0;
  applied: { seed: string; project: boolean | undefined }[] = [];
  /** Simula que se pierde la respuesta justo después de confirmar. */
  cutAfterCommit = false;
  /** Fuerza una inversa enorme. */
  hugeInverse = false;

  constructor() {
    ensureOperationsTable(this.db);
    this.db.exec('CREATE TABLE updates (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  }

  get updates(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM updates').get() as { n: number }).n;
  }

  /** Una edición de otra persona: cambia la celda y la revisión sin pasar por el lote. */
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
        this.applied.push({ seed: options.seed, project: options.project });
        const next = { ...this.cells };
        for (let index = 0; index < ops.length; index += 1) {
          const op = ops[index]!;
          for (const [key, wanted] of Object.entries(op.expect ?? {})) {
            // Como el adaptador real: `expect` contra el estado de AHORA.
            if (next[key] !== wanted) return { ok: false, code: 'precondition_failed', opIndex: index };
          }
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
                : [{ kind: 'set', key: 'A1', value: this.cells.A1 ?? '' }],
              revision: `r${revision}`
            });
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
          }
          this.cells = next;
          this.revision = revision;
          if (this.cutAfterCommit) throw new Error('corte antes de la respuesta');
        }
        return {
          ok: true,
          changed,
          revision: `r${revision}`,
          layoutRevision: `l${revision}`,
          inverse: []
        };
      }
    };
  }
}

interface Harness {
  port: NodeLibraryPort;
  document: FakeDocument;
  store: DocumentOpsStore;
  fileId: string;
  diario: string;
  undo: DocumentUndoEntry[];
  turns: number;
  computed: DocumentComputeJob[];
  /** Lo que hace el test mientras el cálculo está retenido. */
  duringCompute: (() => Promise<void>) | null;
  /** Hace fallar el turno número N (1 es el primero) con este error. */
  failTurn: { at: number; error: Error } | null;
  clock: number;
}

async function harness(options: { undo?: boolean } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-ops-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite') });
  ports.push(port);
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  const bytes = new TextEncoder().encode('hoja');
  const fileId = await port.writeExclusive(async (store) => {
    await store.blobPut(bytes, { mime: 'application/vnd.oasis.opendocument.spreadsheet', expectedSha256: sha('hoja') });
    return (await store.fileCreate(publica, 'hoja.ods', sha('hoja'))).id;
  });
  const document = new FakeDocument();
  const operations = sqliteOperationStore(document.db);
  const h: Harness = {
    port,
    document,
    fileId,
    diario,
    undo: [],
    turns: 0,
    computed: [],
    duringCompute: null,
    failTurn: null,
    clock: Date.UTC(2026, 10, 21),
    store: undefined as unknown as DocumentOpsStore
  };
  h.store = {
    now: () => h.clock,
    turn: (operation) => {
      h.turns += 1;
      const number = h.turns;
      return port.writeExclusive(async (store) => {
        if (h.failTurn?.at === number) throw h.failTurn.error;
        const turn: DocumentOpsTurn = {
          store,
          privacy: CONFIG,
          operations,
          ...(options.undo === false ? {} : { undo: { record: (entry) => void h.undo.push(entry) } }),
          openSession: async () => document.session() as DocSessionLike<never, never>
        };
        return operation(turn);
      });
    },
    compute: async (job): Promise<DocumentComputeResult> => {
      h.computed.push(job);
      // El cálculo dura: mientras tanto el mundo se mueve.
      await h.duringCompute?.();
      return { ok: true, revision: `r${document.revision}`, layoutRevision: `l${document.revision}`, report: { cells: 1 } };
    }
  };
  return h;
}

const input = (h: Harness, ops: Op[], extra: Record<string, unknown> = {}) => ({
  id: h.fileId,
  operationId: 'op-1',
  ops,
  ...extra
});

function operationState(h: Harness, operationId = 'op-1'): string | null {
  return sqliteOperationStore(h.document.db).lookup(operationId)?.state ?? null;
}

describe('runDocumentOps: tres fases', () => {
  it('aplica el lote: dos turnos, cálculo en medio, inversa guardada y registro hecho', async () => {
    const h = await harness();
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'nuevo')], { expectedRevision: 'r1' }), adapter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.out).toMatchObject({
      id: h.fileId,
      outcome: 'saved',
      revision: 'r2',
      layoutRevision: 'l2',
      previousRevision: 'r1',
      undoAvailable: true,
      sync: 'pending'
    });
    expect(result.out.undoUntil).toBe(new Date(h.clock + 7 * 24 * 3600 * 1000).toISOString());
    expect(result.report).toEqual({ cells: 1 });
    expect(h.turns).toBe(2);
    expect(h.computed).toHaveLength(1);
    expect(h.document.updates).toBe(1);
    expect(h.document.cells.C3).toBe('nuevo');
    expect(operationState(h)).toBe('done');
    expect(h.undo).toEqual([
      {
        operationId: 'op-1',
        documentId: h.fileId,
        inverse: [{ kind: 'set', key: 'A1', value: 'base' }],
        revision: 'r2',
        createdAt: h.clock
      }
    ]);
    // Sin proyectar dentro del turno y con el `operationId` como semilla.
    expect(h.document.applied).toEqual([{ seed: 'op-1', project: false }]);
    expect(h.document.closed).toBe(1);
  });

  it('dryRun valida sin escribir ni tocar el registro', async () => {
    const h = await harness();
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { dryRun: true, expectedRevision: 'r1' }), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'validated', revision: 'r1', layoutRevision: 'l1' } });
    expect(h.turns).toBe(1);
    expect(h.document.opened).toBe(0);
    expect(h.document.updates).toBe(0);
    expect(operationState(h)).toBeNull();
  });

  it('un reintento con el mismo operationId da already sin aplicar ni calcular otra vez', async () => {
    const h = await harness();
    const body = input(h, [set('C3', 'x')], { expectedRevision: 'r1' });
    await runDocumentOps(h.store, body, adapter);
    const again = await runDocumentOps(h.store, body, adapter);
    expect(again).toMatchObject({ ok: true, out: { outcome: 'already', replayed: true, revision: 'r2' } });
    expect(h.document.updates).toBe(1);
    expect(h.computed).toHaveLength(1);
  });

  it('el mismo operationId con otro lote es operation_id_reused y no escribe', async () => {
    const h = await harness();
    await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter);
    const other = await runDocumentOps(h.store, input(h, [set('C3', 'y')], { expectedRevision: 'r1' }), adapter);
    expect(other).toEqual({ ok: false, error: { code: 'operation_id_reused' } });
    expect(h.document.updates).toBe(1);
  });

  it('R18: un corte entre el append y la respuesta deja un solo alta al reintentar', async () => {
    const h = await harness();
    const body = input(h, [set('C3', 'x')], { expectedRevision: 'r1' });
    h.document.cutAfterCommit = true;
    await expect(runDocumentOps(h.store, body, adapter)).rejects.toThrow('corte antes de la respuesta');
    // El update y el registro se confirmaron juntos: no hay un lote aplicado y sin registrar.
    expect(h.document.updates).toBe(1);
    expect(operationState(h)).toBe('done');

    h.document.cutAfterCommit = false;
    const retry = await runDocumentOps(h.store, body, adapter);
    expect(retry).toMatchObject({ ok: true, out: { outcome: 'already', replayed: true } });
    expect(h.document.updates).toBe(1);
  });

  it('si el registro falla dentro de la transacción, el update se revierte y el reintento aplica una vez', async () => {
    const h = await harness();
    h.document.db.exec('DROP TABLE hebra_mcp_operations');
    const body = input(h, [set('C3', 'x')], { expectedRevision: 'r1' });
    await expect(runDocumentOps(h.store, body, adapter)).rejects.toThrow();
    expect(h.document.updates).toBe(0);
    ensureOperationsTable(h.document.db);
    await runDocumentOps(h.store, body, adapter);
    expect(h.document.updates).toBe(1);
  });

  it('un lote que no cambia nada queda registrado y no escribe', async () => {
    const h = await harness();
    const result = await runDocumentOps(h.store, input(h, [set('A1', 'base')], { expectedRevision: 'r1' }), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'already', revision: 'r1', previousRevision: 'r1' } });
    expect(h.document.updates).toBe(0);
    expect(operationState(h)).toBe('done');
  });

  it('una inversa que no cabe en 1 MiB se aplica pero no se puede deshacer', async () => {
    const h = await harness();
    h.document.hugeInverse = true;
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'saved', undoAvailable: false } });
    expect(h.undo).toEqual([]);
  });
});

describe('runDocumentOps: el segundo turno reevalúa', () => {
  it('expect se reevalúa en el segundo turno: otra persona cambió la celda durante el cálculo', async () => {
    const h = await harness();
    h.duringCompute = async () => h.document.editFromOutside('A1', 'de la persona');
    const result = await runDocumentOps(h.store, input(h, [set('A1', 'llm', 'base')]), adapter);
    expect(result).toEqual({
      ok: false,
      error: { code: 'precondition_failed', opIndex: 0, target: 'ops[0]' }
    });
    expect(h.document.cells.A1).toBe('de la persona');
    expect(h.document.updates).toBe(0);
  });

  it('una edición en otra celda durante el cálculo entra sin copia', async () => {
    const h = await harness();
    h.duringCompute = async () => h.document.editFromOutside('B1', 'de la persona');
    const result = await runDocumentOps(h.store, input(h, [set('A1', 'llm', 'base')]), adapter);
    expect(result.ok).toBe(true);
    expect(h.document.cells).toMatchObject({ A1: 'llm', B1: 'de la persona' });
    expect(h.document.updates).toBe(1);
  });

  it('expectedRevision se compara en el segundo turno, con la revisión de ahora', async () => {
    const h = await harness();
    h.duringCompute = async () => h.document.editFromOutside('B1', 'de la persona');
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter);
    expect(result).toEqual({
      ok: false,
      error: { code: 'precondition_failed', opIndex: 0, target: 'expectedRevision' }
    });
    expect(h.document.updates).toBe(0);
    expect(h.document.closed).toBe(1);
  });

  it('expectedLayout se compara en el segundo turno', async () => {
    const h = await harness();
    h.duringCompute = async () => h.document.editFromOutside('B1', 'de la persona');
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedLayout: 'l1' }), adapter);
    expect(result).toMatchObject({ ok: false, error: { code: 'precondition_failed', target: 'expectedLayout' } });
    expect(h.document.updates).toBe(0);
  });

  it('R22: el documento pasa a una carpeta privada durante el cálculo y no se escribe nada', async () => {
    const h = await harness();
    h.duringCompute = async () => {
      await h.port.writeExclusive(async (store) => {
        await store.fileMove(h.fileId, h.diario);
      });
    };
    await expect(
      runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter)
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(h.computed).toHaveLength(1);
    expect(h.document.opened).toBe(0);
    expect(h.document.updates).toBe(0);
    expect(h.undo).toEqual([]);
  });

  it('R22: se revoca el espacio durante el cálculo y no se escribe nada', async () => {
    const h = await harness();
    h.failTurn = { at: 2, error: new StoreError('space_access_denied') };
    await expect(
      runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter)
    ).rejects.toMatchObject({ code: 'space_access_denied' });
    expect(h.computed).toHaveLength(1);
    expect(h.document.opened).toBe(0);
    expect(h.document.updates).toBe(0);
  });
});

describe('runDocumentOps: primer turno y entrada', () => {
  it('un documento inexistente da not_found sin calcular ni registrar', async () => {
    const h = await harness();
    await expect(
      runDocumentOps(h.store, { ...input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), id: 'no-existe' }, adapter)
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(h.computed).toEqual([]);
    expect(operationState(h)).toBeNull();
  });

  it('una imagen oculta del lote da not_found sin calcular', async () => {
    const h = await harness();
    const hidden = await h.port.writeExclusive(async (store) => {
      await store.blobPut(new TextEncoder().encode('png'), { mime: 'image/png', expectedSha256: sha('png') });
      return (await store.fileCreate(h.diario, 'oculta.png', sha('png'))).id;
    });
    const assets: DocumentAsset[] = [{ ref: 'a', fileId: hidden }];
    await expect(
      runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1', assets }), adapter)
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(h.computed).toEqual([]);
  });

  it('la regla de direcciones: sin expect ni revisión es batch_invalid y no abre ningún turno', async () => {
    const h = await harness();
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')]), adapter, { isAddressed: () => true });
    expect(result).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    expect(h.turns).toBe(0);
  });

  it('un lote sin operaciones o sin operationId es batch_invalid', async () => {
    const h = await harness();
    expect(await runDocumentOps(h.store, input(h, []), adapter)).toMatchObject({
      ok: false,
      error: { code: 'batch_invalid' }
    });
    expect(
      await runDocumentOps(h.store, { ...input(h, [set('C3', 'x')]), operationId: '' }, adapter)
    ).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    expect(h.turns).toBe(0);
  });

  it('el cálculo puede rechazar el lote: el error sale tal cual y no se abre la sesión', async () => {
    const h = await harness();
    h.store.compute = async () => ({
      ok: false,
      error: { code: 'batch_invalid', issues: [{ opIndex: 0, path: 'ops[0]', reason: 'fuera de rango' }] }
    });
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter);
    expect(result).toMatchObject({ ok: false, error: { code: 'batch_invalid' } });
    expect(h.document.opened).toBe(0);
    expect(h.turns).toBe(1);
  });

  it('la ronda de sync informa del estado sin cambiar el resultado', async () => {
    const h = await harness();
    h.store.afterCommit = async () => ({ sync: 'error', syncError: 'offline' });
    const result = await runDocumentOps(h.store, input(h, [set('C3', 'x')], { expectedRevision: 'r1' }), adapter);
    expect(result).toMatchObject({ ok: true, out: { outcome: 'saved', sync: 'error', syncError: 'offline' } });
  });
});
