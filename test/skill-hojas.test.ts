/**
 * La referencia de hojas de cálculo de la skill (`skills/hebra/references/hojas-de-calculo.md`,
 * H-180) contra el código real. Determinista: lee el fichero y lo compara, sin red ni servidor.
 *
 * Cada bloque ```json <herramienta> [motivo] del fichero es una llamada de ejemplo:
 * - `hebra_read_sheet` y `hebra_render_sheet`: entran por el esquema de entrada de la herramienta.
 * - `hebra_create_sheet`: entra por su esquema y el libro se construye de verdad (`buildSheetFile`).
 * - `hebra_edit_sheet`: entra por su esquema, `parseSheetCommands` y `compileBatch` sobre el libro
 *   que escribió el primer ejemplo de creación. `expectedLayout` y `expectedRevision` de ejemplo se
 *   sustituyen por los reales del libro.
 * - Con un motivo (`batch_invalid` o `precondition_failed`), el ejemplo enseña un rechazo y el test
 *   comprueba que `compileBatch` lo rechaza con ESE motivo.
 * - Con comandos de los bloques opcionales (H-171): entra por `parseSheetEditCommands` y se compila
 *   tramo a tramo con la función de su bloque (`compileExample`), salvo `clearSpillBlockers`, que
 *   depende de un desborde bloqueado (lo prueba `test/tools/edit-sheet.node.test.ts`).
 *
 * Pruebas negativas hechas a mano al escribir lo de H-171 (se rompe, el test cae, se restaura): un
 * `kind` de gráfico que no existe en un ejemplo; quitar la fila de `moveSeries` del texto; una tabla
 * dinámica que pone en filas un campo que el origen no tiene (`Categoria`). Y el
 * test cazó un ejemplo de verdad roto: `setTableTotals` sobre una tabla con el total debajo.
 *
 * Además, que el texto nombre cada herramienta, cada comando del contrato y los topes vigentes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { z } from 'zod';
import { buildSheetFile, createSheetInputShape } from '../src/server/tools/create-sheet';
import { editSheetInputShape, segmentsOf } from '../src/server/tools/edit-sheet';
import { readSheetInputShape } from '../src/server/tools/read-sheet';
import { parseRenderRange, renderRangeTooLarge, renderSheetInputShape } from '../src/server/tools/render-sheet';
import {
  OPT_COMMAND_TYPES,
  parseSheetCommands,
  parseSheetEditCommands,
  SHEET_COMMAND_TYPES,
  type SheetEditCommand
} from '../src/server/tools/sheet-op-schemas';
import {
  baseObjectsOf,
  compileChartRun,
  compileImageRun,
  compilePivotRun,
  compileTableAt,
  type Indexed,
  type OptCompileState
} from '../src/server/tools/sheet-opt';
import { applyPivotSheetOp, type PivotSheetOp } from '../vendor/hebra/src/lib/sheets/opt/piv/concur';
import type { PivotCommand } from '../vendor/hebra/src/lib/sheets/opt/piv/llm-write';
import {
  compileBatch,
  createSheetAdapter,
  OP_TABLE,
  prepareSheetBase,
  type SheetCommand,
  type SheetModel,
  type SheetOp
} from '../src/sheets';
import { SHEET_ODS_INVENTORY_LIMITS, SHEET_ODS_READ_LIMITS } from '../src/store/sheet-limits';
import { hashToAnchorArray } from '../vendor/hebra/src/lib/sheets/opt/arr/hash';
import type { ChartCommand } from '../vendor/hebra/src/lib/sheets/opt/cht/llm-write';
import type { ImageCommand } from '../vendor/hebra/src/lib/sheets/opt/img/llm';
import { MAX_IMAGE_ALT_CHARS, MAX_IMAGE_SIDE_PX } from '../vendor/hebra/src/lib/sheets/opt/img/ops';
import type { TableCommand } from '../vendor/hebra/src/lib/sheets/opt/tab/llm';
import { applyTableOp, MAX_TABLE_NAME, type TableOp } from '../vendor/hebra/src/lib/sheets/opt/tab/model';
import {
  ASSETS_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_READ_TIMEOUT_MS,
  DOCUMENT_EDIT_TIMEOUT_MS,
  DOCUMENT_RESPONSE_MAX_CHARS,
  EDIT_OPS_MAX,
  EDIT_OPS_MAX_BYTES,
  READ_SHEET_DEFAULT_CELLS,
  READ_SHEET_MAX_CELLS,
  RENDER_SHEET_MAX_COLUMNS,
  RENDER_SHEET_MAX_ROWS,
  RENDER_WIDTH_DEFAULT_PX,
  RENDER_WIDTH_MAX_PX,
  RENDER_WIDTH_MIN_PX,
  UNDO_MAX_AGE_DAYS,
  UNDO_MAX_ENTRIES
} from '../src/store/document-limits';
import { SHEET_TOOL_NAMES } from '../src/server/tools/document-tool-table';
import { CREATE_SHEET_COMPILED_OPS_MAX } from '../src/server/tools/create-sheet';
import { SHEET_CELL_TEXT_MAX } from '../src/server/tools/sheet-op-schemas';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE = join(ROOT, 'skills', 'hebra', 'references', 'hojas-de-calculo.md');
const SKILL_MD = join(ROOT, 'skills', 'hebra', 'SKILL.md');
const TEXT = readFileSync(REFERENCE, 'utf8');

interface Example {
  tool: string;
  reason: string | null;
  input: Record<string, unknown>;
  line: number;
}

/** Los bloques ```json <herramienta> [motivo] del fichero, ya parseados. */
function examples(text: string): Example[] {
  const found: Example[] = [];
  for (const match of text.matchAll(/^```json (hebra_[a-z_]+)(?: ([a-z_]+))?\n([\s\S]*?)^```$/gm)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.push({ tool: match[1] as string, reason: match[2] ?? null, input: JSON.parse(match[3] as string), line });
  }
  return found;
}

