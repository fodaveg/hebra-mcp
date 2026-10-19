/**
 * Johnny.Decimal con el motor de jdex-manager (D18, decisión de David del 19 oct 2026, sobre
 * el contrato cerrado con la sesión de jdex-manager; SPEC.md §5):
 *
 * - `hebra_jd_new_id`: un ID nuevo dentro de una categoría que ya existe, en dos pasos
 *   obligatorios, como `hebra_replace_in_notes`. `mode: "simulate"` (`category`, `title` y,
 *   opcionales, `systemId`, `createFolder`, `jdexFolderId`, `templatesFolderId`) no escribe
 *   nada: guarda el plan en el escritor y devuelve el `planId`, el ID, los nombres, las
 *   carpetas resueltas, de dónde sale la plantilla y lo que se va a escribir (la nota con su
 *   cuerpo y la carpeta). `mode: "apply"` (`planId` y un `operationId` nuevo) aplica
 *   EXACTAMENTE ese plan; reintentar con el mismo `operationId` completa lo que falte sin
 *   duplicar. Categorías, áreas, hijos «+» y mover, fuera.
 * - `hebra_jd_audit`: la auditoría del motor sobre lo visible, en solo lectura y en esta
 *   instancia (`../../store/jd-audit.ts`), paginada.
 *
 * Todo con la configuración de privados de ESTA instancia: lo privado no existe para el MCP.
 * Una categoría con algo oculto no admite IDs nuevos (`category_has_hidden`, uno solo para
 * todo), y ningún error, recuento ni mensaje dice qué está oculto ni qué número está ocupado:
 * los errores del motor salen con su código y sin su mensaje.
 *
 * Logs (§6.4): `jd.new_id` con el modo, si creó algo, `replayed` y el estado de sync, y
 * `jd.audit` con el número de hallazgos. Nunca la categoría, el título, nombres ni ids.
 */
import { logEvent } from '../../log/logger';
import { runJdAudit, JD_AUDIT_NOT_CHECKED, type JdAuditFinding } from '../../store/jd-audit';
import { JD_TITLE_MAX_LENGTH, type JdNewIdRequest } from '../../store/jd-new-id';
import { afterGate, usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { effectiveLimit, LIMITS, slicePage } from '../pagination';
import type { JdNewIdOutcome } from '../write-context';
import { requireValidOperationId } from './guards';
import { mapWriteError } from './write-errors';

export interface JdNewIdInput {
  mode: 'simulate' | 'apply';
  category?: string;
  title?: string;
  systemId?: string;
  createFolder?: boolean;
  jdexFolderId?: string;
  templatesFolderId?: string;
  planId?: string;
  operationId?: string;
}

/** Los campos de cada modo (además de `mode`): uno de otro modo, o uno que falte,
 *  `invalid_input`. */
const FIELDS: Record<JdNewIdInput['mode'], ReadonlySet<string>> = {
  simulate: new Set(['category', 'title', 'systemId', 'createFolder', 'jdexFolderId', 'templatesFolderId']),
  apply: new Set(['planId', 'operationId'])
};

function requestOf(input: JdNewIdInput, ctx: ToolContext): JdNewIdRequest {
  const allowed = FIELDS[input.mode];
  if (!allowed) throw new ToolError('invalid_input');
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'mode' && value !== undefined && !allowed.has(key)) throw new ToolError('invalid_input');
  }
  const privacy = ctx.privacyConfig;
  if (input.mode === 'apply') {
    if (typeof input.planId !== 'string' || input.planId.length === 0) throw new ToolError('invalid_input');
    if (typeof input.operationId !== 'string') throw new ToolError('invalid_input');
    requireValidOperationId(input.operationId);
    return { mode: 'apply', planId: input.planId, operationId: input.operationId, privacy };
  }
  if (typeof input.category !== 'string' || !/^\d{2}$/u.test(input.category)) throw new ToolError('invalid_input');
  if (typeof input.title !== 'string' || input.title.length > JD_TITLE_MAX_LENGTH) throw new ToolError('invalid_input');
  return {
    mode: 'simulate',
    category: input.category,
    title: input.title,
    ...(input.systemId !== undefined ? { systemId: input.systemId } : {}),
    ...(input.createFolder !== undefined ? { createFolder: input.createFolder } : {}),
    ...(input.jdexFolderId !== undefined ? { jdexFolderId: input.jdexFolderId } : {}),
    ...(input.templatesFolderId !== undefined ? { templatesFolderId: input.templatesFolderId } : {}),
    privacy
  };
}

