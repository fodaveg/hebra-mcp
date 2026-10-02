/**
 * Paginación común de las herramientas que devuelven listas (SPEC.md §5, «Paginación»).
 * Misma semántica en todas: `limit` opcional, `cursor` opaco opcional, `nextCursor`
 * `null` cuando no hay más. Dos formas de cursor:
 *
 * - POSICIONAL (`fillPage`): sobre una lista del almacén ordenada por clave (notas,
 *   búsqueda, backlinks). El cursor es la clave de la ÚLTIMA nota visible devuelta, así
 *   que reanuda exactamente tras ella aunque entre medias haya notas ocultas: una página
 *   se rellena hasta `limit` con notas VISIBLES y su `nextCursor` solo existe si hay una
 *   visible más (se mira una por delante). Ni el tamaño de una página ni la presencia del
 *   cursor dependen de cuántas notas privadas hay (§6.3).
 * - SOBRE UNA LISTA CALCULADA (`slicePage`): etiquetas, carpetas y enlaces salientes, que
 *   ya salen filtrados y en memoria. El cursor lleva la clave del último elemento (o su
 *   posición, cuando no hay clave única).
 *
 * El contenido del cursor es un detalle interno, envuelto con un prefijo por herramienta
 * para que un cursor de una no se acepte en otra (`invalid_input`).
 */
import { ToolError } from './errors';

/** Máximos de `limit` por herramienta. `null` en el valor por defecto: sin `limit`, todo
 *  (como antes de que estas herramientas paginaran). */
export const LIMITS = {
  search: { default: 20, max: 50 },
  listNotes: { default: 50, max: 100 },
  links: { default: null, max: 200 },
  listTags: { default: null, max: 500 },
  listFolders: { default: null, max: 500 },
  listTrash: { default: 50, max: 100 },
  listVersions: { default: 50, max: 200 },
  listAttachments: { default: null, max: 200 }
} as const;

/** Máximo de elementos que el motor devuelve por consulta de página (`PAGE_LIMIT_MAX` de
 *  `sqlite-engine.ts`: `search`, `notesPage` y `backlinks` lo aplican con `clampLimit`). */
export const STORE_PAGE_MAX = 200;

/** Tamaño de página que se pide al almacén: `want` (lo que falta más uno) acotado a
 *  `[1, STORE_PAGE_MAX]`. `want` puede ser infinito (sin `limit`). */
export function storePageSize(want: number): number {
  return Math.min(Math.max(want, 1), STORE_PAGE_MAX);
}

export type CursorKind = 'n1' | 's1' | 'l1' | 't1' | 'f1' | 'r1' | 'v1' | 'a1';

const CURSOR_MAX_LENGTH = 2_048;

export function wrapCursor(kind: CursorKind, payload: string): string {
  return `${kind}.${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

/** Deshace `wrapCursor`; un cursor de otra herramienta o ilegible: `invalid_input`. */
export function unwrapCursor(kind: CursorKind, cursor: string): string {
  const prefix = `${kind}.`;
  if (cursor.length > CURSOR_MAX_LENGTH || !cursor.startsWith(prefix)) {
    throw new ToolError('invalid_input');
  }
  const encoded = cursor.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new ToolError('invalid_input');
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/** `limit` efectivo: el pedido, acotado a `[1, max]`, o el por defecto (`null` = todo). */
export function effectiveLimit(
  requested: number | undefined,
  spec: { default: number | null; max: number }
): number {
  if (requested === undefined) return spec.default ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(requested, 1), spec.max);
}

interface StorePage<Item> {
  items: readonly Item[];
  nextCursor: string | null;
}

/**
 * Rellena una página con elementos aceptados (`accept` devuelve `undefined` para lo que
 * hay que saltar: oculto por privacidad o filtrado). Pide páginas al almacén hasta
 * reunir `limit` y confirmar que hay uno más, o agotarlo. `cursorAfter` da el cursor del
 * ALMACÉN posicionado justo tras un elemento. `fetch` recibe también `want`: lo que falta
 * para llenar la página más uno (el de la mirada por delante); quien consulta lo acota al
 * máximo del almacén (`storePageSize`). Es solo un tamaño de consulta: ni el contenido ni
 * el tamaño de la página ni el cursor dependen de él.
 */
export async function fillPage<Item, Out>(options: {
  limit: number;
  startCursor: string | null;
  fetch(cursor: string | null, want: number): Promise<StorePage<Item>>;
  accept(item: Item): Out | undefined;
  cursorAfter(item: Item): string;
}): Promise<{ items: Out[]; lastCursor: string | null }> {
  const out: Out[] = [];
  let lastItem: Item | undefined;
  let cursor = options.startCursor;
  for (;;) {
    const page = await options.fetch(cursor, options.limit - out.length + 1);
    for (const item of page.items) {
      const accepted = options.accept(item);
      if (accepted === undefined) continue;
      if (out.length >= options.limit) {
        return { items: out, lastCursor: lastItem ? options.cursorAfter(lastItem) : null };
      }
      out.push(accepted);
      lastItem = item;
    }
    if (!page.nextCursor) return { items: out, lastCursor: null };
    cursor = page.nextCursor;
  }
}

/**
 * Página de una lista ya calculada en memoria. Con `keyOf`, el cursor es la clave del
 * último elemento devuelto (reanuda tras él aunque la lista cambie; una clave que ya no
 * está: `invalid_input`); sin él, es la posición.
 */
export function slicePage<T>(
  all: readonly T[],
  kind: CursorKind,
  options: { limit: number; cursor?: string; keyOf?: (item: T) => string }
): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (options.cursor !== undefined) {
    const payload = unwrapCursor(kind, options.cursor);
    if (options.keyOf) {
      const index = all.findIndex((item) => options.keyOf!(item) === payload);
      if (index < 0) throw new ToolError('invalid_input');
      start = index + 1;
    } else {
      start = Number(payload);
      if (!Number.isInteger(start) || start < 0) throw new ToolError('invalid_input');
    }
  }
  const end = Math.min(start + options.limit, all.length);
  const items = all.slice(start, end);
  if (end >= all.length) return { items, nextCursor: null };
  const last = end - 1;
  const payload = options.keyOf ? options.keyOf(all[last]!) : String(end);
  return { items, nextCursor: wrapCursor(kind, payload) };
}

/** `fields`: deja `id` y los campos pedidos, en el orden de la salida normal. Sin
 *  `fields`, la nota tal cual (salida de siempre). */
export function pickFields<T extends { id: string }>(
  item: T,
  fields: readonly (keyof T & string)[] | undefined
): Partial<T> & { id: string } {
  if (!fields) return item;
  const wanted = new Set<string>(fields);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || wanted.has(key)) out[key] = value;
  }
  return out as Partial<T> & { id: string };
}