const EXAMPLES = examples(TEXT);
const CREATE = EXAMPLES.filter((example) => example.tool === 'hebra_create_sheet');
const EDIT = EXAMPLES.filter((example) => example.tool === 'hebra_edit_sheet');

/** El libro del primer ejemplo de creación, leído como lo lee el editor. */
async function bookOf(example: Example): Promise<SheetModel> {
  const parsed = parseSheetCommands(example.input.ops);
  if (!parsed.ok) throw new Error(`el ejemplo de la línea ${example.line} no pasa parseSheetCommands`);
  const built = await buildSheetFile(parsed.ops, AbortSignal.timeout(20_000));
  if ('code' in built) throw new Error(`el ejemplo de la línea ${example.line} no se construye: ${built.code}`);
  return (await prepareSheetBase(built.bytes)).model;
}

/** El lote de un ejemplo de edición, con las garantías de ejemplo cambiadas por las reales. */
function batchOf(example: Example, model: SheetModel) {
  const { ops, expectedRevision, expectedLayout } = example.input as {
    ops: SheetCommand[];
    expectedRevision?: string;
    expectedLayout?: string;
  };
  return {
    ops,
    ...(expectedRevision !== undefined ? { expectedRevision: 'revision-real' } : {}),
    ...(expectedLayout !== undefined ? { expectedLayout: model.layoutRevision } : {})
  };
}

/** Si el ejemplo lleva algún comando de un bloque opcional (imágenes, tablas, gráficos, matrices). */
function hasOptCommands(example: Example): boolean {
  const ops = example.input.ops;
  return Array.isArray(ops) && ops.some((op: { type?: unknown }) => (OPT_COMMAND_TYPES as readonly unknown[]).includes(op.type));
}

/** Los bytes del libro del primer ejemplo de creación. */
async function bookBytesOf(example: Example): Promise<Uint8Array> {
  const parsed = parseSheetCommands(example.input.ops);
  if (!parsed.ok) throw new Error(`el ejemplo de la línea ${example.line} no pasa parseSheetCommands`);
  const built = await buildSheetFile(parsed.ops, AbortSignal.timeout(20_000));
  if ('code' in built) throw new Error(`el ejemplo de la línea ${example.line} no se construye: ${built.code}`);
  return built.bytes;
}

/** Un `setCells` con cada `A1#` de sus fórmulas en `_xlfn.ANCHORARRAY`, como antes de `compileBatch`. */
function withAnchorArrays(command: SheetCommand): SheetCommand {
  if (command.type !== 'setCells') return command;
  const rows = command.rows.map((row) =>
    row.map((value) => (typeof value === 'string' && value.startsWith('=') && value.includes('#') ? hashToAnchorArray(value).text : value))
  );
  return { ...command, rows };
}

const PNG_1X1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64')
);

/**
 * Compila un lote con comandos de los bloques sobre `bytes`, tramo a tramo como
 * `hebra_edit_sheet` (`segmentsOf`), con la función de cada bloque. Entre tramos aplica lo
 * compilado a la copia: las operaciones `table.*` con `applyTableOp` y las `pivot.edit` con
 * `applyPivotSheetOp`, las de sus bloques (lo que hará la app con H-170), y las demás con el
 * adaptador. Cada imagen del lote es un PNG de 1 x 1. Sin motor: un origen de tabla dinámica en
 * una hoja con fórmulas no se lee (por eso el ejemplo usa `Movimientos`, sin fórmulas).
 */
