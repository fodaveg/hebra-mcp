/**
 * `hebra_create_sheet` (H-79, S-02 del estudio MCP de documentos): crea una hoja de cálculo `.ods`
 * nueva y, si se pide, le aplica un lote de comandos por dirección A1 (`SheetCommand`, esquemas en
 * `./sheet-op-schemas.ts`). Se implementa SIN registrarse: la da de alta H-177 junto a las otras
 * tres herramientas de hojas en `document-tool-table.ts` (decisión 17), con `createSheetInputShape`
 * como esquema y un `CreateSheetWriter` que llega al escritor por la op `documentOps`.
 *
 * El libro nace con una hoja, `Hoja 1`, de 1.048.576 filas por 16.384 columnas (la rejilla de
 * Excel y de LibreOffice). Los comandos van en orden y cada uno ve lo que dejaron los anteriores:
 * se puede crear una hoja con `addSheet` (y `as`) y escribir en ella con `"$alias"` en el mismo
 * lote, cosa que una edición no permite. En un libro que todavía no existe nadie puede mover una
 * dirección, así que aquí no se exige `expect` ni `expectedRevision`; si llega un `expect`, se
 * compara igual con lo que hay.
 *
 * Mismo código que la app (D5): el libro vacío lo escribe `writeNewOds` (H-23), los comandos los
 * compila `compileBatch` (H-30) y los aplica el adaptador de hojas (H-31) sobre un `Y.Doc` de
 * trabajo, y `exportFile` (H-24) escribe el `.ods` final. El `Y.Doc` no se guarda: el fichero
 * nace como un `.ods` sin estado (sección 4 del estudio) y su cabecera `/h` la pone el escritor.
 * Todo es determinista (ids derivados del índice del comando, `clientID` fijo y sin fecha), así
 * que el mismo lote da los mismos bytes y un reintento con el mismo `operationId` es `already`.
 *
 * Orden, como `hebra_import_office`:
 * 1. La entrada, sin tocar el almacén: nombre `.ods`, `operationId` y el lote
 *    (`parseSheetCommands`: forma, topes y sin funciones de red). Un fallo es `batch_invalid`.
 * 2. La carpeta de destino, visible con el filtro de esta llamada; si no, `not_found`.
 * 3. El libro, fuera de todo turno, con plazo (`DOCUMENT_EDIT_TIMEOUT_MS`) y un tope de
 *    operaciones compiladas: pasarse es `document_too_complex`.
 * 4. El escritor (`createDocumentFile`, B-N20, desde `runDocumentRequest`) lo vuelve a comprobar
 *    todo en su turno: carpeta privada u oculta, `not_found`; espacio de solo lectura,
 *    `client_outdated`; homónimo visible, `file_exists`.
 *
 * Fórmulas: se guardan sin valor en caché y LibreOffice las calcula al abrir (sonda S1 de H-06).
 * La caché con el motor de Node (H-09) es cosa del punto de control, no de la creación.
 *
 * Imágenes: ningún comando de hojas coloca imágenes todavía, así que `assets` solo se valida (una
 * URL nunca pasa) y, si llega alguno, el lote es `batch_invalid`.
 */
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import * as Y from 'yjs';
import { z } from 'zod';
import { ROOT_FOLDER_ID } from '../../hebra';
import type { PrivacyConfig } from '../../privacy/config';
import {
  compileBatch,
  createSheetAdapter,
  layoutRevision,
  prepareSheetBase,
  writeNewOds,
  type AxisIds,
  type SheetAdapter,
  type SheetCommand,
  type SheetModel,
  type SheetOp
} from '../../sheets';
import { DocOpError } from '../../../vendor/hebra/src/lib/documents/contract';
import { writeOdfZip } from '../../../vendor/hebra/src/lib/documents/odf/zip-write';
import { newDocumentHead } from '../../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { DOCUMENT_EDIT_TIMEOUT_MS } from '../../store/document-limits';
import { openDocumentRead, type DocumentReadSource } from '../../store/document-read';
import type { DocumentCreated } from '../../store/document-service';
import type { BatchIssue, DocumentError, WriteOut } from '../../store/document-types';
import { nameExtension, validFileName } from '../../store/file-content';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { requireValidOperationId } from './guards';
import { parseSheetAssets, parseSheetCommands, sheetAssetsField, sheetOpsField } from './sheet-op-schemas';
import { mapWriteError } from './write-errors';

