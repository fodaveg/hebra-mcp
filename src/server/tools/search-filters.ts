/**
 * Los filtros de `hebra_search` que pasan a `SearchFilters` del motor (D23, SPEC.md §5, §6.3):
 * `props`, `linksTo` y `titleOnly`. `props` y `titleOnly` solo miran la fila de cada nota, y lo
 * oculto lo quita `accept` como siempre. `linksTo` necesita más, porque el motor resuelve el título
 * contra TODAS las notas vivas:
 * - Un enlace `[[Título]]` de una nota visible casa aunque esa nota con ese título sea oculta: con
 *   el motor solo, si hay alguna nota con este título se contesta distinto con una oculta.
 * - Una homónima oculta de una visible cambia el resultado: `[[id:…]]` hacia la oculta casa, y
 *   la visible que se enlaza a sí misma por título también (solo se descuenta el enlace a sí
 *   misma respecto de CADA destino, y la oculta es otro destino).
 *
 * Por eso los destinos se resuelven aquí, solo entre las visibles, y lo que vale es lo que los
 * enlaza con la regla de `backlinks` del motor (por id o por título, sin la propia nota), en una
 * sola consulta. El filtro del motor se sigue pasando como prefiltro para no recorrer todos los
 * aciertos del texto. Sin destino visible, lista vacía, igual con una privada que con una que no
 * existe y sin consultar nada más.
 *
 * Filtros repetidos: el mismo par de clave y valor (con el plegado del motor) o el mismo título no
 * cambian el resultado y sí multiplicarían las subconsultas, así que se pasan una vez.
 */
import { foldFileName, type SearchFilters } from '../../hebra';
import { usageOf, type ToolContext } from '../context';

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
  const candidates = await ctx.port.notesByFoldedTitle(title);
  // `privacyLoad: 'lazy'` (A4): las homónimas, antes de juzgarlas.
  await ctx.privacy.ensure(candidates);
  const targets = candidates.filter((id) => ctx.privacy.visibleMeta(id) !== undefined);
  if (targets.length === 0) return null;
  // Deciden el resultado por estar visibles, sin enseñar nada de su fila.
  for (const target of targets) usageOf(ctx).noteVisible(target);
  return new Set(await ctx.port.linkSources(targets));
}

/** Los pares distintos, sin distinguir lo que el motor no distingue. */
function distinctProps(props: NonNullable<SearchExtraInput['props']>): Array<{ key: string; value: string | null }> {
  const seen = new Map<string, { key: string; value: string | null }>();
  for (const prop of props) {
    const id = JSON.stringify([prop.key.toLowerCase(), prop.value === null ? null : foldFileName(prop.value)]);
    if (!seen.has(id)) seen.set(id, { ...prop });
  }
  return [...seen.values()];
}

/** Los títulos distintos, con el mismo plegado. */
function distinctTitles(titles: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const title of titles) {
    const id = foldFileName(title);
    if (!seen.has(id)) seen.set(id, title);
  }
  return [...seen.values()];
}

/** Los filtros para el motor; `null` si `linksTo` deja la búsqueda vacía. Sin ninguno de estos
 *  parámetros, nada que añadir y ninguna consulta de más. */
export async function resolveSearchExtra(
  ctx: ToolContext,
  input: SearchExtraInput
): Promise<SearchExtra | null> {
  const titles = input.linksTo?.length ? distinctTitles(input.linksTo) : [];
  const filters: SearchExtra['filters'] = {
    ...(input.props?.length ? { props: distinctProps(input.props) } : {}),
    ...(titles.length > 0 ? { linksTo: titles } : {}),
    ...(input.titleOnly ? { titleOnly: true } : {})
  };
  if (titles.length === 0) return { filters, linkSources: null };
  // Varios títulos se combinan con Y, como en el motor.
  const perTitle: Array<Set<string>> = [];
  for (const title of titles) {
    const sources = await sourcesOfTitle(ctx, title);
    if (!sources) return null;
    perTitle.push(sources);
  }
  const linkSources = new Set(
    [...perTitle[0]!].filter((id) => perTitle.every((sources) => sources.has(id)))
  );
  return linkSources.size > 0 ? { filters, linkSources } : null;
}
