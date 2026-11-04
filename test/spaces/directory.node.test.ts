/**
 * Directorio del agente (D22, SPEC.md §12.10, «Organizaciones»), con el relé falso: la ruta
 * `agent-directory` aún no está publicada, así que aquí la contesta un envoltorio del `fetcher`
 * que responde por el token que le llega. Sin cuentas reales.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import type { AccountRegistry } from '../../src/accounts/registry';
import type { AuthorizedAccount } from '../../src/accounts/types';
import { encodeRecoveryCode } from '../../src/hebra';
import { MemorySecretStore, writePairedSecrets, type PairedSecrets } from '../../src/secrets';
import { buildMcpServer } from '../../src/server/build-server';
import { openServeContext, type ServeContext } from '../../src/server/serve';
import { runListOrganizations } from '../../src/spaces/directory';
import { agentDirectorySchema } from '../../src/spaces/protocol';
import { validatePublicJwk } from '../../vendor/hebra/src/lib/spaces/account-key';
import { sealAgentSpaceGrant } from '../../vendor/hebra/src/lib/spaces/agent-space-grant';
import { writeSpaceMeta } from '../../vendor/hebra/src/lib/spaces/space-key-check';
import { FakeLumbre, LUMBRE } from '../pair/fake-lumbre';

const GRANTED_SPACE = '351f12d0-dd49-48a6-b84c-301e16c9d64a';
const ORG_ONLY_SPACE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LOOSE_SPACE = '16fd2706-8baf-433b-82eb-8c7f5a2f4a11';
const SHARED_VAULT = '22'.repeat(16);
const SHARED_KEY = new Uint8Array(32).fill(22);
const ORG_A = 'a'.repeat(64);
const ORG_B = 'b'.repeat(64);
const OTHER_ACCOUNT = 'c'.repeat(64);
const ORG_NAME = 'Organización reservada';
const MEMBER_NAME = 'Persona reservada';
const DIRECTORY_URL = `${LUMBRE}/api/integrations/hebra/agent-directory`;

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Una cuenta conectada: su servidor MCP, su credencial y lo que el relé le contesta. */
interface Agent {
  dir: string;
  paired: PairedSecrets;
  served: ServeContext;
  client: Client;
  server: ReturnType<typeof buildMcpServer>;
  reply: Reply;
}

let fake: FakeLumbre;
let agents: Agent[];
/** Cada `agent-directory` pedido y el token con el que llegó. */
let directoryCalls: string[];
/** La respuesta del relé por token de lectura: nunca hay una global. */
let replies: Map<string, () => Reply>;

const fetcher: typeof fetch = async (input, init) => {
  if (String(input) === DIRECTORY_URL) {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const token = authorization.replace(/^Bearer /u, '');
    directoryCalls.push(token);
    const reply = replies.get(token)?.() ?? { status: 401, body: { code: 'credential_revoked' } };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: reply.headers
    });
  }
  return fake.fetcher(input as RequestInfo, init);
};

async function connectAgent(user: string): Promise<Agent> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-directory-'));
  const secrets = new MemorySecretStore();
  const deviceId = randomUUID();
  const connection = fake.addAgent(user, deviceId);
  const vault = randomBytes(16).toString('hex');
  fake.addLibraryVault(user, vault);
  const paired: PairedSecrets = {
    connection,
    device: { lumbreDeviceId: deviceId, opaqueDeviceId: randomBytes(16).toString('hex') },
    recoveryCode: await encodeRecoveryCode({
      relayOrigin: LUMBRE,
      syncVaultId: vault,
      keyEpoch: 1,
      vaultKey: new Uint8Array(32).fill(11)
    })
  };
  await writePairedSecrets(secrets, paired);
  const served = await openServeContext({
    dataDir: dir,
    secrets,
    fetcher,
    syncIntervalMs: null,
    instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
  });
  await served.instance.whenReady();
  const server = buildMcpServer(served.ctx, 'test');
  const client = new Client({ name: 'directory-tests', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const agent: Agent = { dir, paired, served, client, server, reply: { status: 404 } };
  replies.set(connection.readToken, () => agent.reply);
  agents.push(agent);
  return agent;
}

async function call(agent: Agent, name: string, args: Record<string, unknown> = {}) {
  const result = (await agent.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text), raw: result };
}