/** Nombre de la herramienta, para H-177. */
export const CREATE_SHEET_TOOL = 'hebra_create_sheet';

/** La hoja con que nace todo libro. */
export const DEFAULT_SHEET_NAME = 'Hoja 1';

/** Filas y columnas de una hoja nueva: las de Excel y de LibreOffice. */
const NEW_SHEET_ROWS = 1_048_576;
const NEW_SHEET_COLS = 16_384;

/**
 * Operaciones compiladas como mucho en una creación. `setFormat` da una por celda (hasta 50.000
 * por comando): sin este tope, 200 comandos serían diez millones. Provisional hasta V-01.
 */
export const CREATE_SHEET_COMPILED_OPS_MAX = 200_000;

/** Motivo de rechazo de `assets`: todavía no hay comando que coloque una imagen en una hoja. */
const NO_IMAGE_COMMANDS = 'ningún comando de hojas coloca imágenes todavía';

/** Revisión que se da a `compileBatch` en un libro nuevo: nadie puede haber movido nada. */
const NEW_BOOK_REVISION = 'hebra.create-sheet/new';

/** Comandos que cambian hojas o ejes: tras ellos el siguiente compila sobre una lectura nueva. */
const STRUCTURAL: ReadonlySet<SheetCommand['type']> = new Set([
  'addSheet',
  'deleteSheet',
  'renameSheet',
  'moveSheet',
  'insertAxis',
  'deleteAxis'
]);

/** Esquema de entrada para el registro (H-177). Lo que cruza campos lo valida `runCreateSheet`. */
export const createSheetInputShape = {
  name: z.string().describe('Nombre del fichero CON extensión .ods.'),
  folder: z.string().optional().describe('Ruta de la carpeta de destino, como `path` de hebra_list_folders.'),
  folderId: z
    .string()
    .optional()
    .describe('Id de la carpeta de destino (hebra_list_folders; "root" es la raíz), en vez de `folder`. Sin ninguno, la raíz.'),
  ops: sheetOpsField.optional(),
  assets: sheetAssetsField,
  operationId: z
    .string()
    .describe('Id único de esta operación (un UUID). Reintentar con el mismo no crea otro fichero.')
};

export type CreateSheetInput = {
  name: string;
  folder?: string;
  folderId?: string;
  ops?: unknown[];
  assets?: unknown[];
  operationId: string;
  space?: string;
};

/** Lo que pide la herramienta al escritor: la op `documentOps` con `action: 'create'`. */
export interface CreateSheetRequest {
  format: 'ods';
  folderId: string;
  name: string;
  bytes: Uint8Array;
  operationId: string;
  privacy: PrivacyConfig;
}

/**
 * El escritor de la creación. H-177 lo cablea a `documentOps` (`runDocumentRequest` en local, el
 * socket en un lector). Los rechazos del almacén (`not_found`, `file_exists`…) se lanzan; uno
 * recuperable del documento sale como `{ ok: false, error }`.
 */
export type CreateSheetWriter = (
  request: CreateSheetRequest
) => Promise<{ ok: true; created: DocumentCreated } | { ok: false; error: DocumentError }>;

/** Lo que devuelve `hebra_create_sheet`: la salida común de una escritura y el nombre. */
export type CreateSheetOutput = WriteOut & {
  name: string;
  layoutRevision: string;
  outcome: 'saved' | 'already';
};

/** El libro ya escrito, con los ids reales de cada `as`. */
export interface BuiltSheet {
  bytes: Uint8Array;
  createdIds: Record<string, string>;
}

