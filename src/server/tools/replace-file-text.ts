/**
 * `hebra_replace_file_text` (D15, decidido por David el 10 oct 2026, tarea F2 de Lumbre;
 * amplía D10): sustituye el contenido ENTERO de un fichero suelto de texto (un `.base` de
 * Obsidian Bases, un `.md` o un `.json` con carpeta propia) por `text`, sobre el contenido
 * que el agente leyó con `hebra_read_file` (`expectedSha256`, su `sha256`).
 *
 * Contenido entero y no sustituciones `{find, replace}` (como `hebra_edit_note`): un
 * fichero suelto no tiene revisiones ni copia de conflicto, así que la única base que hay
 * es el hash de los bytes, y con él el reemplazo entero es exacto (el motor lo comprueba
 * en su transacción, `fileReplace` con `expectedSha256`). Un `.base` es YAML pequeño que
 * se reescribe entero también desde el editor de Bases de Hebra. Si alguien lo cambió
 * desde la lectura, `file_changed` y no se escribe: hay que volver a leerlo.
 *
 * Aquí se mira lo que no depende del almacén (el `operationId`, el hash esperado, el texto
 * y su tamaño) y la privacidad con el filtro de esta llamada; el escritor lo repite todo
 * dentro de su turno (`../../store/file-writes.ts`), con la misma configuración, también
 * si la petición le llega de un lector por `writer.sock`.
 *
 * Con `undoOperationId` en lugar de `text`, vuelve al contenido que tenía el fichero
 * antes del reemplazo con ese `operationId` (lo guarda el escritor 7 días); es un
 * reemplazo más, con su `expectedSha256` y su `operationId`.
 *
 * Logs (§6.4): `file.replace` con el id (opaco), el resultado y el estado de sync. Nunca
 * el nombre, el texto ni los hashes.
 */
import { logEvent } from '../../log/logger';
import { FileFilter } from '../../privacy/file-filter';
import { encodeFileText, FILE_TEXT_REPLACE_MAX_BYTES } from '../../store/file-content';
import type { ToolContext } from '../context';
import { ToolError } from '../errors';
import type { ReplaceFileTextOutcome } from '../write-context';
import { requireValidOperationId } from './guards';
import { mapWriteError } from './write-errors';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export async function runReplaceFileText(
  ctx: ToolContext,
  input: {
    id: string;
    expectedSha256: string;
    text?: string;
    undoOperationId?: string;
    operationId: string;
  }
): Promise<ReplaceFileTextOutcome> {
  if (!ctx.write?.replaceFileText) throw new ToolError('invalid_input');
  requireValidOperationId(input.operationId);
  if ((input.text === undefined) === (input.undoOperationId === undefined)) {
    throw new ToolError('invalid_input');
  }
  if (input.undoOperationId !== undefined) requireValidOperationId(input.undoOperationId);
  const raw = input.expectedSha256.trim().toLowerCase();
  const expectedSha256 = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw;
  if (!SHA256_HEX.test(expectedSha256)) throw new ToolError('invalid_input');
  let textBytes: number | null = null;
  if (input.text !== undefined) {
    const bytes = encodeFileText(input.text);
    if (bytes === null) throw new ToolError('invalid_input');
    if (bytes.length > FILE_TEXT_REPLACE_MAX_BYTES) {
      throw new ToolError('file_too_large', {
        byteLength: bytes.length,
        maxBytes: FILE_TEXT_REPLACE_MAX_BYTES
      });
    }
    textBytes = bytes.length;
  }

  const content = (await FileFilter.build(ctx.port, ctx.privacy, ctx.privacyConfig)).contentOf(
    input.id
  );
  if (!content || content.file.trashedAt !== null) throw new ToolError('not_found');

  let result: ReplaceFileTextOutcome;
  try {
    result = await ctx.write.replaceFileText({
      id: input.id,
      expectedSha256,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.undoOperationId !== undefined ? { undoOperationId: input.undoOperationId } : {}),
      operationId: input.operationId,
      privacy: ctx.privacyConfig
    });
  } catch (error) {
    const mapped = mapWriteError(error);
    if (mapped.code !== 'file_too_large') throw mapped;
    // El escritor no sabe qué tamaño enseñar: el del texto si es él, si no el del fichero.
    const byteLength =
      textBytes !== null && textBytes > FILE_TEXT_REPLACE_MAX_BYTES
        ? textBytes
        : content.file.byteLength;
    throw new ToolError('file_too_large', {
      ...(byteLength !== null ? { byteLength } : {}),
      maxBytes: FILE_TEXT_REPLACE_MAX_BYTES
    });
  }
  logEvent({
    event: 'file.replace',
    id: result.id,
    outcome: result.outcome,
    sync: result.sync,
    replayed: result.replayed === true
  });
  return result;
}
