/**
 * Enlaces salientes de un cuerpo, para `hebra_links` §outgoing (SPEC.md §5). Antes esto
 * era un regex propio sobre el texto en bruto: no excluía vallas de código, así que un
 * `[[…]]` literal dentro de un bloque de código se trataba como un enlace, a diferencia
 * de Hebra (hallazgo del coordinador, 26 sep 2026).
 *
 * Ahora usa `deriveNote(body).links` (`library/derive` de Hebra, reexportado por
 * `../../hebra` vía `src/store/index.ts`): el MISMO analizador que usa Hebra para derivar (vía
 * `notes/markdown.ts`/CodeMirror, que SÍ excluye código), así que un enlace dentro de
 * una valla de código no cuenta aquí tampoco. Ya no arrastra CodeMirror al bundle por
 * primera vez: `src/store/writes.ts` (L3, `hebra_create_note`/`hebra_append_to_note`)
 * ya lo necesita y ya está en `dist/` (comentario de cabecera de `store/node-port.ts`).
 *
 * `DerivedLink` da el destino YA ANALIZADO (`targetKind`/`target`/`targetPath`), no el
 * texto tal cual se escribió entre `[[` y `]]`: `refOf` lo reconstruye a la MISMA forma
 * que `parseLinkRef` (`library/derive` de Hebra) sabe volver a analizar, para que
 * `HebraLibraryPort.resolveLink(ref)` (que solo acepta esa forma) lo resuelva. Un
 * enlace con alias (`[[Título|Alias]]`) pierde el alias en el `ref`: SPEC.md §5 ya lo
 * pide así («sin alias»).
 */
import type { DerivedLink } from '../../hebra';
import { deriveNote } from '../../store';

function refOf(link: DerivedLink): string {
  switch (link.targetKind) {
    case 'id':
      return `id:${link.target}`;
    case 'blob':
      return `sha256:${link.target}`;
    case 'title':
    case 'file':
      return link.targetPath ? `${link.targetPath}/${link.target}` : link.target;
  }
}

/** Refs únicos, en el orden en que los derivó `deriveNote` (ya sin duplicados: ver su
 *  `seenLinks`). */
export function scanOutgoingRefs(body: string): string[] {
  return deriveNote(body).links.map(refOf);
}
