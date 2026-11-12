/**
 * Versiones de una nota de ESPACIO desde el historial del relé (HS-5, §28 de Hebra, decisión
 * 8 de §28.2): lo que hacen `hebra_list_versions`, `hebra_read_version` y
 * `hebra_restore_version` cuando llevan `space`. Sin `space` (biblioteca personal), ni se
 * llama: siguen con las versiones locales de `./versions.ts`.
 *
 * Todo lo de Hebra se importa (`src/hebra.ts`, D5): `listSpaceHistory` y `readSpaceHistory`
 * piden y descifran (`space-history-client.ts`, con la credencial y la bóveda de la sync del
 * espacio, `ServerContext.spaceHistory`), y `buildHistoryContext`, `versionSummaries` y
 * `authorRuns` calculan los autores (`space-history.ts`). Aquí solo se cruzan las cuentas con
 * el directorio de la persona y se aplica el filtro de privados.
 *
 * - **Editado por** de cada versión: las cuentas que selló el relé en su intervalo
 *   (`writers`, §28.3), con el nombre del directorio de la organización dueña del espacio:
 *   "<nombre> (agente)" para `actorKind: agent` y "Antiguo miembro" si la cuenta ya no está.
 *   Sin directorio (`organizations_unavailable`), `name` e `isSelf` son `null` y
 *   `namesResolved: false`: no se inventa ninguno.
 * - **Autores** (`hebra_read_version` con `authors: true`): los tramos del texto de la versión
 *   con su dueño (`authorRuns`): una cuenta, con `confirmed` (§28.4), "Autor sin confirmar" o
 *   "Texto anterior". Para eso se bajan y descifran TODAS las versiones de la nota (hasta 500,
 *   §28.2): es la lectura cara y solo se hace si se pide.
 * - **Caída a lo local**: un relé sin la función (404, el flag `HEBRA_SPACE_HISTORY` apagado,
 *   que es lo que hay en producción el 12 nov 2026, §28.14), sin red, con 429 o con cualquier
 *   otro fallo da `unavailable` y la herramienta responde con las versiones LOCALES de hoy,
 *   con `source: "local"` y `sourceReason` (el motivo). Una nota bloqueada no pide el
 *   historial (§28.7): también local, con `sourceReason: "locked"`.
 *
 * Privacidad (regla 4 de D2, como `./versions.ts`): la nota tiene que ser visible, y una
 * versión cuyo cuerpo lleva una etiqueta privada (o es el de una nota bloqueada) no se lista,
 * no se lee y no se restaura: `not_found`, igual que una que no existe. Con etiquetas privadas
 * configuradas, listar descifra cada versión mirada para juzgarla; sin ellas no hace falta (el
 * relé no guarda versiones de una nota bloqueada, §28.3). Una versión que no se puede descifrar
 * con etiquetas privadas configuradas no se lista: no se puede juzgar.
 *
 * Paginación: el cursor (`vs1.…`) lleva el `before` del relé de la página en curso y cuántas
 * entradas de esa página ya se devolvieron o se saltaron, así que el tamaño de la página no
 * depende de cuántas versiones ocultas hay (M2 del audit de privacidad, como las locales).
 */
import {
  authorRuns,
  buildHistoryContext,
  deriveNote,
  listSpaceHistory,
  readSpaceHistory,
  versionSummaries,
  type AuthorRun,
  type HistoryActorKind,
  type RunOwner,
  type SpaceHistoryEntry,
  type SpaceHistoryListing,
  type SpaceHistoryUnavailableReason,
  type SpaceHistoryVersion
} from '../../hebra';
import { logEvent } from '../../log/logger';
import { LOCKED_BODY_PREFIX } from '../../store/writes';
import { usageOf, type DirectoryView, type SpaceHistoryAccess, type ToolContext } from '../context';
import { ToolError } from '../errors';
import { unwrapCursor, wrapCursor } from '../pagination';

/** Por qué se respondió con las versiones locales en un espacio. */
export type LocalSourceReason = SpaceHistoryUnavailableReason | 'locked';

/** Lo que una herramienta de versiones necesita para ir al relé. */
export interface SpaceVersionsDeps {
  history: SpaceHistoryAccess;
  /** El directorio de la persona (`ServerContext.directory`); sin él, nombres a `null`. */
  directory?: () => Promise<DirectoryView>;
  /** El espacio, para elegir la organización dueña en el directorio. */
  spaceId?: string;
}

