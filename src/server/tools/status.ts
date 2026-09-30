/**
 * `hebra_status` (SPEC.md §5): sin contenido de notas, así que no pasa por el filtro de
 * privados más que el `privacy_config_unresolved` común a toda herramienta (§6.3),
 * aplicado por el registro de herramientas, no aquí.
 */
import type { ToolContext } from '../context';
import type { HebraStatus } from '../../status/status-source';
import { buildCapabilities, type Capabilities } from '../capabilities';

/** `capabilities` (SPEC.md §5): qué hace el servidor, sus límites y lo que no permite,
 *  sin nombres privados ni contenido. `serverVersion` es el de `buildMcpServer`. */
export async function runStatus(
  ctx: ToolContext,
  serverVersion = 'unknown'
): Promise<HebraStatus & { capabilities: Capabilities }> {
  const status = await ctx.status.getStatus();
  return { ...status, capabilities: buildCapabilities(serverVersion, ctx.privacyConfig) };
}
