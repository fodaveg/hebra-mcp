/**
 * `hebra_create_note` (SPEC.md §5, D2): crea una nota nueva con `body` (Markdown; el
 * primer H1 es el título, como en Hebra) en una carpeta existente por `folder?` (ruta) o
 * en la raíz por defecto. Límite de 100 000 caracteres (SPEC.md §5, «Detalle de las
 * escrituras»), comprobado ANTES de tocar el almacén: un cuerpo de sobra no debe abrir
 * siquiera la escritura.
 *
 * En una instancia lectora, `ctx.write` reenvía la creación al escritor único
 * (`../forward.ts`): el límite y la carpeta privada se comprueban aquí ANTES, con la
 * configuración de privados de ESTA instancia, y el escritor lo vuelve a comprobar con
 * esa misma configuración dentro del turno en que escribe.
 *
 * Decisión 4 de David (28 sep 2026): el MCP no le pone una etiqueta privada a ninguna
 * nota. Un cuerpo con una etiqueta privada (o descendiente) se rechaza sin crear nada,
 * con `not_found`, como una carpeta privada o inexistente. Antes de esa decisión la nota
 * se creaba y la salida decía `hidden: true`.
 */
import { ROOT_FOLDER_ID } from '../../hebra';
import { logEvent } from '../../log/logger';
import { ToolError } from '../errors';
import { usageOf, type ToolContext } from '../context';
import { CREATE_BODY_MAX_LENGTH as BODY_MAX_LENGTH } from '../../store/writes';
import { PrivacyFilter } from '../../privacy/filter';
import { mapWriteError } from './write-errors';

export interface CreateNoteOutput {
  id: string;
  title: string;
  folderPath: string;
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
    result = await ctx.write.createNote({
      body: input.body,
      folderId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    throw mapWriteError(error);
  }

  logEvent({ event: 'note.create', id: result.id });

  // Tras la ronda, con el filtro de AHORA: si la nota nueva ya no se ve (su carpeta pasó a
  // privada), la respuesta de una que no existe (C3 de la revisión de Codex). Y otra vez en la
  // puerta final (`../privacy-gate.ts`), con todo de una transacción.
  const after = await PrivacyFilter.build(ctx.port, ctx.privacyConfig);
  const meta = after.visibleMeta(result.id);
  if (!meta) throw new ToolError('not_found');
  const folderPath = after.folderPath(meta.folderId);
  const used = usageOf(ctx);
  used.note(result.id);
  used.folder(meta.folderId, folderPath);
  return { id: result.id, title: result.title, folderPath };
}
