/**
 * Recomprobar la visibilidad sobre la fila que se devuelve (C1 y C2 de la revisión de Codex
 * del 11 oct 2026, decisión de la sesión principal; SPEC.md §6.3, «Cuándo se evalúa»).
 *
 * El filtro de una llamada (`resolveToolContext`) se construye al empezar, y la herramienta
 * lee después la nota, la página o los bytes. Entre las dos cosas el sync (u otro proceso)
 * puede ponerle a la nota una etiqueta privada, bloquearla o moverla a una carpeta privada,
 * y lo leído salía con el filtro de antes. Por eso, antes de responder, cada herramienta que
 * devuelve contenido de una nota llama a `recheck` con las filas que va a devolver: el árbol
 * de carpetas, el índice de visibilidad y el sello de esas filas (`local_seq` de una
 * `NoteRow`, o `updated_at` de un elemento de lista) se leen en UNA transacción de lectura
 * (`HebraLibraryPort.privacyRecheck`), DESPUÉS de la lectura. Una fila sale solo si:
 * - con ese filtro es visible, y
 * - su sello sigue siendo el de la fila leída: si cambió entre la lectura y la
 *   recomprobación, lo leído es de una fila que ya no existe tal cual y que pudo ser privada
 *   cuando se leyó, así que no sale (cerrado ante la duda). Coste asumido: una nota visible
 *   que se edita justo en ese instante falta de esa respuesta (la siguiente la trae).
 *
 * Es la vía «recomprobar la fila leída» de la decisión, no la de leer todo en una misma
 * transacción: las lecturas del motor van cada una en su turno de la cola y algunas
 * (`noteRead`, la búsqueda) son del motor, que no se puede envolver sin tocar Hebra.
 */
import { PrivacyFilter } from '../privacy/filter';
import { ToolError } from './errors';
import type { ToolContext } from './context';

/** Una fila que se va a devolver: su id y, si se sabe, su sello tal como se leyó. */
export interface ReturnedRow {
  id: string;
  localSeq?: number;
  updatedAt?: number;
}

export interface Recheck {
  /** El filtro de AHORA (después de la lectura), para la carpeta y las etiquetas que se
   *  enseñan. */
  filter: PrivacyFilter;
  /** ¿Es visible AHORA y es la misma fila que se leyó? Con un id suelto, solo lo primero. */
  visible(row: ReturnedRow | string): boolean;
}

/** El filtro y los sellos de después de leer `rows` (ver la cabecera). Una configuración
 *  que ya no se puede aplicar: `privacy_config_unresolved`. */
export async function recheck(ctx: ToolContext, rows: readonly ReturnedRow[]): Promise<Recheck> {
  const snapshot = await ctx.port.privacyRecheck(rows.map((row) => row.id));
  const filter = PrivacyFilter.fromSnapshot(snapshot.folders, snapshot.notes, ctx.privacyConfig);
  if (filter.unresolved) throw new ToolError('privacy_config_unresolved');
  return {
    filter,
    visible(row) {
      const wanted: ReturnedRow = typeof row === 'string' ? { id: row } : row;
      if (!filter.visibleMeta(wanted.id)) return false;
      if (wanted.localSeq === undefined && wanted.updatedAt === undefined) return true;
      const stamp = snapshot.stamps.get(wanted.id);
      if (!stamp) return false;
      if (wanted.localSeq !== undefined && stamp.localSeq !== wanted.localSeq) return false;
      if (wanted.updatedAt !== undefined && stamp.updatedAt !== wanted.updatedAt) return false;
      return true;
    }
  };
}

/** `recheck` de una sola fila que tiene que seguir visible: si no, `not_found`, la respuesta
 *  de una nota que no existe. */
export async function requireStillVisible(ctx: ToolContext, row: ReturnedRow): Promise<Recheck> {
  const check = await recheck(ctx, [row]);
  if (!check.visible(row)) throw new ToolError('not_found');
  return check;
}