/** Una cuenta sellada por el relé, con su nombre visible. */
export interface VersionActor {
  accountId: string;
  actorKind: HistoryActorKind;
  /** "<nombre>", "<nombre> (agente)" o "Antiguo miembro"; `null` sin directorio o si el
   *  directorio no trae nombre para esa cuenta. */
  name: string | null;
  /** `true` si es la persona de este agente; `null` sin directorio. */
  isSelf: boolean | null;
}

/** Una versión del historial del relé en `hebra_list_versions`. */
export interface ServerListedVersion {
  /** El `rev` del relé: el `versionId` que piden `hebra_read_version` y
   *  `hebra_restore_version` con el mismo `space`. */
  versionId: number;
  /** Cuándo se guardó (`savedAt` del relé; si no lo manda, el final de su ventana). */
  createdAt: string;
  windowStart: string;
  windowEnd: string;
  /** Tamaño del sobre cifrado; `null` si el relé no lo manda. */
  byteLength: number | null;
  editedBy: VersionActor[];
}

/** El dueño de un tramo de "Autores" (§28.4). */
export interface AuthorRunOutput {
  text: string;
  /** `account`: una cuenta declaró el `clientID`; `unconfirmedOwner`: lo declararon dos
   *  ("Autor sin confirmar"); `previousText`: nadie ("Texto anterior"). */
  kind: RunOwner['kind'];
  /** El nombre visible: el de la cuenta (como en `editedBy`), "Autor sin confirmar" o
   *  "Texto anterior". `null` si es una cuenta y no se conoce su nombre. */
  author: string | null;
  accountId: string | null;
  actorKind: HistoryActorKind | null;
  isSelf: boolean | null;
  /** Solo con `kind: "account"`: la cuenta también guardó en el intervalo en que apareció el
   *  tramo. `false` = "sin confirmar". `null` en los otros dos tipos. */
  confirmed: boolean | null;
}

export interface ServerListOutput {
  id: string;
  source: 'server';
  /** `quota`: el historial del espacio no se está guardando, no queda sitio (§28.12). */
  recording: 'on' | 'quota';
  /** La última purga del historial de la nota (§28.12), o `null`. */
  purged: (VersionActor & { at: string }) | null;
  namesResolved: boolean;
  versions: ServerListedVersion[];
  nextCursor: string | null;
}

export interface ServerReadOutput extends ServerListedVersion {
  id: string;
  source: 'server';
  body: string;
  namesResolved: boolean;
  /** Solo con `authors: true`. */
  authorRuns?: AuthorRunOutput[] | null;
  /** Solo con `authors: true`: los dueños de los `clientID` que avanzaron desde la versión
   *  anterior (`advancedOwners` de `versionSummaries`), con el mismo formato que los tramos
   *  y sin `text`. */
  changedBy?: Array<Omit<AuthorRunOutput, 'text'>>;
}

export type Unavailable = { unavailable: LocalSourceReason };

/** Páginas de `GET /history` como mucho en una llamada: 500 versiones por nota (§28.2) son
 *  cinco de 100; el resto es margen para un relé que pagina más corto. */
const MAX_HISTORY_PAGES = 12;
/** La página que se pide al relé (`HISTORY_PAGE_MAX`). */
const RELAY_PAGE = 100;

const UNCONFIRMED_OWNER = 'Autor sin confirmar';
const PREVIOUS_TEXT = 'Texto anterior';
const FORMER_MEMBER = 'Antiguo miembro';

interface Cursor {
  before: string | null;
  skip: number;
}

function readCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined) return { before: null, skip: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapCursor('vs1', cursor));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('invalid_input');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    (parsed[0] !== null && typeof parsed[0] !== 'string') ||
    !Number.isSafeInteger(parsed[1]) ||
    (parsed[1] as number) < 0
  ) {
    throw new ToolError('invalid_input');
  }
  return { before: parsed[0] as string | null, skip: parsed[1] as number };
}

/** `true` si el cursor es de las versiones del relé (y no de las locales, `v1.…`). */
export function isServerCursor(cursor: string | undefined): boolean {
  return cursor === undefined || cursor.startsWith('vs1.');
}