/** Registra el agente (el catálogo lo pide) y le concede `GRANTED_SPACE`. */
async function grant(agent: Agent): Promise<string> {
  await call(agent, 'hebra_list_spaces');
  const credentialId = agent.paired.connection.credentialId;
  const r = fake.agentKeys.get(credentialId)!;
  const envelope = await sealAgentSpaceGrant({
    binding: {
      spaceId: GRANTED_SPACE,
      syncVaultId: SHARED_VAULT,
      accountId: r.accountId,
      credentialId,
      deviceId: r.deviceId,
      keyId: r.keyId
    },
    publicKey: validatePublicJwk(r.publicKey),
    spaceKey: SHARED_KEY
  });
  fake.agentSpaces.set(credentialId, [
    { spaceId: GRANTED_SPACE, syncVaultId: SHARED_VAULT, grant: envelope }
  ]);
  return r.accountId;
}

function directoryFor(accountId: string) {
  return {
    organizations: [
      {
        orgId: ORG_A,
        name: ORG_NAME,
        members: [
          { accountId, role: 'admin', name: MEMBER_NAME },
          { accountId: OTHER_ACCOUNT, role: 'member', name: null }
        ],
        spaces: [
          { spaceId: GRANTED_SPACE, name: 'Nombre publicado', granted: true },
          { spaceId: ORG_ONLY_SPACE, name: 'Solo organización', granted: false }
        ]
      }
    ],
    spaces: [{ spaceId: LOOSE_SPACE, name: null, granted: false }]
  };
}

beforeEach(async () => {
  agents = [];
  directoryCalls = [];
  replies = new Map();
  fake = await FakeLumbre.start();
});
afterEach(async () => {
  for (const agent of agents) {
    await agent.client.close();
    await agent.server.close();
    await agent.served.close();
    await rm(agent.dir, { recursive: true, force: true });
  }
  await fake.close();
});

describe('hebra_list_spaces con directorio', () => {
  it('lista con organización y suelto; granted sale del catálogo fresco', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const { body, isError } = await call(agent, 'hebra_list_spaces');
    expect(isError).toBe(false);
    expect(body).toEqual({
      organizationsAvailable: true,
      spaces: [
        {
          spaceId: GRANTED_SPACE,
          // Sin meta en el relé: no hay nombre descifrado y queda el publicado.
          name: 'Nombre publicado',
          organization: { orgId: ORG_A, name: ORG_NAME },
          granted: true
        },
        {
          spaceId: ORG_ONLY_SPACE,
          name: 'Solo organización',
          organization: { orgId: ORG_A, name: ORG_NAME },
          granted: false
        },
        { spaceId: LOOSE_SPACE, name: null, organization: null, granted: false }
      ]
    });
  });

  it('el nombre descifrado gana al publicado', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    await writeSpaceMeta(
      fake.relayFor(SHARED_VAULT),
      { syncVaultId: SHARED_VAULT, keyEpoch: 1, vaultKey: SHARED_KEY },
      { schema: 1, name: 'Nombre descifrado', createdAt: '2026-01-01T00:00:00.000Z' }
    );
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const { body } = await call(agent, 'hebra_list_spaces');
    expect(body.spaces[0].name).toBe('Nombre descifrado');
    const organizations = await call(agent, 'hebra_list_organizations');
    expect(organizations.body.organizations[0].spaces[0].name).toBe('Nombre descifrado');
  });

  it('un restringido que el relé no devuelve no aparece en ninguna de las dos', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    const restricted = '9b2c3d4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
    agent.reply = { status: 200, body: directoryFor(accountId) };
    for (const tool of ['hebra_list_spaces', 'hebra_list_organizations']) {
      expect(JSON.stringify((await call(agent, tool)).body)).not.toContain(restricted);
    }
  });

  it('el catálogo manda sobre el granted del directorio, en los dos sentidos', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    const directory = directoryFor(accountId);
    directory.organizations[0]!.spaces[0]!.granted = false;
    directory.organizations[0]!.spaces[1]!.granted = true;
    agent.reply = { status: 200, body: directory };
    const { body } = await call(agent, 'hebra_list_spaces');
    expect(body.spaces.map((s: { granted: boolean }) => s.granted)).toEqual([true, false, false]);
  });

  it('una concesión que el directorio aún no trae sale igual, sin organización', async () => {
    const agent = await connectAgent('alice');
    await grant(agent);
    agent.reply = { status: 200, body: { organizations: [], spaces: [] } };
    const { body } = await call(agent, 'hebra_list_spaces');
    expect(body).toEqual({
      organizationsAvailable: true,
      spaces: [{ spaceId: GRANTED_SPACE, name: null, organization: null, granted: true }]
    });
  });
});

