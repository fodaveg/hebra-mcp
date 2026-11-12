/**
 * HS-5 (§28 de Hebra): `hebra_list_versions`, `hebra_read_version` y `hebra_restore_version`
 * con `space` leen el historial del espacio en el relé. El relé es falso pero habla HTTP: el
 * transporte es el de Hebra (`spaceHistoryTransport`, el mismo `HttpLibraryTransport` de la
 * sync) sobre un `fetch` que responde `GET /history`, `GET /history/clients` y
 * `POST /history/read` con sobres cifrados de verdad. Así lo que se prueba es lo de hebra-mcp
 * (nombres, privacidad, paginación, caída a lo local), y el descifrado y los autores son los
 * de la app.
 *
 * La nota es `versionedNoteId` de la biblioteca de prueba; sus versiones LOCALES son las de
 * `test/tools/versions.test.ts`, que es lo que sale al caer a lo local.
 */
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { spaceHistoryTransport } from '../../src/hebra';
import { resolveToolContext, type DirectoryView, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import type { SpaceVersionsDeps } from '../../src/server/tools/space-versions';
import { runListVersions, runReadVersion, runRestoreVersion } from '../../src/server/tools/versions';
import { runReadNote } from '../../src/server/tools/read-note';
import { base64FromBytes, deriveRecordKey, encodeRecordEnvelope } from '../../vendor/hebra/src/lib/library/envelope';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_TAG, VERSIONED_OLD_BODY } from '../fixtures/test-library';

const VAULT = 'cd'.repeat(16);
const KEY = new Uint8Array(32).fill(7);
const SPACE = '7d3f1c2a-4b5e-4c6d-8e9f-0a1b2c3d4e5f';
const ANA = 'a1'.repeat(32);
const BEA = 'b2'.repeat(32);
const GONE = 'c3'.repeat(32);
const SELF = 'd4'.repeat(32);

const DIRECTORY: DirectoryView = {
  selfAccountId: SELF,
  directory: {
    organizations: [
      {
        orgId: 'ee'.repeat(32),
        name: 'Estudio',
        members: [
          { accountId: ANA, role: 'member', name: 'Ana' },
          { accountId: BEA, role: 'admin', name: 'Bea' },
          { accountId: SELF, role: 'member', name: 'Yo' }
        ],
        spaces: [{ spaceId: SPACE, name: 'Proyecto', granted: true }]
      }
    ],
    spaces: []
  }
};

interface FakeVersion {
  rev: number;
  body: string;
  ydoc: Uint8Array | null;
  writers: Array<{ accountId: string; actorKind: 'app' | 'agent' }>;
  savedAt: string;
}

/** Un relé del historial por HTTP. `status` fijo: todas las rutas responden con él. */
class FakeHistoryRelay {
  versions: FakeVersion[] = [];
  clients: Array<{ clientId: number; accountId: string; actorKind: 'app' | 'agent' }> = [];
  status: number | null = null;
  offline = false;
  /** Tamaño de página que fuerza el relé (para probar `nextBefore`). */
  pageSize = 100;
  calls: string[] = [];
  /** Los `revs` de cada `POST /history/read`, en orden. */
  reads: number[][] = [];
  /** El `byteLength` que manda el relé de cada versión (por defecto, `100 + rev`). */
  byteLengthOf: (rev: number) => number | undefined = (rev) => 100 + rev;
  /** Si está, el siguiente `POST /history/read` (solo ese) avisa con `onRead` y espera a que
   *  se resuelva. */
  hold: Promise<void> | null = null;
  onRead: (() => void) | null = null;
  private envelopes = new Map<number, string>();

  constructor(private readonly noteId: string) {}

  async add(version: FakeVersion): Promise<void> {
    this.versions.push(version);
    const recordKey = await deriveRecordKey({ vaultKey: KEY, syncVaultId: VAULT, keyEpoch: 1 });
    const { envelope } = await encodeRecordEnvelope({
      recordKey,
      syncVaultId: VAULT,
      recordId: this.noteId,
      fields: {
        kind: 'note', folderId: '', body: version.body, createdAt: 1, updatedAt: version.rev,
        favorite: false, trashedAt: null, conflictOf: null, conflictAt: null, conflictDevice: null,
        ...(version.ydoc ? { ydoc: base64FromBytes(version.ydoc) } : {})
      }
    });
    this.envelopes.set(version.rev, base64FromBytes(envelope));
  }

