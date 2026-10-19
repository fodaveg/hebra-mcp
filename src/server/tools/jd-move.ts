/**
 * `hebra_jd_move` (D19, decisión de David del 19 oct 2026: «deberia entrar el move, no?»;
 * SPEC.md §5): archivar una nota, un fichero suelto o una carpeta dentro de la carpeta de un
 * ID del JDex (o de una subcarpeta suya, que se crea si falta), con el motor de mover de
 * jdex-manager. Es la única vía del MCP para mover carpetas: no hay un `hebra_move_folder`
 * genérico, y `hebra_move_note` y `hebra_move_file` no cambian. Tres pasos:
 *
 * - `mode: "simulate"` (`kind` y `id` de lo que se mueve, `toId`, y opcionales `subfolder`,
 *   `as`, `systemId`, `jdexFolderId`): no escribe nada; guarda el plan en el escritor y
 *   devuelve el `planId` y el plan legible (qué, de dónde, a dónde, con qué nombre y qué
 *   carpetas se crean).
 * - `mode: "apply"` (`planId` y un `operationId` nuevo): aplica EXACTAMENTE ese plan;
 *   reintentar con el mismo `operationId` no repite nada y completa lo que falte.
 * - `mode: "undo"` (`planId` aplicado y un `operationId` nuevo), durante 7 días: devuelve cada
 *   pieza a su sitio si sigue donde la dejó; si no, `skipped` con su motivo.
 *
 * Todo en el escritor (`../../store/jd-move.ts`; un lector lo reenvía), con la configuración
 * de privados de ESTA instancia: lo oculto no existe. Una carpeta solo se rechaza por la
 * configuración, con la regla y el error de `hebra_rename_folder` (`folder_unavailable`), y lo
 * oculto que tenga dentro viaja con ella sin que el agente lo sepa (revisión de seguridad del
 * 19 oct 2026); una nota o un fichero que el destino dejaría oculto, `destination_unavailable`,
 * sin decir por qué. Aquí solo se valida la entrada, sin eco.
 *
 * Logs (§6.4): `jd.move` con el modo, el tipo de pieza (al simular), números, `replayed` y el
 * estado de sync. Nunca ids, nombres ni rutas.
 */
import { logEvent } from '../../log/logger';
import { JD_MOVE_NAME_MAX_LENGTH, type JdMoveItem, type JdMoveKind, type JdMoveRequest } from '../../store/jd-move';
import { afterGate, usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import type { JdMoveOutcome } from '../write-context';
import { requireValidOperationId } from './guards';
import { mapWriteError } from './write-errors';

export interface JdMoveInput {
  mode: 'simulate' | 'apply' | 'undo';
  kind?: JdMoveKind;
  id?: string;
  toId?: string;
  subfolder?: string;
  as?: string;
  systemId?: string;
  jdexFolderId?: string;
  planId?: string;
  operationId?: string;
}

/** Los campos de cada modo (además de `mode`): uno de otro modo, o uno que falte,
 *  `invalid_input`. */
const FIELDS: Record<JdMoveInput['mode'], ReadonlySet<string>> = {
  simulate: new Set(['kind', 'id', 'toId', 'subfolder', 'as', 'systemId', 'jdexFolderId']),
  apply: new Set(['planId', 'operationId']),
  undo: new Set(['planId', 'operationId'])
};

function requestOf(input: JdMoveInput, ctx: ToolContext): JdMoveRequest {
  const allowed = FIELDS[input.mode];
  if (!allowed) throw new ToolError('invalid_input');
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'mode' && value !== undefined && !allowed.has(key)) throw new ToolError('invalid_input');
  }
  const privacy = ctx.privacyConfig;
  if (input.mode !== 'simulate') {
    if (typeof input.planId !== 'string' || input.planId.length === 0) throw new ToolError('invalid_input');
    if (typeof input.operationId !== 'string') throw new ToolError('invalid_input');
    requireValidOperationId(input.operationId);
    return { mode: input.mode, planId: input.planId, operationId: input.operationId, privacy };
  }
  if (input.kind !== 'note' && input.kind !== 'file' && input.kind !== 'folder') throw new ToolError('invalid_input');
  if (typeof input.id !== 'string' || input.id.length === 0) throw new ToolError('invalid_input');
  if (typeof input.toId !== 'string' || input.toId.length === 0 || input.toId.length > 32) throw new ToolError('invalid_input');
  for (const text of [input.subfolder, input.as]) {
    if (text !== undefined && text.length > JD_MOVE_NAME_MAX_LENGTH) throw new ToolError('invalid_input');
  }
  return {
    mode: 'simulate',
    source: { kind: input.kind, id: input.id },
    toId: input.toId,
    ...(input.subfolder !== undefined ? { subfolder: input.subfolder } : {}),
    ...(input.as !== undefined ? { as: input.as } : {}),
    ...(input.systemId !== undefined ? { systemId: input.systemId } : {}),
    ...(input.jdexFolderId !== undefined ? { jdexFolderId: input.jdexFolderId } : {}),
    privacy
  };
}