describe('granted: false y ser miembro no conceden contenido', () => {
  it('un spaceId del directorio sin concesión da space_access_denied y no toca la bóveda', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    await call(agent, 'hebra_list_organizations');
    const vaultRequests = () => fake.requested.filter((url) => url.includes('/library/')).length;
    const before = vaultRequests();
    for (const space of [ORG_ONLY_SPACE, LOOSE_SPACE]) {
      const denied = await call(agent, 'hebra_list_notes', { space });
      expect(denied.isError).toBe(true);
      expect(denied.body.error).toBe('space_access_denied');
    }
    expect(vaultRequests()).toBe(before);
    expect(existsSync(join(agent.dir, 'spaces'))).toBe(false);
  });

  it('consultar organizaciones no abre ningún contexto de espacio ni registra un dispositivo', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const resolve = vi.spyOn(agent.served.ctx.spaces!, 'resolve');
    const registered = fake.registrations.length;
    await call(agent, 'hebra_list_organizations');
    await call(agent, 'hebra_list_spaces');
    expect(resolve).not.toHaveBeenCalled();
    expect(existsSync(join(agent.dir, 'spaces'))).toBe(false);
    expect(fake.registrations).toHaveLength(registered);
  });
});

describe('sin directorio', () => {
  const cases: Array<[string, Reply, Record<string, unknown>]> = [
    ['404: relé sin publicar o credencial que no es de agente', { status: 404 }, { reason: 'not_available' }],
    ['503: no se conoce la pertenencia', { status: 503, body: { code: 'relay_unavailable' } }, { reason: 'relay_unavailable' }],
    [
      '429 con Retry-After',
      { status: 429, body: { code: 'rate_limited' }, headers: { 'Retry-After': '30' } },
      { reason: 'rate_limited', retryAfterSeconds: 30 }
    ],
    ['500', { status: 500 }, { reason: 'relay_unavailable' }],
    ['una respuesta que no es JSON', { status: 200 }, { reason: 'invalid_response' }]
  ];

  it.each(cases)('%s: hebra_list_spaces degrada y hebra_list_organizations da su error', async (_, reply, extra) => {
    const agent = await connectAgent('alice');
    await grant(agent);
    agent.reply = reply;
    const spaces = await call(agent, 'hebra_list_spaces');
    expect(spaces.isError).toBe(false);
    expect(spaces.body).toEqual({
      organizationsAvailable: false,
      spaces: [{ spaceId: GRANTED_SPACE, name: null, organization: null, granted: true }]
    });
    const organizations = await call(agent, 'hebra_list_organizations');
    expect(organizations.isError).toBe(true);
    expect(organizations.body).toEqual({ error: 'organizations_unavailable', ...extra });
    // Ni el espacio con concesión ni la biblioteca personal dependen del directorio.
    expect((await call(agent, 'hebra_list_notes')).isError).toBe(false);
    expect((await call(agent, 'hebra_list_notes', { space: GRANTED_SPACE })).isError).toBe(false);
  });

  it('un fallo de red también degrada', async () => {
    const agent = await connectAgent('alice');
    await grant(agent);
    replies.set(agent.paired.connection.readToken, () => {
      throw new TypeError('network');
    });
    const spaces = await call(agent, 'hebra_list_spaces');
    expect(spaces.body.organizationsAvailable).toBe(false);
    expect((await call(agent, 'hebra_list_organizations')).body).toEqual({
      error: 'organizations_unavailable',
      reason: 'relay_unavailable'
    });
  });

  it('un 401 se trata como hoy: space_access_denied, sin degradar', async () => {
    const agent = await connectAgent('alice');
    await grant(agent);
    agent.reply = { status: 401, body: { code: 'credential_revoked' } };
    for (const tool of ['hebra_list_spaces', 'hebra_list_organizations']) {
      const denied = await call(agent, tool);
      expect(denied.isError).toBe(true);
      expect(denied.body.error).toBe('space_access_denied');
    }
    expect((await call(agent, 'hebra_list_notes')).isError).toBe(false);
  });
});