async function compileExample(bytes: Uint8Array, commands: readonly SheetEditCommand[]): Promise<{ ok: true } | { ok: false; at: number; error: unknown }> {
  const sheetBase = await prepareSheetBase(bytes, SHEET_ODS_READ_LIMITS);
  const adapter = createSheetAdapter(sheetBase, { limits: SHEET_ODS_INVENTORY_LIMITS });
  const doc = new Y.Doc();
  adapter.scaffold(bytes, doc);
  let model = await adapter.project(bytes, doc, AbortSignal.timeout(20_000));
  let n = 0;
  const context = { newId: () => `skill-${++n}` };
  for (const [k, segment] of segmentsOf(commands).entries()) {
    const state: OptCompileState = { model, doc, bytes, sheetBase, seed: `skill-${k}`, engine: async () => null };
    let ops: readonly { type: string }[];
    if (segment.kind === 'base') {
      const out = compileBatch(model, { ops: segment.items.map((item) => withAnchorArrays(item.command as SheetCommand)), expectedRevision: 'x' });
      if ('error' in out) return { ok: false, at: segment.items[0]!.index, error: out };
      ops = out.ops;
    } else {
      const out =
        segment.kind === 'tab'
          ? await compileTableAt(segment.items[0] as Indexed<TableCommand>, state)
          : segment.kind === 'cht'
            ? compileChartRun(segment.items as Indexed<ChartCommand>[], state, await baseObjectsOf(sheetBase))
            : segment.kind === 'piv'
              ? await compilePivotRun(segment.items as Indexed<PivotCommand>[], state, await baseObjectsOf(sheetBase))
              : await compileImageRun(segment.items as Indexed<ImageCommand>[], state, async () => ({ status: 'ok', bytes: PNG_1X1 }));
      if (!out.ok) return { ok: false, at: segment.items[0]!.index, error: out.error };
      ops = out.ops;
    }
    for (const op of ops) {
      if (op.type.startsWith('table.')) applyTableOp(doc, op as TableOp, context);
      else if (op.type === 'pivot.edit') applyPivotSheetOp(doc, op as PivotSheetOp, context, (await baseObjectsOf(sheetBase)).pivots);
      else if (Object.hasOwn(OP_TABLE, op.type)) adapter.applyOp(doc, op as SheetOp, context);
    }
    model = await adapter.project(bytes, doc, AbortSignal.timeout(20_000));
  }
  return { ok: true };
}

/** Quita los separadores de miles (`30.000`, `1 000`) para buscar una cifra. */
const plain = (text: string): string => text.replace(/(?<=\d)[. ](?=\d{3}\b)/g, '');

