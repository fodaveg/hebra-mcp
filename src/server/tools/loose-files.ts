/**
 * Crear, renombrar, mover y duplicar ficheros sueltos (D17, decisión de David del 12 oct
 * 2026: «que pueda crear bases» y «no solo crear, dale todos los verbos que necesite»;
 * diseño de la sesión principal): `hebra_create_file`, `hebra_rename_file`,
 * `hebra_move_file` y `hebra_duplicate_file`. Amplía D10 y D15, que dejaban estas
 * operaciones fuera. Purgar un fichero sigue fuera (D2: el MCP nunca purga).
 *
 * - Crear: solo ficheros de texto con extensión `.base`, `.yaml`, `.yml`, `.json`, `.csv`
 *   o `.txt` (otra, `file_type_not_allowed`; un `.md` es una nota, `hebra_create_note`), y
 *   hasta 1 000 000 bytes de texto UTF-8 (`file_too_large`). Un `.base` creado aquí sale en
 *   Bases de Hebra tras el sync: la app los encuentra por el sufijo.
 * - Renombrar y duplicar: la extensión no cambia (sin distinguir mayúsculas; si no,
 *   `invalid_input`). Duplicar copia los bytes (mismo `sha256`) de cualquier tipo, hasta
 *   5 MiB.
 * - Las cuatro llevan `operationId` (idempotentes en el registro compartido) y responden la
 *   prueba de lo guardado: `{id, name, folderPath, sha256, byteLength, mimeType, outcome,
 *   replayed?, sync, syncError?}`.
 *
 * Privacidad (SPEC.md §6.3), en tres sitios, como `./files.ts`:
 * 1. Aquí, antes de escribir, con el filtro de esta llamada: el fichero de origen tiene que
 *    ser visible y vivo (si no, `not_found`, igual para uno oculto, inexistente, una lápida
 *    o uno de la papelera) y la carpeta de destino, visible (si no, `not_found`, como
 *    `hebra_move_note`).
 * 2. En el escritor, dentro del turno en que escribe y con esta misma configuración
 *    (`../../store/file-verbs.ts`): todo lo anterior otra vez, el choque de nombres con un
 *    fichero VISIBLE (`file_exists` con su id; un homónimo oculto no cuenta) y que el
 *    resultado no quede oculto (`not_found` al renombrar, mover o duplicar;
 *    `file_name_unavailable` al crear).
 * 3. Tras la ronda, la puerta final (`../privacy-gate.ts`) juzga lo que nombra la respuesta
 *    (el fichero, su carpeta y, en `file_exists`, el fichero que choca): si ya no se ve, la
 *    respuesta de algo que no existe.
 *
 * Logs (§6.4): `file.create`, `file.rename`, `file.move` y `file.duplicate` con el id
 * (opaco), el resultado y el estado de sync. Nunca el nombre, la ruta, el texto ni los
 * hashes.
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { logEvent } from '../../log/logger';
import { FileFilter } from '../../privacy/file-filter';
import {
  encodeFileText,
  nameExtension,
  FILE_CREATE_MAX_BYTES,
  FILE_DUPLICATE_MAX_BYTES,
  validFileName
} from '../../store/file-content';
import { prepareCreate, type LooseFileWriteInput } from '../../store/file-verbs';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { syncOf, type LooseFileOutcome, type SyncFields } from '../write-context';
import { requireValidOperationId } from './guards';
import { mapWriteError } from './write-errors';

export type LooseFileOutput = {
  id: string;
  name: string;
  /** La carpeta donde queda (vacío = la raíz). */
  folderPath: string;
  sha256: string;
  byteLength: number | null;
  mimeType: string | null;
  outcome: 'saved' | 'already';
  replayed?: true;
} & SyncFields;

/** Dónde: `folderId` (`"root"` es la raíz) o `folder` (ruta, como `path` de
 *  `hebra_list_folders`), como mucho uno; sin ninguno, `fallback`. Una ruta que no existe,
 *  una carpeta privada (también por la memoria de carpetas privadas de D16) o un id que
 *  no es de una carpeta: `not_found`, todos igual. La que sale queda declarada. */
function destinationOf(
  ctx: ToolContext,
  input: { folder?: string; folderId?: string },
  fallback: string | undefined
): string | undefined {
  if (input.folder !== undefined && input.folderId !== undefined) throw new ToolError('invalid_input');
  let id: string | undefined;
  if (input.folderId !== undefined) {
    id = input.folderId;
  } else if (input.folder !== undefined) {
    id = ctx.privacy.folderIdForPath(input.folder);
    if (!id) throw new ToolError('not_found');
  } else {
    id = fallback;
  }
  if (id === undefined) return undefined;
  if (!ctx.privacy.folderExists(id) || ctx.privacy.isFolderHidden(id)) {
    throw new ToolError('not_found');
  }
  usageOf(ctx).folder(id, ctx.privacy.folderPath(id));
  return id;
}

/** El fichero de origen, visible y vivo con el filtro de esta llamada; si no, `not_found`.
 *  Queda declarado para la puerta final desde ya: un error posterior también dice algo de
 *  él. */
async function sourceOf(ctx: ToolContext, id: string) {
  const content = (await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig)).contentOf(id);
  if (!content || content.file.trashedAt !== null) throw new ToolError('not_found');
  usageOf(ctx).file(id);
  return content;
}

/** El nombre nuevo, recortado y válido (`validFileName`); si no, `invalid_input`. Se mira
 *  antes de tocar nada: es solo de la entrada. */
function nameOf(raw: string): string {
  const name = validFileName(raw);
  if (name === null) throw new ToolError('invalid_input');
  return name;
}