  /** Una versión que sale en `GET /history` pero cuyo sobre no se puede leer (para probar
   *  lo que se decide antes de leer sobres, sin cifrar cientos). */
  listOnly(version: FakeVersion): void {
    this.versions.push(version);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.slice(url.pathname.indexOf(`/vaults/${VAULT}/`) + `/vaults/${VAULT}/`.length);
    this.calls.push(route);
    if (this.offline) throw new TypeError('fetch failed');
    if (this.status !== null) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: this.status });
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (route === 'history') {
      const newest = [...this.versions].sort((a, b) => b.rev - a.rev);
      const before = url.searchParams.get('before');
      const start = before === null ? 0 : newest.findIndex((version) => version.rev < Number(before));
      const page = start < 0 ? [] : newest.slice(start, start + this.pageSize);
      const last = page[page.length - 1];
      const more = start >= 0 && start + this.pageSize < newest.length;
      return json({
        entries: page.map((version) => ({
          rev: version.rev,
          windowStart: version.savedAt,
          windowEnd: version.savedAt,
          savedAt: version.savedAt,
          byteLength: this.byteLengthOf(version.rev),
          generationSyncVaultId: VAULT,
          writers: version.writers
        })),
        keys: [],
        nextBefore: more && last ? String(last.rev) : null,
        recording: 'on'
      });
    }
    if (route === 'history/clients') return json({ clients: this.clients, nextAfter: null });
    if (route === 'history/read') {
      const { revs } = JSON.parse(String(init?.body)) as { revs: number[] };
      this.reads.push(revs);
      const hold = this.hold;
      this.hold = null;
      if (hold) {
        this.onRead?.();
        await hold;
      }
      return json({
        entries: revs
          .filter((rev) => this.envelopes.has(rev))
          .map((rev) => ({ rev, envelope: this.envelopes.get(rev) })),
        more: []
      });
    }
    return new Response('{}', { status: 404 });
  };
}

/** El `ydoc` de §27.3 (un `Y.Text` `body`) de `previous` más `text` al final, escrito por
 *  `clientId`. */
function ydocAppend(previous: Uint8Array | null, clientId: number, text: string): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  if (previous) Y.applyUpdateV2(doc, previous);
  doc.clientID = clientId;
  const body = doc.getText('body');
  body.insert(body.length, text);
  const bytes = Y.encodeStateAsUpdateV2(doc);
  doc.destroy();
  return bytes;
}

let counter = 0;
function opId(): string {
  counter += 1;
  return `op-space-version-${process.pid}-${counter}`;
}

