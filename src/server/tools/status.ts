/**
 * `hebra_status` (SPEC.md §5): sin contenido de notas, así que no pasa por el filtro de
 * privados más que el `privacy_config_unresolved` común a toda herramienta (§6.3),
 * aplicado por el registro de herramientas, no aquí. Por eso se registra con
 * `privacyLoad: 'lazy'` (A9b del plan de memoria) sin cargar ninguna nota: ese error solo
 * depende de las carpetas y de la configuración.
 */
import type { ToolContext } from '../context';
import type { HebraStatus } from '../../status/status-source';
import { AGENT_REVOKED_REASON } from '../../status/pairing-revocation';
import { buildCapabilities, type Capabilities } from '../capabilities';

/** `capabilities` (SPEC.md §5): qué hace el servidor, sus límites y lo que no permite,
 *  sin nombres privados ni contenido. `serverVersion` es el de `buildMcpServer`.
 *  Con `revoked: true`, `revokedReason` dice qué pasó y qué hacer (SPEC.md §12.9, D24): si
 *  quien da el estado no trae otro, el del agente revocado o desactivado desde Hebra, que se
 *  recupera solo al reactivarlo; si no está revocado, no aparece. */
export async function runStatus(
  ctx: ToolContext,
  serverVersion = 'unknown',
  /** Aperturas fallidas de espacios con concesión en este proceso, por código
   *  (`SpaceRouter.errorCounts`): se suman a `errorsByCode`, que si no solo cuenta el sync y
   *  diría `{}` con un espacio que no abre. */
  spaceErrors: Record<string, number> = {}
): Promise<HebraStatus & { revokedReason?: string; capabilities: Capabilities }> {
  const status = await ctx.status.getStatus();
  const reason = status.revoked === true ? { revokedReason: status.revokedReason ?? AGENT_REVOKED_REASON } : {};
  const errorsByCode = mergeCounts(status.errorsByCode, spaceErrors);
  return { ...status, errorsByCode, ...reason, capabilities: buildCapabilities(serverVersion, ctx.privacyConfig) };
}

/** `base` más `extra`, código a código. Sin nada que sumar, `base` tal cual (también `null`). */
function mergeCounts(
  base: Record<string, number> | null,
  extra: Record<string, number>
): Record<string, number> | null {
  const entries = Object.entries(extra).filter(([, count]) => count > 0);
  if (entries.length === 0) return base;
  const merged: Record<string, number> = { ...(base ?? {}) };
  for (const [code, count] of entries) merged[code] = (merged[code] ?? 0) + count;
  return merged;
}