/** Escribe por el escritor (o se lo reenvía), traduce sus errores y, si choca con un
 *  fichero visible, lo declara: la puerta final mira que se siga viendo antes de dar su id. */
async function write(ctx: ToolContext, input: LooseFileWriteInput): Promise<LooseFileOutcome> {
  try {
    return await ctx.write!.looseFileWrite!(input);
  } catch (error) {
    const mapped = mapWriteError(error);
    const existing = mapped.code === 'file_exists' ? mapped.extra?.id : undefined;
    if (typeof existing === 'string') usageOf(ctx).file(existing);
    throw mapped;
  }
}

/** La salida, con la ruta de la carpeta donde quedó, y su log. Que el fichero y esa carpeta
 *  se sigan viendo tras la ronda lo decide la puerta final. */
function outputOf(ctx: ToolContext, event: string, result: LooseFileOutcome): LooseFileOutput {
  logEvent({
    event,
    id: result.id,
    outcome: result.outcome,
    sync: result.sync,
    replayed: result.replayed === true
  });
  const folderPath = ctx.privacy.folderPath(result.folderId);
  const used = usageOf(ctx);
  used.file(result.id);
  used.folder(result.folderId, folderPath);
  return {
    id: result.id,
    name: result.name,
    folderPath,
    sha256: result.sha256,
    byteLength: result.byteLength,
    mimeType: result.mimeType,
    outcome: result.outcome,
    ...(result.replayed === true ? { replayed: true as const } : {}),
    ...syncOf(result)
  };
}

function requireWriter(ctx: ToolContext, operationId: string): void {
  if (!ctx.write?.looseFileWrite) throw new ToolError('invalid_input');
  requireValidOperationId(operationId);
}

/** `hebra_create_file`: un fichero de texto nuevo en una carpeta visible (o la raíz). */
export async function runCreateFile(
  ctx: ToolContext,
  input: { folder?: string; folderId?: string; name: string; text: string; operationId: string }
): Promise<LooseFileOutput> {
  requireWriter(ctx, input.operationId);
  // Lo que es solo de la entrada, antes de mirar ninguna carpeta: el escritor lo repite.
  let name: string;
  try {
    ({ name } = prepareCreate(input.name, input.text));
  } catch (error) {
    const mapped = mapWriteError(error);
    if (mapped.code !== 'file_too_large') throw mapped;
    throw new ToolError('file_too_large', {
      byteLength: encodeFileText(input.text)?.length ?? null,
      maxBytes: FILE_CREATE_MAX_BYTES
    });
  }
  const folderId = destinationOf(ctx, input, ROOT_FOLDER_ID)!;
  const result = await write(ctx, {
    action: 'createFile',
    folderId,
    name,
    text: input.text,
    operationId: input.operationId,
    privacy: ctx.privacyConfig
  });
  return outputOf(ctx, 'file.create', result);
}

/** `hebra_rename_file`: otro nombre, con la misma extensión, en la misma carpeta. */
export async function runRenameFile(
  ctx: ToolContext,
  input: { id: string; name: string; operationId: string }
): Promise<LooseFileOutput> {
  requireWriter(ctx, input.operationId);
  const name = nameOf(input.name);
  const source = await sourceOf(ctx, input.id);
  if (nameExtension(name) !== nameExtension(source.file.name)) throw new ToolError('invalid_input');
  const result = await write(ctx, {
    action: 'renameFile',
    id: input.id,
    name,
    operationId: input.operationId,
    privacy: ctx.privacyConfig
  });
  return outputOf(ctx, 'file.rename', result);
}

/** `hebra_move_file`: a otra carpeta visible (o la raíz), con el mismo nombre. */
export async function runMoveFile(
  ctx: ToolContext,
  input: { id: string; folder?: string; folderId?: string; operationId: string }
): Promise<LooseFileOutput> {
  requireWriter(ctx, input.operationId);
  if (input.folder !== undefined && input.folderId !== undefined) throw new ToolError('invalid_input');
  await sourceOf(ctx, input.id);
  const folderId = destinationOf(ctx, input, ROOT_FOLDER_ID)!;
  const result = await write(ctx, {
    action: 'moveFile',
    id: input.id,
    folderId,
    operationId: input.operationId,
    privacy: ctx.privacyConfig
  });
  return outputOf(ctx, 'file.move', result);
}

/** `hebra_duplicate_file`: un fichero nuevo con los mismos bytes, otro nombre con la misma
 *  extensión, en la carpeta del origen o en otra visible. */
export async function runDuplicateFile(
  ctx: ToolContext,
  input: { id: string; name: string; folder?: string; folderId?: string; operationId: string }
): Promise<LooseFileOutput> {
  requireWriter(ctx, input.operationId);
  const name = nameOf(input.name);
  if (input.folder !== undefined && input.folderId !== undefined) throw new ToolError('invalid_input');
  const source = await sourceOf(ctx, input.id);
  if (nameExtension(name) !== nameExtension(source.file.name)) throw new ToolError('invalid_input');
  const folderId = destinationOf(ctx, input, undefined);
  const known = source.file.byteLength;
  const tooLarge = (byteLength: number | null): ToolError =>
    new ToolError('file_too_large', {
      ...(byteLength !== null ? { byteLength } : {}),
      maxBytes: FILE_DUPLICATE_MAX_BYTES
    });
  if (known !== null && known > FILE_DUPLICATE_MAX_BYTES) throw tooLarge(known);
  let result: LooseFileOutcome;
  try {
    result = await write(ctx, {
      action: 'duplicateFile',
      id: input.id,
      name,
      ...(folderId !== undefined ? { folderId } : {}),
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === 'file_too_large') throw tooLarge(known);
    throw error;
  }
  return outputOf(ctx, 'file.duplicate', result);
}