describe('versiones de una nota de espacio desde el relé (HS-5)', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  /** La biblioteca de prueba y un relé con dos versiones de `versionedNoteId`: la 1, de Ana
   *  (y de una cuenta que ya no está), y la 2, que añade texto el agente de Bea. */
  async function setup(options: { directory?: boolean } = {}) {
    test = await buildTestContext();
    const id = test.library.versionedNoteId;
    const relay = new FakeHistoryRelay(id);
    const first = ydocAppend(null, 111, VERSIONED_OLD_BODY);
    const second = ydocAppend(first, 222, '\nAñadido por el agente.');
    await relay.add({
      rev: 4, body: VERSIONED_OLD_BODY, ydoc: first, savedAt: '2026-11-12T10:00:00.000Z',
      writers: [{ accountId: ANA, actorKind: 'app' }, { accountId: GONE, actorKind: 'app' }]
    });
    await relay.add({
      rev: 9, body: `${VERSIONED_OLD_BODY}\nAñadido por el agente.`, ydoc: second,
      savedAt: '2026-11-12T10:05:00.000Z', writers: [{ accountId: BEA, actorKind: 'agent' }]
    });
    relay.clients = [
      { clientId: 111, accountId: ANA, actorKind: 'app' },
      { clientId: 222, accountId: BEA, actorKind: 'agent' }
    ];
    const deps: SpaceVersionsDeps = {
      history: {
        transport: spaceHistoryTransport(
          async () => ({ apiOrigin: 'https://relay.test', readToken: 'read', writeToken: 'write' }),
          relay.fetch
        ),
        identity: () => ({ syncVaultId: VAULT, vaultKeyHex: Buffer.from(KEY).toString('hex') })
      },
      spaceId: SPACE,
      account: {},
      ...(options.directory === false
        ? { directory: async () => { throw new ToolError('organizations_unavailable'); } }
        : { directory: async () => DIRECTORY })
    };
    return { id, relay, deps };
  }

  it('lista las versiones del servidor con quién las editó, con nombres del directorio', async () => {
    const { id, deps } = await setup();
    const listed = await runListVersions(await fresh(), { id }, deps);
    expect(listed).toEqual({
      id,
      source: 'server',
      recording: 'on',
      purged: null,
      namesResolved: true,
      versions: [
        {
          versionId: 9,
          createdAt: '2026-11-12T10:05:00.000Z',
          windowStart: '2026-11-12T10:05:00.000Z',
          windowEnd: '2026-11-12T10:05:00.000Z',
          byteLength: 109,
          editedBy: [{ accountId: BEA, actorKind: 'agent', name: 'Bea (agente)', isSelf: false }]
        },
        {
          versionId: 4,
          createdAt: '2026-11-12T10:00:00.000Z',
          windowStart: '2026-11-12T10:00:00.000Z',
          windowEnd: '2026-11-12T10:00:00.000Z',
          byteLength: 104,
          editedBy: [
            { accountId: ANA, actorKind: 'app', name: 'Ana', isSelf: false },
            { accountId: GONE, actorKind: 'app', name: 'Antiguo miembro', isSelf: false }
          ]
        }
      ],
      nextCursor: null
    });
  });

  it('sin directorio, las cuentas salen sin nombre y namesResolved lo dice', async () => {
    const { id, deps } = await setup({ directory: false });
    const listed = await runListVersions(await fresh(), { id }, deps);
    expect(listed).toMatchObject({ source: 'server', namesResolved: false });
    expect((listed as { versions: Array<{ editedBy: unknown[] }> }).versions[0]!.editedBy).toEqual([
      { accountId: BEA, actorKind: 'agent', name: null, isSelf: null }
    ]);
  });

  it('pagina sobre las páginas del relé sin perder ni repetir versiones', async () => {
    const { id, relay, deps } = await setup();
    relay.pageSize = 1;
    const first = await runListVersions(await fresh(), { id, limit: 1 }, deps);
    expect(first.versions.map((version) => version.versionId)).toEqual([9]);
    expect(first.nextCursor).toMatch(/^vs1\./u);
    const second = await runListVersions(await fresh(), { id, limit: 1, cursor: first.nextCursor! }, deps);
    expect(second.versions.map((version) => version.versionId)).toEqual([4]);
    expect(second.nextCursor).toBeNull();
  });

  it('lee una versión del servidor y, con authors, cada tramo con su autor', async () => {
    const { id, deps } = await setup();
    const plain = await runReadVersion(await fresh(), { id, versionId: 4 }, deps);
    expect(plain).toMatchObject({ id, source: 'server', versionId: 4, body: VERSIONED_OLD_BODY });
    expect(plain).not.toHaveProperty('authorRuns');

    const read = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect(read).toMatchObject({
      source: 'server',
      versionId: 9,
      body: `${VERSIONED_OLD_BODY}\nAñadido por el agente.`,
      editedBy: [{ accountId: BEA, name: 'Bea (agente)' }]
    });
    expect((read as { authorRuns: unknown }).authorRuns).toEqual([
      { text: VERSIONED_OLD_BODY, kind: 'account', author: 'Ana', accountId: ANA, actorKind: 'app', isSelf: false, confirmed: true },
      {
        text: '\nAñadido por el agente.', kind: 'account', author: 'Bea (agente)', accountId: BEA,
        actorKind: 'agent', isSelf: false, confirmed: true
      }
    ]);
    expect((read as { changedBy: unknown }).changedBy).toEqual([
      { kind: 'account', author: 'Bea (agente)', accountId: BEA, actorKind: 'agent', isSelf: false, confirmed: true }
    ]);
  });

  it('un clientID sin declarar es «Texto anterior», y uno de dos cuentas, «Autor sin confirmar»', async () => {
    const { id, relay, deps } = await setup();
    relay.clients = [
      { clientId: 222, accountId: BEA, actorKind: 'agent' },
      { clientId: 222, accountId: ANA, actorKind: 'app' }
    ];
    const read = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect((read as { authorRuns: Array<{ kind: string; author: string }> }).authorRuns.map((run) => [run.kind, run.author])).toEqual([
      ['previousText', 'Texto anterior'],
      ['unconfirmedOwner', 'Autor sin confirmar']
    ]);
  });

  it('una versión que no existe, o con una etiqueta privada, es not_found', async () => {
    const { id, relay, deps } = await setup();
    await expect(runReadVersion(await fresh(), { id, versionId: 77 }, deps)).rejects.toMatchObject({ code: 'not_found' });
    await relay.add({
      rev: 12, body: `# Secreta\n\n#secreto/personal ${BAIT_TAG}\n`, ydoc: null, savedAt: '2026-11-12T11:00:00.000Z',
      writers: [{ accountId: ANA, actorKind: 'app' }]
    });
    const ctx = await fresh();
    // La biblioteca de prueba marca `#secreto` (y sus hijas) como privada: ni se lista ni se lee.
    expect(ctx.privacyConfig.privateTags.length).toBeGreaterThan(0);
    const listed = await runListVersions(ctx, { id }, deps);
    expect(listed.versions.map((version) => version.versionId)).toEqual([9, 4]);
    await expect(runReadVersion(await fresh(), { id, versionId: 12 }, deps)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('con el relé en 404 (flag apagado) cae a las versiones locales y lo dice', async () => {
    const { id, relay, deps } = await setup();
    relay.status = 404;
    const { versionedNoteVersionId: versionId } = test!.library;
    const listed = await runListVersions(await fresh(), { id }, deps);
    expect(listed).toMatchObject({ id, source: 'local', sourceReason: 'not_found', nextCursor: null });
    expect(listed.versions.map((version) => version.versionId)).toEqual([versionId]);
    const read = await runReadVersion(await fresh(), { id, versionId }, deps);
    expect(read).toMatchObject({ source: 'local', sourceReason: 'not_found', body: VERSIONED_OLD_BODY });
    // Con `source: "local"` ni se pregunta al relé.
    relay.calls = [];
    expect(await runReadVersion(await fresh(), { id, versionId, source: 'local' }, deps)).toMatchObject({ source: 'local' });
    expect(relay.calls).toEqual([]);
  });

  it('sin red también cae a lo local, con su motivo', async () => {
    const { id, relay, deps } = await setup();
    relay.offline = true;
    expect(await runListVersions(await fresh(), { id }, deps)).toMatchObject({ source: 'local', sourceReason: 'offline' });
  });

  it('restaurar una versión del servidor es una edición nueva con expectedRevision', async () => {
    const { id, deps } = await setup();
    const { revision } = await runReadNote(await fresh(), { id });
    const restored = await runRestoreVersion(
      await fresh(),
      { id, versionId: 9, expectedRevision: revision, operationId: opId() },
      deps
    );
    expect(restored).toMatchObject({ id, outcome: 'saved', source: 'server' });
    expect((await runReadNote(await fresh(), { id })).body).toBe(`${VERSIONED_OLD_BODY}\nAñadido por el agente.`);
    // Con la revisión de antes, conflicto: la nota ya cambió.
    await expect(
      runRestoreVersion(await fresh(), { id, versionId: 4, expectedRevision: revision, operationId: opId() }, deps)
    ).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('restaurar sin source o con source "server" y el relé caído no escribe, aunque haya una local con ese número', async () => {
    const { id, relay, deps } = await setup();
    // El número de una versión LOCAL de la misma nota: antes, al caer a lo local, el escritor
    // la aceptaba y guardaba un texto que el agente nunca había visto.
    const { versionedNoteVersionId: versionId } = test!.library;
    const { revision, body } = await runReadNote(await fresh(), { id });
    const down: Array<[() => void, string]> = [
      [() => { relay.status = 404; }, 'not_found'],
      [() => { relay.status = 429; }, 'rate_limited'],
      [() => { relay.status = null; relay.offline = true; }, 'offline']
    ];
    for (const [breakRelay, sourceReason] of down) {
      breakRelay();
      for (const source of [undefined, 'server'] as const) {
        await expect(
          runRestoreVersion(
            await fresh(),
            { id, versionId, expectedRevision: revision, operationId: opId(), ...(source ? { source } : {}) },
            deps
          )
        ).rejects.toMatchObject({ code: 'history_unavailable', extra: { sourceReason } });
      }
    }
    expect((await runReadNote(await fresh(), { id })).body).toBe(body);

    // Con `source: "local"`, a propósito, sí: la versión de este dispositivo, sin preguntar al relé.
    relay.calls = [];
    const restored = await runRestoreVersion(
      await fresh(),
      { id, versionId, expectedRevision: revision, operationId: opId(), source: 'local' },
      deps
    );
    expect(restored).toMatchObject({ id, outcome: 'saved', source: 'local' });
    expect(restored).not.toHaveProperty('sourceReason');
    expect(relay.calls).toEqual([]);
    expect((await runReadNote(await fresh(), { id })).body).toBe(VERSIONED_OLD_BODY);
  });

  it('leer con source "server" y el relé caído es un error, sin caer a lo local', async () => {
    const { id, relay, deps } = await setup();
    const { versionedNoteVersionId: versionId } = test!.library;
    relay.status = 404;
    await expect(runReadVersion(await fresh(), { id, versionId, source: 'server' }, deps)).rejects.toMatchObject({
      code: 'history_unavailable',
      extra: { sourceReason: 'not_found' }
    });
    // Sin `source`, la lectura (que no escribe) sí cae a lo local, marcada.
    expect(await runReadVersion(await fresh(), { id, versionId }, deps)).toMatchObject({
      source: 'local',
      sourceReason: 'not_found',
      body: VERSIONED_OLD_BODY
    });
  });

  it('authors con más de 500 versiones no lee los sobres: authorRuns null y too_large', async () => {
    const { id, relay, deps } = await setup();
    for (let rev = 100; rev < 600; rev += 1) {
      relay.listOnly({ rev, body: '', ydoc: null, savedAt: '2026-11-12T09:00:00.000Z', writers: [] });
    }
    const read = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect(read).toMatchObject({
      source: 'server',
      versionId: 9,
      body: `${VERSIONED_OLD_BODY}\nAñadido por el agente.`,
      authorRuns: null,
      changedBy: null,
      authorsReason: 'too_large'
    });
    // Solo se leyó el sobre de la versión pedida.
    expect(relay.reads).toEqual([[9]]);
  });

  it('authors con sobres que suman más del tope no los lee: too_large (y un tamaño desconocido cuenta como el máximo)', async () => {
    const { id, relay, deps } = await setup();
    relay.byteLengthOf = (rev) => (rev === 4 ? 2 * 1024 * 1024 : 100);
    const big = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect(big).toMatchObject({ authorRuns: null, changedBy: null, authorsReason: 'too_large' });
    expect(relay.reads).toEqual([[9]]);

    relay.reads = [];
    relay.byteLengthOf = (rev) => (rev === 4 ? undefined : 100);
    const unknown = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect(unknown).toMatchObject({ authorRuns: null, authorsReason: 'too_large' });
    expect(relay.reads).toEqual([[9]]);

    // Dentro del tope, los autores de siempre.
    relay.reads = [];
    relay.byteLengthOf = () => 100;
    const small = await runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    expect((small as { authorRuns: unknown[] }).authorRuns).toHaveLength(2);
    expect(small).not.toHaveProperty('authorsReason');
  });

  it('como mucho una lectura de autores a la vez por cuenta: la otra sale con busy', async () => {
    const { id, relay, deps } = await setup();
    let release!: () => void;
    relay.hold = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { relay.onRead = resolve; });
    const first = runReadVersion(await fresh(), { id, versionId: 9, authors: true }, deps);
    await reached;
    // La misma cuenta en otro espacio (otro acceso al historial, la misma `account`): ocupada.
    const otherSpace: SpaceVersionsDeps = { ...deps, history: { ...deps.history } };
    const second = await runReadVersion(await fresh(), { id, versionId: 4, authors: true }, otherSpace);
    expect(second).toMatchObject({ source: 'server', versionId: 4, authorRuns: null, changedBy: null, authorsReason: 'busy' });
    release();
    expect((await first as { authorRuns: unknown[] }).authorRuns).toHaveLength(2);
    // Acabada la primera, la cuenta vuelve a poder.
    const third = await runReadVersion(await fresh(), { id, versionId: 4, authors: true }, deps);
    expect(third).not.toHaveProperty('authorsReason');
  });

  it('con 30 versiones privadas recientes y limit 1, la página trae la visible y el cursor sigue', async () => {
    const { id, relay, deps } = await setup();
    for (let rev = 10; rev < 40; rev += 1) {
      await relay.add({
        rev, body: `# Secreta ${rev}\n\n#secreto/personal ${BAIT_TAG}\n`, ydoc: null,
        savedAt: '2026-11-12T11:00:00.000Z', writers: [{ accountId: ANA, actorKind: 'app' }]
      });
    }
    const page = await runListVersions(await fresh(), { id, limit: 1 }, deps);
    expect(page.versions.map((version) => version.versionId)).toEqual([9]);
    expect(page.nextCursor).toMatch(/^vs1\./u);
    // Una sola página del relé: la ya bajada se reutiliza mientras queden entradas.
    expect(relay.calls.filter((route) => route === 'history')).toHaveLength(1);
    const rest = await runListVersions(await fresh(), { id, limit: 1, cursor: page.nextCursor! }, deps);
    expect(rest.versions.map((version) => version.versionId)).toEqual([4]);
    expect(rest.nextCursor).toBeNull();
  });

  it('si se agota el presupuesto de páginas del relé, devuelve el cursor en vez de null', async () => {
    const { id, relay, deps } = await setup();
    relay.pageSize = 1;
    for (let rev = 10; rev < 40; rev += 1) {
      await relay.add({
        rev, body: `# Secreta ${rev}\n\n#secreto/personal ${BAIT_TAG}\n`, ydoc: null,
        savedAt: '2026-11-12T11:00:00.000Z', writers: [{ accountId: ANA, actorKind: 'app' }]
      });
    }
    const seen: number[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = await runListVersions(await fresh(), { id, limit: 1, ...(cursor ? { cursor } : {}) }, deps);
      if (calls === 0) {
        // 12 páginas de una entrada, todas privadas: nada visible todavía, pero NO es el final.
        expect(page.versions).toEqual([]);
        expect(page.nextCursor).toMatch(/^vs1\./u);
      }
      seen.push(...page.versions.map((version) => version.versionId));
      cursor = page.nextCursor ?? undefined;
      calls += 1;
    } while (cursor !== undefined && calls < 10);
    expect(seen).toEqual([9, 4]);
    expect(cursor).toBeUndefined();
  });

  it('sin space todo sigue como hoy: sin source, y source "server" no vale', async () => {
    const { id } = await setup();
    const listed = await runListVersions(await fresh(), { id });
    expect(listed).not.toHaveProperty('source');
    const { versionedNoteVersionId: versionId } = test!.library;
    await expect(runReadVersion(await fresh(), { id, versionId, source: 'server' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