/** El cuerpo LOCAL de la nota, para que no se pida el historial de una bloqueada. */
async function localBodyOf(ctx: ToolContext, id: string): Promise<string | null> {
  return (await ctx.port.noteRead(id))?.body ?? null;
}

/** El cuerpo de una versión no puede salir: bloqueado o con una etiqueta privada. */
function bodyIsHidden(ctx: ToolContext, body: string): boolean {
  if (body.startsWith(LOCKED_BODY_PREFIX)) return true;
  return ctx.privacy.hidesAnyTag(deriveNote(body).tags.map(({ tag }) => tag));
}

/** `history.unreadable` del cliente de Hebra, sin contenido: al log de hebra-mcp. */
function diagnostic(event: { event: string; rev?: number; reason?: string }): void {
  logEvent({ event: 'space.history_unreadable', rev: event.rev, reason: event.reason });
}

/** Lo común de las peticiones del cliente de Hebra. */
function request(deps: SpaceVersionsDeps, noteId: string, localBody: string | null) {
  return {
    transport: deps.history.transport,
    identity: deps.history.identity(),
    noteId,
    localBody,
    diagnostic
  };
}

/** Los nombres de las cuentas, con el directorio de la persona si se puede leer. */
class Names {
  private constructor(
    private readonly view: DirectoryView | null,
    private readonly spaceId: string | undefined
  ) {}

  static async load(deps: SpaceVersionsDeps): Promise<Names> {
    let view: DirectoryView | null = null;
    if (deps.directory) {
      try {
        view = await deps.directory();
      } catch (error) {
        // Sin directorio no hay nombres, pero las versiones salen igual.
        if (!(error instanceof ToolError)) throw error;
      }
    }
    return new Names(view, deps.spaceId);
  }

  get resolved(): boolean {
    return this.view !== null;
  }

  /** "<nombre>", "<nombre> (agente)", "Antiguo miembro" o `null` (§28.4). Se busca en la
   *  organización dueña del espacio; si el directorio no la dice, en todas. */
  actor(accountId: string, actorKind: HistoryActorKind): VersionActor {
    const view = this.view;
    if (!view) return { accountId, actorKind, name: null, isSelf: null };
    const organizations = view.directory.organizations;
    const owners =
      this.spaceId === undefined
        ? []
        : organizations.filter((org) => org.spaces.some((space) => space.spaceId === this.spaceId));
    let member: { name?: string | null } | undefined;
    for (const organization of owners.length > 0 ? owners : organizations) {
      member = organization.members.find((entry) => entry.accountId === accountId);
      if (member) break;
    }
    const isSelf = accountId === view.selfAccountId;
    if (!member) return { accountId, actorKind, name: FORMER_MEMBER, isSelf };
    const name = member.name ?? null;
    return {
      accountId,
      actorKind,
      name: name === null ? null : actorKind === 'agent' ? `${name} (agente)` : name,
      isSelf
    };
  }

  owner(owner: RunOwner): Omit<AuthorRunOutput, 'text'> {
    if (owner.kind === 'account') {
      const actor = this.actor(owner.accountId, owner.actorKind);
      return {
        kind: 'account',
        author: actor.name,
        accountId: actor.accountId,
        actorKind: actor.actorKind,
        isSelf: actor.isSelf,
        confirmed: owner.confirmed
      };
    }
    return {
      kind: owner.kind,
      author: owner.kind === 'unconfirmedOwner' ? UNCONFIRMED_OWNER : PREVIOUS_TEXT,
      accountId: null,
      actorKind: null,
      isSelf: null,
      confirmed: null
    };
  }
}

function listedOf(entry: SpaceHistoryEntry, names: Names): ServerListedVersion {
  return {
    versionId: entry.rev,
    createdAt: entry.savedAt ?? entry.windowEnd,
    windowStart: entry.windowStart,
    windowEnd: entry.windowEnd,
    byteLength: entry.byteLength ?? null,
    editedBy: entry.writers.map((writer) => names.actor(writer.accountId, writer.actorKind))
  };
}

