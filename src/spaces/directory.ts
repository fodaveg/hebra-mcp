/**
 * Directorio del agente (D22, SPEC.md §12.10, «Organizaciones»): en solo lectura, las
 * organizaciones de la persona, sus miembros y los espacios que ella vería. No concede nada:
 * el contenido sigue por `spaceId` y por el catálogo de concesiones (`./manager.ts`), que es
 * también de donde sale el `granted` que se enseña, porque es lo que comprueba `space`.
 *
 * Es un dato de permisos: cada llamada lo pide de nuevo al relé, sin caché, y ninguna abre una
 * biblioteca. Nombres de personas, organizaciones y espacios son contenido: nunca a logs.
 */
import { ToolError } from '../server/errors';
import type { DirectoryView, ServerContext } from '../server/context';
import { effectiveLimit, LIMITS, sliceAfterKey, unwrapCursor, wrapCursor } from '../server/pagination';
import { readLimitedJson, type AgentDevice } from './device';
import { agentDirectorySchema, type AgentDirectory } from './protocol';

type UnavailableReason = 'not_available' | 'rate_limited' | 'relay_unavailable' | 'invalid_response';

function unavailable(reason: UnavailableReason, retryAfterSeconds?: number): ToolError {
  return new ToolError('organizations_unavailable', {
    reason,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
  });
}

/** `Retry-After` en segundos. La forma de fecha HTTP se ignora: el aviso es orientativo. */
function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/**
 * `GET /agent-directory` con el token de lectura de ESTA credencial. Un 401 se trata como la
 * credencial en el catálogo (`space_access_denied`). Todo lo demás que no sea un directorio
 * válido, también una respuesta con un campo de más, es `organizations_unavailable`: el 404 de
 * un relé sin publicar o de una credencial que no es de agente, el 429 y el 503.
 */
export async function fetchAgentDirectory(
  device: AgentDevice,
  fetcher: typeof fetch
): Promise<AgentDirectory> {
  await device.assertPairing();
  const { apiOrigin, readToken } = device.paired.connection;
  let response: Response;
  try {
    response = await fetcher(`${apiOrigin}/api/integrations/hebra/agent-directory`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${readToken}` }
    });
  } catch {
    throw unavailable('relay_unavailable');
  }
  if (response.status === 401) throw new ToolError('space_access_denied');
  if (response.status === 404) throw unavailable('not_available');
  if (response.status === 429) throw unavailable('rate_limited', retryAfterSeconds(response));
  if (!response.ok) throw unavailable('relay_unavailable');
  let directory: AgentDirectory;
  try {
    directory = agentDirectorySchema.parse(await readLimitedJson(response));
  } catch {
    throw unavailable('invalid_response');
  }
  await device.assertPairing();
  return directory;
}

/** El directorio ya cruzado con el catálogo fresco: un nombre descifrado gana al publicado, y
 *  `granted` dice si `space` lo aceptaría ahora. */
function grantedView(granted: ReadonlyArray<{ spaceId: string; name: string | null }>) {
  const byId = new Map(granted.map((space) => [space.spaceId, space]));
  return (space: { spaceId: string; name: string | null }) => ({
    spaceId: space.spaceId,
    name: byId.get(space.spaceId)?.name ?? space.name,
    granted: byId.has(space.spaceId)
  });
}

/**
 * `hebra_list_spaces`. Sin directorio (relé sin publicar, 429, 503, respuesta inválida) quedan
 * los espacios con concesión, sin organización y con `organizationsAvailable: false`: que falte
 * esta lista no corta el acceso. Una concesión del catálogo que el directorio aún no trae
 * también sale, porque es usable.
 */
export async function runListSpaces(ctx: Pick<ServerContext, 'spaces' | 'directory'>) {
  if (!ctx.spaces) return { spaces: [], organizationsAvailable: false };
  let view: DirectoryView | null = null;
  try {
    view = (await ctx.directory?.()) ?? null;
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== 'organizations_unavailable') throw error;
  }
  const granted = await ctx.spaces.list();
  if (!view) {
    return {
      spaces: granted.map((space) => ({
        spaceId: space.spaceId,
        name: space.name,
        organization: null,
        granted: true
      })),
      organizationsAvailable: false
    };
  }
  const merge = grantedView(granted);
  const listed = [
    ...view.directory.organizations.flatMap((organization) =>
      organization.spaces.map((space) => ({
        ...merge(space),
        organization: { orgId: organization.orgId, name: organization.name }
      }))
    ),
    ...view.directory.spaces.map((space) => ({ ...merge(space), organization: null }))
  ];
  const seen = new Set(listed.map((space) => space.spaceId));
  for (const space of granted) {
    if (!seen.has(space.spaceId)) listed.push({ ...merge(space), organization: null });
  }
  return {
    spaces: listed.map(({ spaceId, name, organization, granted: hasGrant }) => ({
      spaceId,
      name,
      organization,
      granted: hasGrant
    })),
    organizationsAvailable: true
  };
}

/** `hebra_list_organizations`: por `orgId`, un orden estable entre páginas aunque una
 *  organización desaparezca entre dos llamadas. `isSelf` marca a la persona de este agente. */
export async function runListOrganizations(
  ctx: Pick<ServerContext, 'spaces' | 'directory'>,
  input: { limit?: number; cursor?: string }
) {
  const limit = effectiveLimit(input.limit, LIMITS.listOrganizations);
  const after = input.cursor === undefined ? null : unwrapCursor('og1', input.cursor);
  if (after !== null && !/^[0-9a-f]{64}$/u.test(after)) throw new ToolError('invalid_input');
  if (!ctx.spaces || !ctx.directory) throw unavailable('not_available');
  const { selfAccountId, directory } = await ctx.directory();
  const merge = grantedView(await ctx.spaces.list());
  const sorted = [...directory.organizations].sort((left, right) =>
    left.orgId < right.orgId ? -1 : left.orgId > right.orgId ? 1 : 0
  );
  const { items, lastKey } = sliceAfterKey(sorted, {
    limit,
    after,
    keyOf: (organization) => organization.orgId,
    compare: (left, right) => (left < right ? -1 : left > right ? 1 : 0)
  });
  return {
    organizations: items.map((organization) => ({
      orgId: organization.orgId,
      name: organization.name,
      members: organization.members.map((member) => ({
        accountId: member.accountId,
        role: member.role,
        name: member.name ?? null,
        isSelf: member.accountId === selfAccountId
      })),
      spaces: organization.spaces.map(merge)
    })),
    nextCursor: lastKey === null ? null : wrapCursor('og1', lastKey)
  };
}