describe('DTO cerrado', () => {
  const base = () => directoryFor('d'.repeat(64));
  const parses = (value: unknown) => agentDirectorySchema.safeParse(value).success;

  it('acepta el DTO acordado', () => {
    expect(parses(base())).toBe(true);
  });

  it.each<[string, (d: ReturnType<typeof base>) => void]>([
    ['raíz', (d) => Object.assign(d, { extra: 1 })],
    ['organización', (d) => Object.assign(d.organizations[0]!, { plan: 'pro' })],
    ['miembro', (d) => Object.assign(d.organizations[0]!.members[0]!, { email: 'x@y.z' })],
    ['espacio', (d) => Object.assign(d.spaces[0]!, { orgId: ORG_A })]
  ])('rechaza un campo de más en %s', (_, mutate) => {
    const directory = base();
    mutate(directory);
    expect(parses(directory)).toBe(false);
  });

  it.each<[string, (d: ReturnType<typeof base>) => void]>([
    ['un rol desconocido', (d) => { d.organizations[0]!.members[0]!.role = 'owner'; }],
    ['un orgId que no es un sha256', (d) => { d.organizations[0]!.orgId = 'org-1'; }],
    ['un spaceId que no es un UUID', (d) => { d.spaces[0]!.spaceId = 'x'; }],
    ['granted ausente', (d) => { delete (d.spaces[0] as { granted?: boolean }).granted; }],
    ['el mismo espacio dos veces', (d) => { d.spaces[0]!.spaceId = GRANTED_SPACE; }],
    ['el mismo miembro dos veces', (d) => {
      d.organizations[0]!.members[1]!.accountId = d.organizations[0]!.members[0]!.accountId;
    }],
    ['la misma organización dos veces', (d) => { d.organizations.push({ ...d.organizations[0]!, spaces: [] }); }]
  ])('rechaza %s', (_, mutate) => {
    const directory = base();
    mutate(directory);
    expect(parses(directory)).toBe(false);
  });

  it('un campo de más en la respuesta degrada en vez de filtrarse', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    const directory = directoryFor(accountId);
    Object.assign(directory.organizations[0]!.members[0]!, { email: 'reservado@example.test' });
    agent.reply = { status: 200, body: directory };
    const spaces = await call(agent, 'hebra_list_spaces');
    expect(spaces.body.organizationsAvailable).toBe(false);
    expect(JSON.stringify(spaces.body)).not.toContain('reservado@');
    expect((await call(agent, 'hebra_list_organizations')).body).toEqual({
      error: 'organizations_unavailable',
      reason: 'invalid_response'
    });
  });
});

