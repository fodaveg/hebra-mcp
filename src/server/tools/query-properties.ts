/**
 * `hebra_query_properties` (D23, SPEC.md §5, §6.3): las notas que cumplen filtros de propiedad y
 * de carpeta, con orden por propiedad. `{notes:[{id,title,folderPath,properties}],nextCursor}`.
 *
 * Los operadores son los de `PropsQueryFilter` del motor, sin ninguno de más, y el filtro es su
 * SQL (`propsFilterSql`), que solo mira la fila de cada nota. El orden no es el del motor, que
 * mira toda la biblioteca para decidir si una clave es numérica: es `./props-order.ts`, sobre lo
 * visible. Por eso esta es una LISTA CALCULADA, como `hebra_list_files`: se leen todas las notas
 * visibles que cumplen los filtros, se ordena y se corta. Así el contenido de una página, su
 * tamaño, su orden y su cursor solo dependen de lo visible. Coste asumido: cada página lee todas
 * las visibles que cumplen los filtros (una consulta, sin cuerpos), no solo las suyas, y recorre
 * los valores de la clave de orden sin guardarlos.
 *
 * Lo oculto se quita en la propia consulta, con las reglas del filtro de la llamada (`notesScope`,
 * `src/store/visible-sql.ts`; pieza A7 del plan de memoria, 6 nov 2026), y el filtro solo carga
 * las notas de la página (`privacyLoad: 'lazy'`): antes cargaba la biblioteca entera y la copiaba
 * con `visibleNotes()` aunque los filtros dejaran tres notas.
 *
 * `properties` de cada nota: los valores de las claves pedidas (por defecto, las de los filtros y
 * la del orden), en orden binario como las da el motor. Una clave sin valor sale `[]`. Se leen solo
 * los de la página y hasta `PROPERTIES_RESPONSE_MAX_CHARS`: si no caben, la página se corta antes.
 */
import { ROOT_FOLDER_ID, type PropsFilterOp, type PropsQueryFilter } from '../../hebra';
import { usageOf, type ToolContext } from '../context';
import { ToolError } from '../errors';
import {
  LIMITS,
  effectiveLimit,
  pickFields,
  sliceAfterKey,
  unwrapCursor,
  wrapCursor
} from '../pagination';
import type { QUERY_PROPERTIES_FIELDS } from '../schemas';
import { PROPERTIES_RESPONSE_MAX_CHARS } from '../../store/props-limits';
import type { PropsMatch } from '../../store/props-sql';
import {
  SortKeysCollector,
  assertCursorMode,
  compareSortKeys,
  decodeSortKey,
  encodeSortKey,
  type PropsSort
} from './props-order';

export interface QueryPropertiesNote {
  id: string;
  title: string;
  folderPath: string;
  properties: Record<string, string[]>;
}

type QueryPropertiesField = (typeof QUERY_PROPERTIES_FIELDS)[number];

export interface QueryPropertiesInput {
  filters?: ReadonlyArray<{ key: string; op: PropsFilterOp; value?: string | null }>;
  folder?: string;
  subfolders?: boolean;
  sort?: { key?: string | null; direction?: 'ascending' | 'descending'; empty?: 'first' | 'last' };
  properties?: readonly string[];
  limit?: number;
  cursor?: string;
  fields?: readonly QueryPropertiesField[];
}

/** La pseudoclave del título de los filtros de una Base: no es una propiedad que enseñar. */
function isTitleKey(key: string): boolean {
  return key.trim() === 'note.title';
}

/** Los filtros, con la clave como la guarda `note_props` (en minúsculas). Un operador de
 *  comparación sin valor es `invalid_input` aquí, antes de leer nada. */
function normalizedFilters(input: QueryPropertiesInput): PropsQueryFilter[] {
  return (input.filters ?? []).map((filter) => {
    const key = filter.key.toLowerCase();
    if (filter.op === 'exists' || filter.op === 'missing') return { key, op: filter.op };
    if (typeof filter.value !== 'string') throw new ToolError('invalid_input');
    return { key, op: filter.op, value: filter.value };
  });
}

function normalizedSort(input: QueryPropertiesInput): PropsSort {
  const key = input.sort?.key;
  return {
    key: key === undefined || key === null ? null : key.toLowerCase(),
    direction: input.sort?.direction ?? 'ascending',
    empty: input.sort?.empty ?? 'last'
  };
}

