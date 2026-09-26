/**
 * `hebra_create_note` (SPEC.md §5, D2): crea una nota nueva con `body` (Markdown; el
 * primer H1 es el título, como en Hebra) en una carpeta existente por `folder?` (ruta) o
 * en la raíz por defecto. Límite de 100 000 caracteres (SPEC.md §5, «Detalle de las
 * escrituras»), comprobado ANTES de tocar el almacén: un cuerpo de sobra no debe abrir
 * siquiera la escritura.
 *
 * `hidden: true` en la salida si alguna etiqueta de `deriveNote(body).tags` es privada
 * (§6.3, «una nota creada con una etiqueta privada queda oculta desde ese momento»): NO
 * revela la CONFIGURACIÓN de privados (qué carpeta o etiqueta está oculta) a quien no la
 * conoce ya, porque quien escribió el cuerpo ya conoce sus propias etiquetas.
 */
import { deriveNote } from '../../hebra';
import { ROOT_FOLDER_ID } from '$lib/library/folder-tree';
import { logEvent } from '../../log/logger';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import { mapWriteError } from './write-errors';

const BODY_MAX_LENGTH = 100_000;

export interface CreateNoteOutput {
  id: string;
  title: string;
  folderPath: string;
  hidden?: true;
}

export async function runCreateNote(
  ctx: ToolContext,
  input: { body: string; folder?: string }
): Promise<CreateNoteOutput> {
  if (!ctx.write) throw new ToolError('invalid_input');
  if (input.body.length > BODY_MAX_LENGTH) throw new ToolError('invalid_input');

  const folderId =
    input.folder === undefined ? ROOT_FOLDER_ID : ctx.privacy.folderIdForPath(input.folder);
  if (!folderId || ctx.privacy.isFolderHidden(folderId)) throw new ToolError('not_found');

  let result;
  try {
    result = await ctx.write.createNote({ body: input.body, folderId });
  } catch (error) {
    throw mapWriteError(error);
  }

  const hidden = deriveNote(input.body).tags.some(({ tag }) => ctx.privacy.isTagHidden(tag));
  logEvent({ event: 'note.create', id: result.id, hidden });

  const output: CreateNoteOutput = {
    id: result.id,
    title: result.title,
    folderPath: ctx.privacy.folderPath(result.folderId)
  };
  if (hidden) output.hidden = true;
  return output;
}
