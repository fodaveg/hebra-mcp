/**
 * `hebra_status` (SPEC.md §5): sin contenido de notas, así que no pasa por el filtro de
 * privados más que el `privacy_config_unresolved` común a toda herramienta (§6.3),
 * aplicado por el registro de herramientas, no aquí.
 */
import type { ToolContext } from '../context';
import type { HebraStatus } from '../../status/status-source';

export async function runStatus(ctx: ToolContext): Promise<HebraStatus> {
  return ctx.status.getStatus();
}