/** Una pieza que nombra la respuesta, por su tipo. */
function declarePiece(ctx: ToolContext, piece: { kind: JdMoveKind; id: string }): void {
  const used = usageOf(ctx);
  if (piece.kind === 'note') used.note(piece.id);
  else if (piece.kind === 'file') used.file(piece.id);
  else used.folder(piece.id);
}

/**
 * Lo que nombra la respuesta, para la puerta final (`../privacy-gate.ts`): al simular, la
 * pieza, la carpeta de donde sale, la de destino si existe y el JDex (si algo de eso deja de
 * verse o cambia la biblioteca, se repite entera); al aplicar o deshacer, las piezas y las
 * carpetas del informe (si ya no se ven tras la ronda, la respuesta de algo que no existe).
 */
function declareUsage(ctx: ToolContext, outcome: Exclude<JdMoveOutcome, { mode: 'discard' }>): void {
  const used = usageOf(ctx);
  if (outcome.mode === 'simulate') {
    declarePiece(ctx, outcome.move);
    used.folder(outcome.jdex.id);
    for (const place of [outcome.move.from, outcome.move.to]) if (place.folderId !== null) used.folder(place.folderId);
    return;
  }
  const pieces: JdMoveItem[] =
    outcome.mode === 'apply'
      ? [...outcome.moved, ...outcome.alreadyDone]
      : [...outcome.restored, ...outcome.alreadyRestored, ...outcome.skipped];
  for (const piece of pieces) declarePiece(ctx, piece);
  if (outcome.mode === 'apply') for (const folder of [...outcome.created, ...outcome.existing]) used.folder(folder.id);
}

/** `hebra_jd_move` (ver la cabecera). */
export async function runJdMove(
  ctx: ToolContext,
  input: JdMoveInput
): Promise<Exclude<JdMoveOutcome, { mode: 'discard' }>> {
  if (!ctx.write?.jdMove) throw new ToolError('invalid_input');
  const request = requestOf(input, ctx);
  let outcome: JdMoveOutcome;
  try {
    outcome = await ctx.write.jdMove(request);
  } catch (error) {
    throw mapWriteError(error);
  }
  if (outcome.mode === 'discard') throw new ToolError('invalid_input');
  declareUsage(ctx, outcome);
  if (outcome.mode === 'simulate') {
    // Se repite si la puerta final no pasa: su log, solo del intento que sale.
    afterGate(ctx, () => logEvent({ event: 'jd.move', mode: 'simulate', kind: outcome.move.kind }));
  } else if (outcome.mode === 'apply') {
    logEvent({
      event: 'jd.move',
      mode: 'apply',
      created: outcome.created.length,
      moved: outcome.moved.length,
      replayed: outcome.replayed === true,
      sync: outcome.sync
    });
  } else {
    logEvent({
      event: 'jd.move',
      mode: 'undo',
      restored: outcome.restored.length,
      skipped: outcome.skipped.length,
      replayed: outcome.replayed === true,
      sync: outcome.sync
    });
  }
  return outcome;
}