/** Cuáles de `entries` no pueden salir (ver la cabecera). Sin etiquetas privadas, ninguna. */
async function hiddenOf(
  ctx: ToolContext,
  deps: SpaceVersionsDeps,
  id: string,
  localBody: string | null,
  page: Pick<SpaceHistoryListing, 'entries' | 'keys'>,
  entries: readonly SpaceHistoryEntry[]
): Promise<boolean[] | Unavailable> {
  if (ctx.privacyConfig.privateTags.length === 0 || entries.length === 0) {
    return entries.map(() => false);
  }
  const read = await readSpaceHistory({
    ...request(deps, id, localBody),
    revs: entries.map((entry) => entry.rev),
    history: page
  });
  if (read.status !== 'ok') return { unavailable: read.status === 'locked' ? 'locked' : read.reason };
  const byRev = new Map(read.versions.map((version) => [version.rev, version]));
  return entries.map((entry) => {
    const version = byRev.get(entry.rev);
    return !version || version.status !== 'ok' || bodyIsHidden(ctx, version.body);
  });
}

/**
 * `hebra_list_versions` con `space`, desde el relé. `{unavailable}` si hay que caer a las
 * versiones locales (relé sin la función, sin red, nota bloqueada).
 */
export async function listServerVersions(
  ctx: ToolContext,
  deps: SpaceVersionsDeps,
  input: { id: string; limit: number; cursor?: string }
): Promise<ServerListOutput | Unavailable> {
  const cursor = readCursor(input.cursor);
  const localBody = await localBodyOf(ctx, input.id);
  let before = cursor.before;
  let skip = cursor.skip;
  const visible: SpaceHistoryEntry[] = [];
  let first: SpaceHistoryListing | null = null;
  let next: Cursor | null = null;

  for (let pages = 0; pages < MAX_HISTORY_PAGES && next === null; pages += 1) {
    const page = await listSpaceHistory({
      ...request(deps, input.id, localBody),
      before,
      limit: RELAY_PAGE,
      declarations: false
    });
    if (page.status === 'locked') return { unavailable: 'locked' };
    if (page.status === 'unavailable') return { unavailable: page.reason };
    first ??= page;
    // Un cursor de una página que ya no tiene tantas entradas: inválido, como una versión
    // de un cursor local que ya no existe.
    if (skip > page.entries.length) throw new ToolError('invalid_input');
    const candidates = page.entries.slice(skip, skip + (input.limit - visible.length + 1));
    const hidden = await hiddenOf(ctx, deps, input.id, localBody, page, candidates);
    if (!Array.isArray(hidden)) return hidden;
    for (const [index, entry] of candidates.entries()) {
      if (hidden[index]) continue;
      if (visible.length >= input.limit) {
        next = { before, skip: skip + index };
        break;
      }
      visible.push(entry);
    }
    if (next !== null) break;
    skip += candidates.length;
    if (skip < page.entries.length) continue;
    if (page.nextBefore === null) break;
    before = page.nextBefore;
    skip = 0;
  }

  const names = await Names.load(deps);
  usageOf(ctx).note(input.id);
  const purged = first?.purged ?? null;
  return {
    id: input.id,
    source: 'server',
    recording: first?.recording ?? 'on',
    purged: purged ? { ...names.actor(purged.accountId, purged.actorKind), at: purged.at } : null,
    namesResolved: names.resolved,
    versions: visible.map((entry) => listedOf(entry, names)),
    nextCursor: next === null ? null : wrapCursor('vs1', JSON.stringify([next.before, next.skip]))
  };
}