describe('referencia de hojas de cálculo de la skill (H-180)', () => {
  it('hay ejemplos de cada herramienta de hojas y de los tres rechazos', () => {
    const tools = new Set(EXAMPLES.map((example) => example.tool));
    expect([...tools].sort()).toEqual([...SHEET_TOOL_NAMES].sort());
    expect(EXAMPLES.filter((example) => example.reason === 'batch_invalid')).not.toHaveLength(0);
    expect(EXAMPLES.filter((example) => example.reason === 'precondition_failed')).not.toHaveLength(0);
    expect(EDIT.some((example) => 'undoOperationId' in example.input)).toBe(true);
    expect(EDIT.some((example) => example.input.dryRun === true)).toBe(true);
  });

  it('cada ejemplo de lectura y de pintado pasa el esquema de su herramienta', () => {
    for (const example of EXAMPLES.filter((item) => item.tool === 'hebra_read_sheet')) {
      expect(z.strictObject(readSheetInputShape).safeParse(example.input).success, `línea ${example.line}`).toBe(true);
    }
    for (const example of EXAMPLES.filter((item) => item.tool === 'hebra_render_sheet')) {
      expect(z.strictObject(renderSheetInputShape).safeParse(example.input).success, `línea ${example.line}`).toBe(true);
      const range = parseRenderRange(String(example.input.range));
      expect(range, `línea ${example.line}`).not.toBeNull();
      expect(renderRangeTooLarge(range!), `línea ${example.line}`).toBe(false);
    }
  });

  it('cada ejemplo de creación pasa su esquema y construye el libro', async () => {
    expect(CREATE).not.toHaveLength(0);
    for (const example of CREATE) {
      expect(z.strictObject(createSheetInputShape).safeParse(example.input).success, `línea ${example.line}`).toBe(true);
      expect(String(example.input.name).endsWith('.ods'), `línea ${example.line}`).toBe(true);
      const parsed = parseSheetCommands(example.input.ops);
      expect(parsed.ok, `línea ${example.line}`).toBe(true);
      if (!parsed.ok) continue;
      const built = await buildSheetFile(parsed.ops, AbortSignal.timeout(20_000));
      expect('code' in built ? built : null, `línea ${example.line}`).toBeNull();
    }
  });

  it('cada ejemplo de edición pasa el esquema y entra, o es rechazado por el motivo que dice', async () => {
    const model = await bookOf(CREATE[0] as Example);
    for (const example of EDIT.filter((item) => !hasOptCommands(item))) {
      const where = `línea ${example.line}`;
      expect(z.strictObject(editSheetInputShape).safeParse(example.input).success, where).toBe(true);
      if ('undoOperationId' in example.input) {
        // Deshacer: solo `id`, `undoOperationId` y un `operationId` nuevo.
        expect(Object.keys(example.input).sort(), where).toEqual(['id', 'operationId', 'undoOperationId']);
        expect(example.input.undoOperationId, where).not.toBe(example.input.operationId);
        continue;
      }
      const parsed = parseSheetCommands(example.input.ops);
      expect(parsed.ok, where).toBe(true);
      const out = compileBatch(model, { ...batchOf(example, model), ops: (example.input.ops as SheetCommand[]).map(withAnchorArrays) });
      if (example.reason === null) expect('error' in out ? out : null, where).toBeNull();
      else expect('error' in out ? out.error : null, where).toBe(example.reason);
    }
  });

  it('cada ejemplo con comandos de los bloques (H-171) pasa el esquema y compila tramo a tramo con la función de su bloque', async () => {
    const examplesWithBlocks = EDIT.filter(hasOptCommands);
    // Uno por familia: tablas, gráficos, imágenes y `clearSpillBlockers`; y una fórmula con `A1#`.
    const types = new Set(examplesWithBlocks.flatMap((example) => (example.input.ops as { type: string }[]).map((op) => op.type)));
    for (const type of ['createTable', 'createChart', 'insertImage', 'clearSpillBlockers', 'pivotCreate']) expect(types.has(type), type).toBe(true);
    expect(EDIT.some((example) => JSON.stringify(example.input.ops).includes('#)'))).toBe(true);
    const bytes = await bookBytesOf(CREATE[0] as Example);
    for (const example of examplesWithBlocks) {
      const where = `línea ${example.line}`;
      expect(z.strictObject(editSheetInputShape).safeParse(example.input).success, where).toBe(true);
      const parsed = parseSheetEditCommands(example.input.ops, example.input.assets);
      expect(parsed.ok ? null : parsed.error, where).toBeNull();
      if (!parsed.ok) continue;
      // La regla de garantías de los bloques: `expectedRevision` o `expectedLayout`; y
      // `clearSpillBlockers`, que vacía por dirección sin `expect`, `expectedRevision`.
      expect('expectedRevision' in example.input || 'expectedLayout' in example.input, where).toBe(true);
      if (parsed.ops.some((op) => op.type === 'clearSpillBlockers')) {
        expect('expectedRevision' in example.input, where).toBe(true);
        // Qué vacía depende del desborde bloqueado que haya; eso lo prueba `edit-sheet.node.test.ts`.
        continue;
      }
      const out = await compileExample(bytes, parsed.ops);
      expect(out, where).toEqual({ ok: true });
    }
  });

  it('el ejemplo de A1# entra en compileBatch tras pasar A1# a ANCHORARRAY, como hace hebra_edit_sheet', async () => {
    const model = await bookOf(CREATE[0] as Example);
    const example = EDIT.find((item) => !hasOptCommands(item) && JSON.stringify(item.input.ops).includes('#)')) as Example;
    const ops = (example.input.ops as SheetCommand[]).map(withAnchorArrays);
    const out = compileBatch(model, { ...batchOf(example, model), ops });
    expect('error' in out ? out : null).toBeNull();
  });

  it('el ejemplo sin garantía lo rechaza la regla de direcciones, no otra cosa', async () => {
    const model = await bookOf(CREATE[0] as Example);
    const example = EDIT.find((item) => item.reason === 'batch_invalid') as Example;
    const out = compileBatch(model, batchOf(example, model));
    expect('error' in out ? out.reason : '').toContain('necesita "expect" o "expectedRevision"');
    // Con `expectedLayout` y nada más: sigue sin valer (no ve que otra persona escribió en el destino).
    expect('expectedLayout' in example.input).toBe(true);
  });

  it('el ejemplo con expect y sin expectedLayout lo rechaza la regla por expectedLayout (H-80b-BASE)', async () => {
    const model = await bookOf(CREATE[0] as Example);
    const example = EDIT.find(
      (item) =>
        item.reason === 'batch_invalid' &&
        !('expectedLayout' in item.input) &&
        !('expectedRevision' in item.input) &&
        (item.input.ops as Array<{ expect?: unknown }>).every((op) => op.expect !== undefined)
    ) as Example;
    expect(example).toBeDefined();
    const out = compileBatch(model, batchOf(example, model));
    expect('error' in out ? out : null).toMatchObject({ error: 'batch_invalid', opIndex: null });
    expect('error' in out ? out.reason : '').toContain('expectedLayout');
    // Con la `layoutRevision` leída, el mismo lote entra.
    expect('error' in compileBatch(model, { ...batchOf(example, model), expectedLayout: model.layoutRevision })).toBe(false);
  });

  it('nombra cada herramienta, cada comando del contrato y cada campo de la regla', () => {
    const mentioned = (name: string) => TEXT.includes(`\`${name}\``);
    expect([...SHEET_TOOL_NAMES].filter((name) => !mentioned(name))).toEqual([]);
    expect(SHEET_COMMAND_TYPES.filter((name) => !mentioned(name))).toEqual([]);
    // Y los de los bloques opcionales (H-171), con lo que los lee y lo que dicen sus errores.
    expect(OPT_COMMAND_TYPES.filter((name) => !mentioned(name))).toEqual([]);
    for (const word of ['objects', 'imageCount', 'chartCount', 'assets', 'spill', 'blockedBy', 'reliable', 'createdIds', 'op_unsupported', 'pivots', 'unreliable', 'trust', '$valores', 'pivotRefresh']) {
      expect(mentioned(word), word).toBe(true);
    }
    for (const word of ['expect', 'expectedRevision', 'expectedLayout', 'layoutRevision', 'nextCursor', 'dryRun', 'undoOperationId', 'untrustedContent', 'spilled']) {
      expect(mentioned(word), word).toBe(true);
    }
    // La regla de garantías con las dos advertencias: ni `expectedLayout` solo ni `expect` solo.
    expect(TEXT).toContain('`expectedLayout` solo NO basta');
    expect(TEXT).toContain('`expect` solo no basta');
  });

  it('los topes escritos coinciden con los del código', () => {
    const text = plain(TEXT);
    const figures: Record<string, string | number> = {
      DOCUMENT_MAX_BYTES: `${DOCUMENT_MAX_BYTES / 1024 / 1024} MiB`,
      EDIT_OPS_MAX: EDIT_OPS_MAX,
      EDIT_OPS_MAX_BYTES: `${EDIT_OPS_MAX_BYTES / 1024} KiB`,
      READ_SHEET_MAX_CELLS,
      READ_SHEET_DEFAULT_CELLS,
      DOCUMENT_RESPONSE_MAX_CHARS,
      SHEET_CELL_TEXT_MAX,
      RENDER_SHEET_MAX_COLUMNS,
      RENDER_SHEET_MAX_ROWS,
      RENDER_WIDTH_DEFAULT_PX,
      RENDER_WIDTH_MAX_PX,
      RENDER_WIDTH_MIN_PX,
      UNDO_MAX_AGE_DAYS,
      UNDO_MAX_ENTRIES,
      CREATE_SHEET_COMPILED_OPS_MAX,
      ASSETS_MAX_BYTES: `${ASSETS_MAX_BYTES / 1024 / 1024} MiB en total`,
      MAX_IMAGE_SIDE_PX: `${MAX_IMAGE_SIDE_PX} px por lado`,
      MAX_IMAGE_ALT_CHARS: `${MAX_IMAGE_ALT_CHARS} caracteres`,
      MAX_TABLE_NAME: `${MAX_TABLE_NAME} caracteres`,
      DOCUMENT_READ_TIMEOUT_MS: `${DOCUMENT_READ_TIMEOUT_MS / 1000} s`,
      DOCUMENT_EDIT_TIMEOUT_MS: `${DOCUMENT_EDIT_TIMEOUT_MS / 1000} s`
    };
    const missing = Object.entries(figures)
      .filter(([, value]) => !text.includes(String(value)))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('SKILL.md enlaza la referencia con una sola línea', () => {
    const skill = readFileSync(SKILL_MD, 'utf8');
    const links = skill.split('\n').filter((line) => line.includes('references/hojas-de-calculo.md'));
    expect(links).toHaveLength(1);
  });
});
