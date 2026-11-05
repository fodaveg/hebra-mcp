/**
 * Los filtros de `hebra_search` que pasan a `SearchFilters` del motor (D23, SPEC.md §5, §6.3):
 * `props`, `linksTo` y `titleOnly`. `props` y `titleOnly` solo miran la fila de cada nota, y lo
 * oculto lo quita `accept` como siempre. `linksTo` necesita más, porque el motor resuelve el título
 * contra TODAS las notas vivas:
 * - Un enlace `[[Título]]` de una nota visible casa aunque esa nota con ese título sea oculta: con
 *   el motor solo, «¿hay alguna nota con este título?» se contesta distinto si hay una oculta.
 * - Una homónima oculta de una visible cambia el resultado: `[[id:…]]` hacia la oculta casa, y
 *   la visible que se enlaza a sí misma por título también (solo se descuenta el enlace a sí
 *   misma respecto de CADA destino, y la oculta es otro destino).
 *
 * Por eso los destinos se resuelven aquí, solo entre las visibles, y lo que vale es lo que los
 * enlaza según `backlinks` del motor (la misma regla: por id o por título, sin la propia nota),
 * nota a nota. El filtro del motor se sigue pasando como prefiltro para no recorrer todos los
 * aciertos del texto. Sin destino visible, lista vacía, igual con una privada que con una que no
 * existe y sin consultar nada más.
 */
import type { SearchFilters } from '../../hebra';
import { usageOf, type ToolContext } from '../context';
import { STORE_PAGE_MAX } from '../pagination';

export interface SearchExtraInput {
  props?: ReadonlyArray<{ key: string; value: string | null }>;
  linksTo?: readonly string[];
  titleOnly?: boolean;
}

export interface SearchExtra {
  filters: Pick<SearchFilters, 'props' | 'linksTo' | 'titleOnly'>;
  /** Con `linksTo`: las notas que enlazan a un destino visible de cada título. */
  linkSources: ReadonlySet<string> | null;
}

/** Las notas que enlazan a algún destino VISIBLE de `title`, o `null` si no tiene ninguno. */
async function sourcesOfTitle(ctx: ToolContext, title: string): Promise<Set<string> | null> {
  const targets = (await ctx.port.notesByFoldedTitle(title)).filter(
    (id) => ctx.privacy.visibleMeta(id) !== undefined
  );
  if (targets.length === 0) return null;
  const sources = new Set<string>();
  for (const target of targets) {
    // Decide el resultado por estar visible, sin enseñar nada de su fila.
    usageOf(ctx).noteVisible(target);
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof ctx.port.backlinks>> = await ctx.port.backlinks(target, cursor, STORE_PAGE_MAX);
      for (const item of page.items) sources.add(item.id);
      cursor = page.nextCursor;
    } while (cursor);
  }
  return sources;
}

/** Los filtros para el motor; `null` si `linksTo` deja la búsqueda vacía. Sin ninguno de estos
 *  parámetros, nada que añadir y ninguna consulta de más. */
export async function resolveSearchExtra(
  ctx: ToolContext,
  input: SearchExtraInput
): Promise<SearchExtra | null> {
  const filters: SearchExtra['filters'] = {
    ...(input.props?.length ? { props: input.props.map((prop) => ({ ...prop })) } : {}),
    ...(input.linksTo?.length ? { linksTo: [...input.linksTo] } : {}),
    ...(input.titleOnly ? { titleOnly: true } : {})
  };
  if (!input.linksTo?.length) return { filters, linkSources: null };
  // Varios títulos se combinan con Y, como en el motor.
  const perTitle: Array<Set<string>> = [];
  for (const title of input.linksTo) {
    const sources = await sourcesOfTitle(ctx, title);
    if (!sources) return null;
    perTitle.push(sources);
  }
  const linkSources = new Set(
    [...perTitle[0]!].filter((id) => perTitle.every((sources) => sources.has(id)))
  );
  return linkSources.size > 0 ? { filters, linkSources } : null;
}