/** Todas las páginas de `GET /history` hasta dar con `rev` (o hasta el final con `all`). */
async function collectHistory(
  deps: SpaceVersionsDeps,
  id: string,
  localBody: string | null,
  options: { rev: number; all: boolean }
): Promise<SpaceHistoryListing | Unavailable> {
  let merged: SpaceHistoryListing | null = null;
  let before: string | null = null;
  for (let pages = 0; pages < MAX_HISTORY_PAGES; pages += 1) {
    const page = await listSpaceHistory({
      ...request(deps, id, localBody),
      before,
      limit: RELAY_PAGE,
      // Las declaraciones no dependen de la página: una vez, y solo si hacen falta.
      declarations: options.all && merged === null
    });
    if (page.status === 'locked') return { unavailable: 'locked' };
    if (page.status === 'unavailable') return { unavailable: page.reason };
    if (merged === null) merged = { ...page, entries: [...page.entries], keys: [...page.keys] };
    else {
      merged.entries.push(...page.entries);
      const known = new Set(merged.keys.map((key) => `${key.sourceSyncVaultId}:${key.wrappingSyncVaultId}`));
      for (const key of page.keys) {
        if (!known.has(`${key.sourceSyncVaultId}:${key.wrappingSyncVaultId}`)) merged.keys.push(key);
      }
    }
    if (!options.all && page.entries.some((entry) => entry.rev === options.rev)) break;
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  return merged!;
}

/**
 * `hebra_read_version` con `space`: el cuerpo de la versión `versionId` (su `rev`) y quién la
 * editó; con `authors`, sus tramos con autor. `not_found` si no existe o no puede salir.
 */
export async function readServerVersion(
  ctx: ToolContext,
  deps: SpaceVersionsDeps,
  input: { id: string; versionId: number; authors?: boolean }
): Promise<ServerReadOutput | Unavailable> {
  const read = await readServerVersionBody(ctx, deps, input);
  if ('unavailable' in read) return read;
  const { history, version, entry, versions } = read;
  const names = await Names.load(deps);
  const output: ServerReadOutput = {
    id: input.id,
    source: 'server',
    ...listedOf(entry, names),
    body: version.body,
    namesResolved: names.resolved
  };
  if (input.authors === true) {
    const ydocByRev = new Map(
      (versions ?? []).map((item) => [item.rev, item.status === 'ok' ? item.ydoc : null] as const)
    );
    const context = await buildHistoryContext({
      syncVaultId: deps.history.identity().syncVaultId,
      recordId: input.id,
      versions: history.entries.map((item) => ({ entry: item, ydoc: ydocByRev.get(item.rev) ?? null })),
      declarations: history.declarations
    });
    const runs: AuthorRun[] | null = version.ydoc ? authorRuns(version.ydoc, context) : null;
    output.authorRuns = runs === null ? null : runs.map((run) => ({ text: run.text, ...names.owner(run.owner) }));
    const summary = versionSummaries(context).find(
      (item) => item.entry.rev === entry.rev && item.entry.generation === entry.generation
    );
    output.changedBy = (summary?.advancedOwners ?? []).map((owner) => names.owner(owner));
  }
  usageOf(ctx).note(input.id);
  return output;
}

/** Lo que leen `hebra_read_version` y `hebra_restore_version` con `space`. */
async function readServerVersionBody(
  ctx: ToolContext,
  deps: SpaceVersionsDeps,
  input: { id: string; versionId: number; authors?: boolean }
): Promise<
  | {
      history: SpaceHistoryListing;
      entry: SpaceHistoryEntry;
      version: Extract<SpaceHistoryVersion, { status: 'ok' }>;
      /** Con `authors`: todas las versiones leídas (para `buildHistoryContext`). */
      versions: SpaceHistoryVersion[] | null;
    }
  | Unavailable
> {
  const all = input.authors === true;
  const localBody = await localBodyOf(ctx, input.id);
  const history = await collectHistory(deps, input.id, localBody, { rev: input.versionId, all });
  if ('unavailable' in history) return history;
  const entry = history.entries.find((item) => item.rev === input.versionId);
  if (!entry) throw new ToolError('not_found');
  const revs = all ? history.entries.map((item) => item.rev) : [entry.rev];
  const read = await readSpaceHistory({ ...request(deps, input.id, localBody), revs, history });
  if (read.status === 'locked') return { unavailable: 'locked' };
  if (read.status === 'unavailable') return { unavailable: read.reason };
  const version = read.versions.find((item) => item.rev === entry.rev);
  if (!version || version.status !== 'ok' || bodyIsHidden(ctx, version.body)) {
    throw new ToolError('not_found');
  }
  return { history, entry, version, versions: all ? read.versions : null };
}

/** `hebra_restore_version` con `space`: el cuerpo de la versión del relé que se restaura. */
export async function serverVersionBody(
  ctx: ToolContext,
  deps: SpaceVersionsDeps,
  input: { id: string; versionId: number }
): Promise<{ body: string } | Unavailable> {
  const read = await readServerVersionBody(ctx, deps, input);
  if ('unavailable' in read) return read;
  return { body: read.version.body };
}