describe('hebra_list_organizations', () => {
  it('devuelve miembros y espacios, y marca solo a la persona', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const { body, isError } = await call(agent, 'hebra_list_organizations');
    expect(isError).toBe(false);
    expect(body).toEqual({
      nextCursor: null,
      organizations: [
        {
          orgId: ORG_A,
          name: ORG_NAME,
          members: [
            { accountId, role: 'admin', name: MEMBER_NAME, isSelf: true },
            { accountId: OTHER_ACCOUNT, role: 'member', name: null, isSelf: false }
          ],
          spaces: [
            { spaceId: GRANTED_SPACE, name: 'Nombre publicado', granted: true },
            { spaceId: ORG_ONLY_SPACE, name: 'Solo organización', granted: false }
          ]
        }
      ]
    });
  });

  it('un miembro con name ausente o null sale con name null, sin inventar nada', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    const directory = directoryFor(accountId);
    delete (directory.organizations[0]!.members[0] as { name?: string | null }).name;
    agent.reply = { status: 200, body: directory };
    const { body } = await call(agent, 'hebra_list_organizations');
    expect(body.organizations[0].members).toEqual([
      { accountId, role: 'admin', name: null, isSelf: true },
      { accountId: OTHER_ACCOUNT, role: 'member', name: null, isSelf: false }
    ]);
  });

  it('pagina por orgId y no acepta el cursor de otra herramienta', async () => {
    const agent = await connectAgent('alice');
    await grant(agent);
    const organization = (orgId: string) => ({ orgId, name: 'Org', members: [], spaces: [] });
    agent.reply = {
      status: 200,
      body: { organizations: [organization(ORG_B), organization(ORG_A)], spaces: [] }
    };
    const first = await call(agent, 'hebra_list_organizations', { limit: 1 });
    expect(first.body.organizations.map((o: { orgId: string }) => o.orgId)).toEqual([ORG_A]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    // La organización del cursor se va entre las dos páginas: sigue donde tocaba.
    agent.reply = { status: 200, body: { organizations: [organization(ORG_B)], spaces: [] } };
    const second = await call(agent, 'hebra_list_organizations', { limit: 1, cursor: first.body.nextCursor });
    expect(second.body.organizations.map((o: { orgId: string }) => o.orgId)).toEqual([ORG_B]);
    expect(second.body.nextCursor).toBeNull();
    const foreign = await call(agent, 'hebra_list_organizations', { cursor: 'n1.YWJj' });
    expect(foreign.body.error).toBe('invalid_input');
  });

  it('sin caché: cada llamada pregunta al relé y una baja se ve en la siguiente', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    await call(agent, 'hebra_list_organizations');
    const before = directoryCalls.length;
    agent.reply = { status: 200, body: { organizations: [], spaces: [] } };
    const { body } = await call(agent, 'hebra_list_organizations');
    expect(directoryCalls).toHaveLength(before + 1);
    expect(body.organizations).toEqual([]);
  });

  it('nada de personas, organizaciones ni espacios en los logs', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await call(agent, 'hebra_list_organizations');
      await call(agent, 'hebra_list_spaces');
      agent.reply = { status: 503 };
      await call(agent, 'hebra_list_organizations');
      const logged = spy.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain('hebra_list_organizations');
      for (const secret of [ORG_NAME, MEMBER_NAME, 'Nombre publicado', ORG_A, GRANTED_SPACE]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('contexto de cuenta de serve-http', () => {
  it('conserva el directorio al envolver el contexto', async () => {
    const agent = await connectAgent('alice');
    const accountId = await grant(agent);
    agent.reply = { status: 200, body: directoryFor(accountId) };
    const registry = { assertActive() {} } as unknown as AccountRegistry;
    const contexts = new AccountContexts(registry, async () => agent.served);
    const lease = await contexts.acquire({ id: 'alice', generation: 1 } as AuthorizedAccount);
    expect(lease.ctx.spaces).not.toBe(agent.served.ctx.spaces);
    const { organizations } = await runListOrganizations(lease.ctx, {});
    expect(organizations.map((organization) => organization.orgId)).toEqual([ORG_A]);
    lease.release();
  });
});

describe('aislamiento entre cuentas', () => {
  it('cada cuenta usa su credencial y A nunca ve el directorio de B', async () => {
    const alice = await connectAgent('alice');
    const bob = await connectAgent('bob');
    const aliceAccount = await grant(alice);
    await call(bob, 'hebra_list_spaces');
    const bobAccount = fake.agentKeys.get(bob.paired.connection.credentialId)!.accountId;
    expect(aliceAccount).not.toBe(bobAccount);
    alice.reply = { status: 200, body: directoryFor(aliceAccount) };
    bob.reply = {
      status: 200,
      body: {
        organizations: [
          {
            orgId: ORG_B,
            name: 'Organización de B',
            members: [{ accountId: bobAccount, role: 'member', name: 'Persona de B' }],
            spaces: []
          }
        ],
        spaces: []
      }
    };
    directoryCalls.length = 0;
    const seenByAlice = JSON.stringify((await call(alice, 'hebra_list_organizations')).body);
    expect(directoryCalls).toEqual([alice.paired.connection.readToken]);
    directoryCalls.length = 0;
    const seenByBob = await call(bob, 'hebra_list_organizations');
    expect(directoryCalls).toEqual([bob.paired.connection.readToken]);
    expect(seenByAlice).not.toContain('Organización de B');
    expect(seenByAlice).not.toContain(bobAccount);
    expect(JSON.stringify(seenByBob.body)).not.toContain(ORG_NAME);
    // Y no hay caché que cruce: con el relé de B caído, A sigue viendo lo suyo y B nada.
    bob.reply = { status: 503 };
    expect((await call(bob, 'hebra_list_organizations')).body.error).toBe('organizations_unavailable');
    expect(JSON.stringify((await call(alice, 'hebra_list_organizations')).body)).toContain(ORG_NAME);
    // El directorio de B no da a B acceso al espacio de A.
    const denied = await call(bob, 'hebra_list_notes', { space: GRANTED_SPACE });
    expect(denied.body.error).toBe('space_access_denied');
  });
});
