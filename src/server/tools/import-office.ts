/**
 * `hebra_import_office` (C-25, contrato 3.6 del plan de importación común): convierte un
 * `.xlsx`, `.pptx` o `.docx` a su formato de Hebra y, según `mode`, conserva el original.
 *
 * Entrada: el contenido en `dataBase64` o un fichero de la biblioteca en `fileId` (exactamente
 * uno), `name` (obligatorio con `dataBase64`; con `fileId` manda el nombre del fichero),
 * destino con `folder` (ruta) o `folderId` (como mucho uno; sin ninguno, la carpeta del
 * `fileId` o la raíz), `mode` (por defecto `convert-and-keep`), `preview` (solo analiza, no
 * escribe) y `operationId`, obligatorio salvo con `preview`.
 *
 * Todo lo que es de la entrada se valida ANTES de tocar el almacén y sin eco: esquema,
 * base64 estricto, tope de tamaño (`office-limits.ts`) y formato. `.doc`, `.xls` y `.ppt`
 * (formatos retirados) y cualquier otra extensión, `unsupported_format`. Después, privacidad
 * (SPEC.md §6.3): la carpeta de destino y el fichero de origen tienen que ser visibles; si no,
 * `not_found`. El escritor lo repite dentro de su turno (C-29) y rechaza sin escribir un
 * espacio de solo lectura o una nota que quedaría oculta por sus etiquetas.
 *
 * Escritor: `WriteContext.importOffice` (`../write-context.ts`), que en local es
 * `importOfficeLocal` (`../../store/office-writes.ts`) y en un lector se reenvía al escritor.
 * Con `fileId` la herramienta NO lee los bytes: manda `sourceFileId` y el escritor los lee de su
 * disco con la privacidad de quien pide, así un lector no sube 25 MiB para que se descarten.
 *
 * Logs (§6.4): `import.office` con el id (de la nota o del fichero convertido), el resultado y
 * el formato. Nunca el nombre, el hash ni el contenido.
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { logEvent } from '../../log/logger';
import { FileFilter } from '../../privacy/file-filter';
import { nameExtension, validFileName } from '../../store/file-content';
import type {
  ConversionBlockReason,
  ConversionLoss,
  OfficeFormat,
  OfficeImportMode
} from '../../../vendor/hebra/src/lib/office-import/types';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { syncOf, type OfficeImportOutcome, type SyncFields } from '../write-context';
import { requireValidOperationId } from './guards';
import { OFFICE_DATA_MAX_BYTES, OFFICE_FILE_ID_MAX_BYTES } from './office-limits';
import { mapWriteError } from './write-errors';

const FORMATS: Record<string, OfficeFormat> = { xlsx: 'xlsx', pptx: 'pptx', docx: 'docx' };
const MODES: readonly OfficeImportMode[] = ['convert-and-keep', 'convert-only', 'keep-only'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImportOfficeInput = {
  name?: string;
  dataBase64?: string;
  fileId?: string;
  folder?: string;
  folderId?: string;
  mode?: OfficeImportMode;
  preview?: boolean;
  operationId?: string;
  space?: string;
};

export type ImportOfficeOutput = {
  format: OfficeFormat;
  mode: OfficeImportMode;
  outcome: OfficeImportOutcome['outcome'];
  convertible: boolean;
  reason?: ConversionBlockReason;
  losses: ConversionLoss[];
  note?: { id: string; title: string };
  convertedFile?: { id: string; name: string; sha256: string };
  original?: { id: string; name: string; sha256: string; trashed?: boolean };
  replayed?: true;
} & Partial<SyncFields>;

function formatOf(name: string): OfficeFormat {
  const extension = nameExtension(name);
  const format = extension === null ? undefined : FORMATS[extension];
  if (!format) throw new ToolError('unsupported_format');
  return format;
}

/** Base64 estricto (sin espacios ni saltos) con el tope de Office: la longitud decide antes de
 *  decodificar. `file_too_large` lleva el tamaño y el tope, nunca la entrada. */
function decodeOfficeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\t\n\v\f\r ]+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || !BASE64.test(clean)) {
    throw new ToolError('invalid_input');
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLength = (clean.length / 4) * 3 - padding;
  if (byteLength > OFFICE_DATA_MAX_BYTES) {
    throw new ToolError('file_too_large', { byteLength, maxBytes: OFFICE_DATA_MAX_BYTES });
  }
  const buffer = Buffer.from(clean, 'base64');
  if (buffer.length !== byteLength || buffer.toString('base64') !== clean) {
    throw new ToolError('invalid_input');
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** La carpeta de destino visible; una ruta que no existe, una privada o un id ajeno, todos
 *  `not_found`. La que sale queda declarada para la puerta final. */
function destinationOf(ctx: ToolContext, input: ImportOfficeInput, fallback: string): string {
  let id = fallback;
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

/** El fichero de origen: visible y vivo con el filtro de esta llamada (si no, `not_found`), de
 *  tamaño dentro del tope si ya se conoce y con formato de Office. No lee bytes: los lee el
 *  escritor de su disco (`sourceFileId`), con la privacidad de quien pide, y él comprueba el
 *  tamaño real. */
async function readSource(ctx: ToolContext, id: string) {
  const content = (await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig)).contentOf(id);
  if (!content || content.file.trashedAt !== null) throw new ToolError('not_found');
  usageOf(ctx).file(id);
  const known = content.file.byteLength;
  if (known !== null && known > OFFICE_FILE_ID_MAX_BYTES) {
    throw new ToolError('file_too_large', { byteLength: known, maxBytes: OFFICE_FILE_ID_MAX_BYTES });
  }
  // Formato antes de nada más: un fichero que no es Office no llega al escritor.
  return { format: formatOf(content.file.name), name: content.file.name, folderId: content.file.folderId };
}

/** `hebra_import_office`: ver la cabecera. */
export async function runImportOffice(
  ctx: ToolContext,
  input: ImportOfficeInput
): Promise<ImportOfficeOutput> {
  // 1. Solo la entrada, sin tocar el almacén.
  const write = ctx.write;
  if (!write?.importOffice) throw new ToolError('invalid_input');
  const preview = input.preview === true;
  if ((input.dataBase64 === undefined) === (input.fileId === undefined)) {
    throw new ToolError('invalid_input');
  }
  if (input.folder !== undefined && input.folderId !== undefined) throw new ToolError('invalid_input');
  const mode = input.mode ?? 'convert-and-keep';
  if (!MODES.includes(mode)) throw new ToolError('invalid_input');
  if (!preview) {
    if (input.operationId === undefined) throw new ToolError('invalid_input');
    requireValidOperationId(input.operationId);
  } else if (input.operationId !== undefined) {
    requireValidOperationId(input.operationId);
  }

  let bytes: Uint8Array | undefined;
  let fileName: string;
  let format: OfficeFormat;
  if (input.dataBase64 !== undefined) {
    const name = input.name === undefined ? null : validFileName(input.name);
    if (name === null) throw new ToolError('invalid_input');
    format = formatOf(name);
    bytes = decodeOfficeBase64(input.dataBase64);
    fileName = name;
  } else {
    fileName = '';
    format = 'xlsx';
  }

  // 2. Privacidad: origen y destino visibles, con el filtro de esta llamada.
  let sourceFileId: string | undefined;
  let fallbackFolder = ROOT_FOLDER_ID;
  if (input.fileId !== undefined) {
    const source = await readSource(ctx, input.fileId);
    fileName = source.name;
    format = source.format;
    sourceFileId = input.fileId;
    fallbackFolder = source.folderId;
  }
  const folderId = destinationOf(ctx, input, fallbackFolder);

  // 3. El escritor lo vuelve a comprobar todo dentro de su turno.
  let result: OfficeImportOutcome;
  try {
    result = await write.importOffice({
      ...(bytes !== undefined ? { bytes } : {}),
      fileName,
      format,
      mode,
      preview,
      folderId,
      ...(sourceFileId !== undefined ? { sourceFileId } : {}),
      ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }

  // 4. Salida: lo que nombra la respuesta lo juzga la puerta final; el log, sin contenido.
  const used = usageOf(ctx);
  if (result.note) used.note(result.note.id);
  if (result.convertedFile) used.file(result.convertedFile.id);
  if (result.original) used.file(result.original.id);
  logEvent({
    event: 'import.office',
    id: result.note?.id ?? result.convertedFile?.id ?? null,
    outcome: result.outcome,
    format,
    ...(result.sync !== undefined ? { sync: result.sync } : {}),
    replayed: result.replayed === true
  });
  return {
    format,
    mode,
    outcome: result.outcome,
    convertible: result.convertible,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    losses: result.losses,
    ...(result.note ? { note: result.note } : {}),
    ...(result.convertedFile ? { convertedFile: result.convertedFile } : {}),
    ...(result.original ? { original: result.original } : {}),
    ...(result.replayed === true ? { replayed: true as const } : {}),
    ...(result.sync !== undefined ? syncOf({ sync: result.sync, syncError: result.syncError }) : {})
  };
}
