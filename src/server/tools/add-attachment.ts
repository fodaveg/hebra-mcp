/**
 * `hebra_add_attachment` (D9, decisión de David del 3 oct 2026): añade un adjunto al final
 * de una nota visible, como `![[sha256:H|nombre]]`, que es como Hebra adjunta. Borrar y
 * cambiar adjuntos siguen fuera del MCP.
 *
 * Antes de tocar el almacén, sin eco de la entrada:
 * - `operationId` (como `hebra_edit_note`), el nombre (`validAttachmentName`: sin `|`, `[`,
 *   `]`, `\`, `#`, saltos de línea ni controles) y el base64 (`decodeAttachmentBase64`:
 *   estricto una vez quitados espacios y saltos de línea): si no, `invalid_input`.
 * - Tamaño: más de 5 MiB decodificados, `attachment_too_large` con `byteLength` y
 *   `maxBytes`, sabido por la longitud antes de decodificar.
 * - Tipo: los MISMOS que se pueden leer, con la misma detección
 *   (`detectAttachmentType`): firma de PNG, JPEG, GIF, WebP o PDF; texto plano, Markdown,
 *   CSV o JSON en UTF-8 sin NUL si `mimeType` o la extensión lo declaran. Si no,
 *   `attachment_type_not_allowed` (con el tipo, si se sabe).
 * - La nota: visible y viva (`not_found`, igual que una inexistente) y no bloqueada
 *   (`note_locked`).
 * El escritor lo vuelve a comprobar todo dentro de su turno, con esta misma configuración
 * de privados, y guarda el blob y la referencia (`NoteWriter.addAttachmentLocal`); en un
 * lector, los bytes le llegan por `writer.sock`.
 *
 * Salida: la de una edición (`outcome`, `revision` o `copyId`, `replayed`, `sync`) más
 * `attachmentId` (el SHA-256 de los bytes) y `markdown` (la referencia añadida). La ronda
 * de después sube el blob al relé con la nota; `sync: "uploaded"` exige los dos subidos.
 *
 * Logs (§6.4): `note.attachment` con el id de la nota, el resultado y el estado de sync.
 * Nunca el nombre, el hash ni los bytes.
 */
import { logEvent } from '../../log/logger';
import {
  ATTACHMENT_MAX_BYTES,
  decodeAttachmentBase64,
  detectAttachmentType,
  validAttachmentName
} from '../../store/attachment-content';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import { ToolError } from '../errors';
import type { ToolContext } from '../context';
import type { AddAttachmentOutcome } from '../write-context';
import { requireValidOperationId, requireVisibleNote } from './guards';
import { mapWriteError } from './write-errors';

export async function runAddAttachment(
  ctx: ToolContext,
  input: { id: string; name: string; dataBase64: string; mimeType?: string; operationId: string }
): Promise<AddAttachmentOutcome> {
  if (!ctx.write) throw new ToolError('invalid_input');
  requireValidOperationId(input.operationId);
  const name = validAttachmentName(input.name);
  if (name === null) throw new ToolError('invalid_input');
  const decoded = decodeAttachmentBase64(input.dataBase64);
  if (!decoded.ok) {
    throw decoded.code === 'attachment_too_large'
      ? new ToolError('attachment_too_large', {
          byteLength: decoded.byteLength,
          maxBytes: ATTACHMENT_MAX_BYTES
        })
      : new ToolError('invalid_input');
  }
  const mimeType = input.mimeType ?? null;
  const detected = detectAttachmentType(decoded.bytes, mimeType, name);
  if (!detected.allowed) {
    throw new ToolError(
      'attachment_type_not_allowed',
      detected.mimeType ? { mimeType: detected.mimeType } : undefined
    );
  }

  requireVisibleNote(ctx, input.id);
  const note = await ctx.port.noteRead(input.id);
  if (!note || note.trashedAt !== null) throw new ToolError('not_found');
  if (note.body.startsWith(LOCKED_BODY_PREFIX)) throw new ToolError('note_locked');

  let result: AddAttachmentOutcome;
  try {
    result = await ctx.write.addAttachment({
      id: input.id,
      name: input.name,
      bytes: decoded.bytes,
      mimeType,
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    const mapped = mapWriteError(error);
    // El escritor no sabe el tamaño que pide la salida: se pone aquí.
    throw mapped.code === 'attachment_too_large'
      ? new ToolError('attachment_too_large', {
          byteLength: decoded.bytes.length,
          maxBytes: ATTACHMENT_MAX_BYTES
        })
      : mapped;
  }
  logEvent({
    event: 'note.attachment',
    id: input.id,
    outcome: result.outcome,
    sync: result.sync,
    replayed: result.replayed === true
  });
  return result;
}