export async function runQueryProperties(
  ctx: ToolContext,
  input: QueryPropertiesInput = {}
): Promise<{ notes: Array<Partial<QueryPropertiesNote> & { id: string }>; nextCursor: string | null }> {
  const limit = effectiveLimit(input.limit, LIMITS.queryProperties);
  const filters = normalizedFilters(input);
  const sort = normalizedSort(input);
  const after = input.cursor !== undefined ? decodeSortKey(sort, unwrapCursor('pq1', input.cursor)) : null;

  // Una carpeta privada o inexistente, lista vacía: lo mismo que en `hebra_search`. Con las
  // subcarpetas de la raíz, todas (`null`), que también cubre las notas de carpeta borrada.
  let folderIds: ReadonlySet<string> | null = null;
  if (input.folder !== undefined) {
    const resolved = ctx.privacy.folderIdForPath(input.folder);
    if (!resolved || ctx.privacy.isFolderHidden(resolved)) return { notes: [], nextCursor: null };
    if (!input.subfolders) folderIds = new Set([resolved]);
    else if (resolved !== ROOT_FOLDER_ID) folderIds = new Set(ctx.privacy.folderSubtree(resolved));
  }

  const shown = [
    ...new Set(
      input.properties
        ? input.properties.map((key) => key.toLowerCase())
        : [...filters.map((filter) => filter.key), ...(sort.key === null ? [] : [sort.key])].filter(
            (key) => !isTitleKey(key)
          )
    )
  ];
  // Solo las VISIBLES, con las reglas del filtro dentro de la consulta (pieza A7 del plan de
  // memoria, 6 nov 2026): el filtro no carga la biblioteca entera, y cada coincidencia trae su
  // carpeta efectiva y si está bloqueada.
  const scope = ctx.privacy.notesScope();
  const matches = await ctx.port.propsMatches({ props: filters, scope });

  // Toda la respuesta sale de las visibles (también el modo del orden, y si hay `nextCursor`). No
  // se declaran todas a la puerta final (volvería a cargarlas allí): si una deja de verse durante
  // la llamada, la época de privacidad cambia y la puerta la repite, como en un recuento.
  const used = usageOf(ctx);

  const selected = matches.filter((match) => folderIds === null || folderIds.has(match.folderId));
  const collector = new SortKeysCollector(sort, new Set(selected.map((match) => match.id)));
  if (sort.key !== null) {
    // Solo valores de visibles sin bloquear: una bloqueada no tiene propiedades, aunque quede una
    // fila de antes de bloquearla.
    await ctx.port.visitPropValues(sort.key, scope, (noteId, value) => collector.add(noteId, value));
  }
  if (after) assertCursorMode(after, collector.mode);

  const rows = selected
    .map((match) => ({ match, key: collector.keyOf(match) }))
    .sort((left, right) => compareSortKeys(sort, left.key, right.key));
  const page = sliceAfterKey(rows, {
    limit,
    after,
    keyOf: (row) => row.key,
    compare: (left, right) => compareSortKeys(sort, left, right)
  });

  // Los valores, solo de esta página y hasta el tope de la respuesta: si no caben todos, la página
  // se corta antes, con `nextCursor`. Sin `properties` entre los campos pedidos, ni se leen.
  const wantsProperties = !input.fields || input.fields.includes('properties');
  const fields = input.fields as ReadonlyArray<keyof QueryPropertiesNote & string> | undefined;
  const element = (match: PropsMatch, values?: ReadonlyMap<string, string[]>) => {
    const folderPath = ctx.privacy.folderPath(match.folderId);
    const properties = Object.fromEntries(shown.map((key) => [key, values?.get(key) ?? []]));
    const note: QueryPropertiesNote = { id: match.id, title: match.title, folderPath, properties };
    return pickFields(note, fields);
  };
  // Cada nota cuenta entera para el tope: su id, su título, su carpeta y sus claves, sin valores
  // todavía. De una bloqueada no se lee nada: no tiene propiedades.
  const { notes: read } = await ctx.port.propValuesOfNotes(
    page.items.map(({ match }) => ({
      id: match.id,
      chars: JSON.stringify(element(match)).length + 1,
      readValues: wantsProperties && shown.length > 0 && !match.locked
    })),
    shown,
    PROPERTIES_RESPONSE_MAX_CHARS
  );
  const cut = read.length < page.items.length;
  const items = page.items.slice(0, read.length);

  // Las de la página sí se declaran, con su sello: se cargan en el filtro solo ellas, para que
  // `used.note` tome también el sello del filtro (`sealOf`) sin preguntar por una no cargada.
  await ctx.privacy.ensure(items.map(({ match }) => match.id));
  const notes = items.map(({ match }, index) => {
    const folderId = match.folderId;
    used.note(match.id, match.localSeq);
    used.folder(folderId, ctx.privacy.folderPath(folderId));
    return element(match, read[index]!.values);
  });
  const lastKey = cut ? items.at(-1)!.key : page.lastKey;
  return {
    notes,
    nextCursor: lastKey === null ? null : wrapCursor('pq1', encodeSortKey(lastKey))
  };
}
