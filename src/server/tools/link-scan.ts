/**
 * Extrae los `ref` en bruto (lo que va entre `[[`/`![[` y `]]`, sin alias) de un cuerpo,
 * para `hebra_links` §outgoing. El almacén guarda los enlaces YA analizados en la tabla
 * `links` (derivados al escribir), pero `HebraLibraryPort` no expone un método «enlaces
 * salientes de esta nota en bruto»: `resolveLink(ref)` necesita el `ref` ya extraído, no
 * lo da. Componer esto releyendo el cuerpo es lo único posible sin tocar `src/store`
 * (ver el informe de cierre de L1).
 *
 * Aproximación deliberada, más simple que el escáner real de Hebra
 * (`notes/markdown.ts`, vía CodeMirror): NO excluye bloques de código ni código en
 * línea, así que un `[[…]]` literal dentro de una valla de código se trataría aquí
 * como un enlace. `deriveNote` sí lo haría bien, pero solo se puede importar sin que
 * CodeMirror entre en el bundle de producción (comentario de cabecera de
 * `store/node-port.ts`); si un lote futuro ya necesita `deriveNote` en el bundle
 * (L3, para las escrituras), esto puede sustituirse por sus derivados.
 */
const LINK_PATTERN = /!?\[\[([^[\]\n]+)\]\]/gu;

/** Refs únicos, en el orden en que aparecen, ya sin el alias (`|texto`). */
export function scanOutgoingRefs(body: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of body.matchAll(LINK_PATTERN)) {
    const raw = match[1]!;
    const pipe = raw.indexOf('|');
    const ref = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}