/** Eje de ids implícitos `b0..b<n-1>`, como los del convertidor XLSX: no ocupa nada. */
class ImplicitAxis implements AxisIds {
  constructor(private readonly size: number) {}
  length(): number {
    return this.size;
  }
  idAt(index: number): string {
    return `b${index}`;
  }
  indexOf(id: string): number | null {
    const found = /^b(\d+)$/.exec(id);
    return found && Number(found[1]) < this.size ? Number(found[1]) : null;
  }
}

/** El libro vacío con que empieza toda creación. */
function blankBook(): SheetModel {
  const model: SheetModel = {
    sheets: [
      {
        id: 's0',
        name: DEFAULT_SHEET_NAME,
        rows: new ImplicitAxis(NEW_SHEET_ROWS),
        cols: new ImplicitAxis(NEW_SHEET_COLS),
        frozenRows: 0,
        frozenCols: 0,
        cells: new Map(),
        merges: [],
        rules: []
      }
    ],
    layoutRevision: ''
  };
  return { ...model, layoutRevision: layoutRevision(model) };
}

/** Prefijos que `exportOds` necesita en la raíz de `content.xml` para escribir estilos. */
const STYLE_NAMESPACES: readonly [string, string][] = [
  ['style', 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'],
  ['fo', 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0'],
  ['number', 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0']
];

/**
 * El `.ods` vacío de partida. `writeNewOds` no declara `style`, `fo` ni `number` en la raíz de
 * `content.xml` (`vendor/hebra/src/lib/sheets/ods/write-new.ts:623`), y `writeStyle` rechaza
 * entonces cualquier formato (`style-write.ts:384`). El convertidor XLSX los añade igual
 * (`withNamespaces`, `xlsx/converter.ts:387`); aquí se hace lo mismo hasta que `writeNewOds` los
 * declare, y entonces esta función se reduce a `writeNewOds(blankBook())`.
 */
function blankBase(): Uint8Array {
  const files = unzipSync(writeNewOds(blankBook()));
  const decoder = new TextDecoder();
  const content = decoder.decode(files['content.xml']);
  const root = '<office:document-content';
  const at = content.indexOf(root) + root.length;
  const extra = STYLE_NAMESPACES.filter(([prefix]) => !content.includes(` xmlns:${prefix}=`))
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join('');
  const encoder = new TextEncoder();
  const { mimetype, ...rest } = files;
  return writeOdfZip(
    [],
    [
      { path: 'mimetype', bytes: mimetype! },
      ...Object.entries(rest).map(([path, bytes]) => ({
        path,
        bytes: path === 'content.xml' ? encoder.encode(content.slice(0, at) + extra + content.slice(at)) : bytes
      }))
    ]
  );
}

/** Id determinista: el mismo lote da los mismos ids y, por tanto, los mismos bytes. */
function seededId(...parts: Array<string | number>): string {
  return createHash('sha256').update(`hebra.create-sheet/v1\u0000${parts.join('\u0000')}`).digest('hex').slice(0, 32);
}

/** Un lote rechazado, con el índice del comando y un motivo fijo. */
function rejected(opIndex: number, reason: string, path = `ops.${opIndex}`): DocumentError {
  const issues: BatchIssue[] = [{ opIndex, path, reason }];
  return { code: 'batch_invalid', issues };
}

/**
 * Un comando con sus `"$alias"` ya resueltos: la hoja, a su nombre de ahora (el de la última
 * lectura), y el id de una regla, al real. Un alias que no existe da `null`.
 */
function resolveAliases(
  command: SheetCommand,
  aliases: ReadonlyMap<string, string>,
  model: SheetModel
): SheetCommand | null {
  const real = (ref: string): string | null => (ref.startsWith('$') ? (aliases.get(ref.slice(1)) ?? null) : ref);
  if ('kind' in command) {
    if (command.id === undefined) return command;
    const id = real(command.id);
    return id === null ? null : { ...command, id };
  }
  if (!command.sheet.startsWith('$')) return command;
  const id = real(command.sheet);
  const name = id === null ? undefined : model.sheets.find((sheet) => sheet.id === id)?.name;
  return name === undefined ? null : { ...command, sheet: name };
}

/**
 * Escribe el libro: el vacío, y encima cada comando en orden. Devuelve el `.ods` o el error del
 * lote, sin escribir nada fuera de memoria. Corta con `signal` (el plazo de quien llama).
 */
export async function buildSheetFile(
  commands: readonly SheetCommand[],
  signal: AbortSignal,
  options: { maxCompiledOps?: number } = {}
): Promise<BuiltSheet | DocumentError> {
  const maxCompiledOps = options.maxCompiledOps ?? CREATE_SHEET_COMPILED_OPS_MAX;
  const blank = blankBase();
  if (commands.length === 0) return { bytes: blank, createdIds: {} };
  const adapter: SheetAdapter = createSheetAdapter(await prepareSheetBase(blank));
  const doc = new Y.Doc();
  // Sin azar: el `clientID` entra en las versiones de cada celda.
  doc.clientID = 1;
  try {
    adapter.scaffold(blank, doc);
    let model = await adapter.project(blank, doc, signal);
    const aliases = new Map<string, string>();
    const createdIds: Record<string, string> = {};
    let compiledTotal = 0;
    for (const [index, command] of commands.entries()) {
      signal.throwIfAborted();
      const resolved = resolveAliases(command, aliases, model);
      if (resolved === null) return rejected(index, 'cita un "$alias" que no existe en el lote');
      let counter = 0;
      const compiled = compileBatch(
        model,
        { ops: [resolved], expectedRevision: NEW_BOOK_REVISION },
        { newId: () => seededId('id', index, counter++) }
      );
      if ('error' in compiled) {
        if (compiled.error === 'precondition_failed') {
          return { code: 'precondition_failed', opIndex: index, target: `ops.${index}` };
        }
        return rejected(index, compiled.reason);
      }
      compiledTotal += compiled.ops.length;
      if (compiledTotal > maxCompiledOps) return { code: 'document_too_complex' };
      for (const [as, id] of Object.entries(compiled.createdIds)) {
        if (aliases.has(as)) return rejected(index, `"as" repetido: "${as}"`, `ops.${index}.as`);
        aliases.set(as, id);
        createdIds[as] = id;
      }
      const failure = applyCompiled(adapter, doc, compiled.ops, index);
      if (failure) return failure;
      const next = commands[index + 1];
      const nextReads = next !== undefined && 'expect' in next && next.expect !== undefined;
      if (STRUCTURAL.has(command.type) || nextReads) model = await adapter.project(blank, doc, signal);
    }
    signal.throwIfAborted();
    return { bytes: await adapter.exportFile(blank, doc, signal), createdIds };
  } finally {
    doc.destroy();
  }
}

/** Aplica las operaciones de un comando en una transacción. Un `DocOpError` es el lote rechazado. */
function applyCompiled(
  adapter: SheetAdapter,
  doc: Y.Doc,
  ops: readonly SheetOp[],
  index: number
): DocumentError | null {
  try {
    doc.transact(() => {
      for (const [k, op] of ops.entries()) {
        let counter = 0;
        adapter.applyOp(doc, op, { newId: () => seededId('op', index, k, counter++) });
      }
    }, 'agent');
    return null;
  } catch (error) {
    if (!(error instanceof DocOpError)) throw error;
    if (error.code === 'precondition_failed') return { code: 'precondition_failed', opIndex: index, target: `ops.${index}` };
    if (error.code === 'too_large') return { code: 'document_too_complex' };
    return rejected(index, error.message);
  }
}

/**
 * Las revisiones del documento recién creado, con la misma fórmula que su primera lectura
 * (`openDocumentRead`): un documento con cabecera, sin segmentos y con estos bytes de base.
 * Sirven de `expectedRevision` y `expectedLayout` para la primera edición.
 */
async function freshRevisions(
  fileId: string,
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<{ revision: string; layoutRevision: string }> {
  const head = newDocumentHead('ods', 'nuevo', 'nuevo');
  const source = {
    port: {
      docRead: async () => ({ head, segments: [], pending: [], pendingSeqs: [] }),
      blobRead: async () => bytes
    }
  } as unknown as DocumentReadSource;
  const adapter = createSheetAdapter(await prepareSheetBase(bytes));
  const read = await openDocumentRead(source, fileId, adapter, signal);
  try {
    return { revision: read.revision, layoutRevision: read.layoutRevision };
  } finally {
    await read.close();
  }
}

/** La carpeta de destino visible; una ruta que no existe, una privada o un id ajeno, `not_found`. */
function destinationOf(ctx: ToolContext, input: CreateSheetInput): string {
  let id = ROOT_FOLDER_ID;
  if (input.folderId !== undefined) {
    id = input.folderId;
  } else if (input.folder !== undefined) {
    const byPath = ctx.privacy.folderIdForPath(input.folder);
    if (!byPath) throw new ToolError('not_found');
    id = byPath;
  }
  if (!ctx.privacy.folderExists(id) || ctx.privacy.isFolderHidden(id)) throw new ToolError('not_found');
  usageOf(ctx).folder(id, ctx.privacy.folderPath(id));
  return id;
}

/** El error recuperable de un documento como error de herramienta (con sus campos, sin `code`). */
function documentRefusal(error: DocumentError): ToolError {
  const { code, ...extra } = error;
  return new ToolError(code, Object.keys(extra).length > 0 ? extra : undefined);
}

/** `hebra_create_sheet`: ver la cabecera. */
export async function runCreateSheet(
  ctx: ToolContext,
  input: CreateSheetInput,
  writer: CreateSheetWriter
): Promise<CreateSheetOutput> {
  // 1. Solo la entrada, sin tocar el almacén.
  if (typeof input.operationId !== 'string') throw new ToolError('invalid_input');
  requireValidOperationId(input.operationId);
  const name = typeof input.name === 'string' ? validFileName(input.name) : null;
  if (name === null || name !== input.name || nameExtension(name) !== 'ods') throw new ToolError('invalid_input');
  if (input.folder !== undefined && input.folderId !== undefined) throw new ToolError('invalid_input');
  let commands: SheetCommand[] = [];
  if (input.ops !== undefined) {
    const parsed = parseSheetCommands(input.ops, input.assets);
    if (!parsed.ok) throw documentRefusal(parsed.error);
    commands = parsed.ops;
    if (parsed.assets.length > 0) throw documentRefusal(rejected(0, NO_IMAGE_COMMANDS, 'assets'));
  } else {
    const parsed = parseSheetAssets(input.assets);
    if (!parsed.ok) throw documentRefusal(parsed.error);
    if (parsed.assets.length > 0) throw documentRefusal(rejected(0, NO_IMAGE_COMMANDS, 'assets'));
  }

  // 2. Privacidad: la carpeta de destino, visible con el filtro de esta llamada.
  const folderId = destinationOf(ctx, input);

  // 3. El libro, con plazo. Fuera de todo turno: el almacén no espera a este cálculo.
  const signal = AbortSignal.timeout(DOCUMENT_EDIT_TIMEOUT_MS);
  let built: BuiltSheet | DocumentError;
  try {
    built = await buildSheetFile(commands, signal);
  } catch (error) {
    if (signal.aborted) throw new ToolError('document_too_complex');
    throw error;
  }
  if ('code' in built) throw documentRefusal(built);

  // 4. El escritor lo vuelve a comprobar todo en su turno y pone la cabecera.
  let reply: Awaited<ReturnType<CreateSheetWriter>>;
  try {
    reply = await writer({
      format: 'ods',
      folderId,
      name,
      bytes: built.bytes,
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  if (!reply.ok) throw documentRefusal(reply.error);
  const { created } = reply;
  usageOf(ctx).file(created.id);
  const revisions = await freshRevisions(created.id, built.bytes, AbortSignal.timeout(DOCUMENT_EDIT_TIMEOUT_MS));
  return {
    id: created.id,
    name,
    outcome: created.outcome,
    revision: revisions.revision,
    layoutRevision: revisions.layoutRevision,
    ...(Object.keys(built.createdIds).length > 0 ? { createdIds: built.createdIds } : {}),
    ...(created.replayed ? { replayed: true as const } : {}),
    sync: created.sync,
    ...(created.syncError !== undefined ? { syncError: created.syncError } : {})
  };
}
