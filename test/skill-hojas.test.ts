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
 *
 * Además, que el texto nombre cada herramienta, cada comando del contrato y los topes vigentes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSheetFile, createSheetInputShape } from '../src/server/tools/create-sheet';
import { editSheetInputShape } from '../src/server/tools/edit-sheet';
import { readSheetInputShape } from '../src/server/tools/read-sheet';
import { parseRenderRange, renderRangeTooLarge, renderSheetInputShape } from '../src/server/tools/render-sheet';
import { parseSheetCommands, SHEET_COMMAND_TYPES } from '../src/server/tools/sheet-op-schemas';
import { compileBatch, prepareSheetBase, type SheetCommand, type SheetModel } from '../src/sheets';
import {
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
    for (const example of EDIT) {
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
      const out = compileBatch(model, batchOf(example, model));
      if (example.reason === null) expect('error' in out ? out : null, where).toBeNull();
      else expect('error' in out ? out.error : null, where).toBe(example.reason);
    }
  });

  it('el ejemplo sin garantía lo rechaza la regla de direcciones, no otra cosa', async () => {
    const model = await bookOf(CREATE[0] as Example);
    const example = EDIT.find((item) => item.reason === 'batch_invalid') as Example;
    const out = compileBatch(model, batchOf(example, model));
    expect('error' in out ? out.reason : '').toContain('necesita "expect" o "expectedRevision"');
    // Con `expectedLayout` y nada más: sigue sin valer (es un control añadido, no una garantía).
    expect('expectedLayout' in example.input).toBe(true);
  });

  it('nombra cada herramienta, cada comando del contrato y cada campo de la regla', () => {
    const mentioned = (name: string) => TEXT.includes(`\`${name}\``);
    expect([...SHEET_TOOL_NAMES].filter((name) => !mentioned(name))).toEqual([]);
    expect(SHEET_COMMAND_TYPES.filter((name) => !mentioned(name))).toEqual([]);
    for (const word of ['expect', 'expectedRevision', 'expectedLayout', 'layoutRevision', 'nextCursor', 'dryRun', 'undoOperationId', 'untrustedContent']) {
      expect(mentioned(word), word).toBe(true);
    }
    // La regla de garantías con la advertencia sobre `expectedLayout`.
    expect(TEXT).toContain('`expectedLayout` solo NO basta');
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