/**
 * Lo que nombra la respuesta, para la puerta final (`../privacy-gate.ts`): en la simulación,
 * las carpetas resueltas, la de la categoría, la nota de la plantilla y las carpetas donde se
 * va a escribir (si algo de eso deja de verse, o cambia la biblioteca, se repite entera); al
 * aplicar, la nota y la carpeta que dice el informe (si ya no se ven tras la ronda, la
 * respuesta de algo que no existe).
 */
function declareUsage(ctx: ToolContext, outcome: Exclude<JdNewIdOutcome, { mode: 'discard' }>): void {
  const used = usageOf(ctx);
  if (outcome.mode === 'apply') {
    for (const item of [...outcome.created, ...outcome.existing]) {
      if (item.kind === 'note') used.note(item.id);
      else used.folder(item.id);
    }
    return;
  }
  used.folder(outcome.resolved.jdex.id);
  if (outcome.resolved.templates) used.folder(outcome.resolved.templates.id);
  if (outcome.category.folderId !== null) used.folder(outcome.category.folderId);
  if (outcome.template.noteId !== undefined) used.note(outcome.template.noteId);
  for (const write of outcome.writes) {
    if (write.kind === 'ensure_note') used.folder(write.folderId);
    else if ('folderId' in write.parent) used.folder(write.parent.folderId);
  }
}

/** `hebra_jd_new_id` (ver la cabecera). */
export async function runJdNewId(
  ctx: ToolContext,
  input: JdNewIdInput
): Promise<Exclude<JdNewIdOutcome, { mode: 'discard' }>> {
  if (!ctx.write?.jdNewId) throw new ToolError('invalid_input');
  const request = requestOf(input, ctx);
  let outcome: JdNewIdOutcome;
  try {
    outcome = await ctx.write.jdNewId(request);
  } catch (error) {
    throw mapWriteError(error);
  }
  if (outcome.mode === 'discard') throw new ToolError('invalid_input');
  declareUsage(ctx, outcome);
  if (outcome.mode === 'simulate') {
    // Una simulación se repite si la puerta final no pasa: su log, solo del intento que sale.
    afterGate(ctx, () => logEvent({ event: 'jd.new_id', mode: 'simulate' }));
  } else {
    logEvent({
      event: 'jd.new_id',
      mode: 'apply',
      created: outcome.created.length,
      replayed: outcome.replayed === true,
      sync: outcome.sync
    });
  }
  return outcome;
}

export interface JdAuditInput {
  jdexFolderId?: string;
  templatesFolderId?: string;
  limit?: number;
  cursor?: string;
}

export interface JdAuditOutput {
  resolved: { jdex: { id: string; name: string }; templates: { id: string; name: string } | null };
  findings: JdAuditFinding[];
  /** Hallazgos que cuentan como problema (sin los informativos), de toda la auditoría. */
  problems: number;
  /** Comprobaciones del motor que esta auditoría no hace (SPEC.md §5). */
  notChecked: string[];
  nextCursor: string | null;
}

/** `hebra_jd_audit` (ver la cabecera): solo lectura, sin pasar por el escritor. */
export async function runJdAuditTool(ctx: ToolContext, input: JdAuditInput): Promise<JdAuditOutput> {
  const limit = effectiveLimit(input.limit, LIMITS.jdAudit);
  let result;
  try {
    result = await runJdAudit(ctx.port, ctx.privacy, ctx.privacyConfig, {
      ...(input.jdexFolderId !== undefined ? { jdexFolderId: input.jdexFolderId } : {}),
      ...(input.templatesFolderId !== undefined ? { templatesFolderId: input.templatesFolderId } : {})
    });
  } catch (error) {
    throw mapWriteError(error);
  }
  const used = usageOf(ctx);
  used.folder(result.resolved.jdex.id);
  if (result.resolved.templates) used.folder(result.resolved.templates.id);
  const page = slicePage(result.findings, 'j1', {
    limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  });
  afterGate(ctx, () => logEvent({ event: 'jd.audit', findings: page.items.length }));
  return {
    resolved: result.resolved,
    findings: page.items,
    problems: result.problems,
    notChecked: [...JD_AUDIT_NOT_CHECKED],
    nextCursor: page.nextCursor
  };
}
