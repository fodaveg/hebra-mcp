/**
 * Reenvío de escrituras del lector al escritor (SPEC.md §8) EN PROCESO: dos
 * `LibraryInstance` sobre el mismo directorio de datos, el escritor con sync sobre el
 * relé en memoria de Hebra (`InMemoryLibraryRelay`) y otra app de Hebra
 * (`test/sync/devices.ts`) editando a la vez.
 *
 * Aquí va lo que con procesos `serve` reales (`test/e2e/writer-forward.test.ts`) no se
 * puede montar sin un relé real: la copia de conflicto que produce la ronda del escritor
 * y el estado de sync del escritor visto desde el lector. Además, el protocolo del
 * socket por su cuenta: 0600, límite de tamaño, líneas inválidas, socket ajeno al cerrar
 * y las ramas del lector cuando el escritor no responde.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_MESSAGE_BYTES,
  WRITER_SOCKET_FILE,
  WriterRemoteError,
  WriterSocketServer,
  WriterUnavailableError,
  requestWriter,
  type WriterSocketHandlers
} from '../../src/ipc/writer-socket';
import { registerTools } from '../../src/server/register-tools';
import type { ServerContext } from '../../src/server/context';
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
  writerSocketHandlers,
  type ForwardingInstance
} from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { buildWriteContext, type WriteContext } from '../../src/server/write-context';
import { isBusyOtherInstance, StoreError } from '../../src/store/errors';
import { mapWriteError } from '../../src/server/tools/write-errors';
import { CREATE_BODY_MAX_LENGTH } from '../../src/store/writes';
import { EDITS_TOTAL_MAX_LENGTH } from '../../src/store/edits';
import { LibraryInstance } from '../../src/sync/library-instance';
import {
  IDENTITY,
  InMemoryLibraryRelay,
  VAULT_KEY,
  allBodies,
  appCreate,
  appDevice,
  appSave
} from '../sync/devices';

const BAIT_TEXT = 'CEBO-TEXTO-conflicto-3b8e';
/** Configuración de privados vacía, para las peticiones crudas al socket. */
const OPEN = { privateFolders: [], privateTags: [] };

const dirs: string[] = [];
const children: ChildProcess[] = [];
const instances: LibraryInstance[] = [];
const clients: Array<{ client: Client; server: McpServer }> = [];
const servers: Array<WriterSocketServer | Server> = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-fwdp-'));
  dirs.push(dir);
  return dir;
}

/** Un proceso vivo cuyo PID declara el lector (así no puede tomar el bloqueo). */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function connect(ctx: ServerContext): Promise<Client> {
  const server = new McpServer({ name: 'hebra-mcp-forward-test', version: '0.0.0' });
  registerTools(server, ctx);
  const client = new Client({ name: 'hebra-mcp-forward-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  clients.push({ client, server });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: result.isError === true, value: JSON.parse(textOf(result)) as Record<string, unknown> };
}

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const { client, server } of clients.splice(0)) {
    await client.close();
    await server.close();
  }
  for (const instance of instances.splice(0)) await instance.close();
  for (const server of servers.splice(0)) {
    if (server instanceof WriterSocketServer) await server.close();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

describe('escritor y lector en proceso, con sync sobre el relé en memoria', () => {
  async function pair(options: { blobs?: boolean } = {}) {
    const dataDir = tempDataDir();
    const relay = new InMemoryLibraryRelay();
    const sync = {
      transport: relay,
      blobTransport: options.blobs ? relay : null,
      identity: IDENTITY,
      vaultKey: VAULT_KEY,
      intervalMs: null
    };
    const writer = await LibraryInstance.open({
      dataDir,
      sync,
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
    });
    instances.push(writer);
    await writer.whenReady(5_000);
    const reader = await LibraryInstance.open({
      dataDir,
      sync,
      checkIntervalMs: null,
      lock: { releaseOnExit: false, pid: livePid() }
    });
    instances.push(reader);
    const readerCtx: ServerContext = {
      port: reader.port,
      privacyConfig: { privateFolders: [], privateTags: [] },
      status: new RoutedStatusSource(reader, true),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    };
    return { dataDir, relay, writer, reader, client: await connect(readerCtx) };
  }

  it('el socket del escritor queda en 0600 y el lector no abre ninguno', async () => {
    const { dataDir, writer, reader } = await pair();
    expect(writer.role).toBe('this');
    expect(writer.servingWriterSocket).toBe(true);
    expect(reader.role).toBe('other_instance');
    expect(reader.servingWriterSocket).toBe(false);
    expect(statSync(join(dataDir, WRITER_SOCKET_FILE)).mode & 0o777).toBe(0o600);
  });

  it('un conflict_copy de la ronda del escritor llega al lector con su copyId', async () => {
    const { relay, writer, client } = await pair();
    const app = await appDevice(relay);

    const id = await appCreate(app, '# Compartida\n\ntexto base');
    await app.sync.runRound();
    await writer.syncRunner!.requestRound();

    // El Mac edita y sincroniza; el escritor aún tiene la versión vieja.
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    await app.sync.runRound();

    const result = await call(client, 'hebra_append_to_note', { id, text: BAIT_TEXT });
    expect(result.isError).toBe(false);
    expect(result.value.outcome).toBe('conflict_copy');
    expect(typeof result.value.copyId).toBe('string');
    expect(result.value.copyId).not.toBe(id);

    // La copia la lee el lector (WAL) con el texto añadido; ningún texto se perdió.
    const copy = await call(client, 'hebra_read_note', { id: result.value.copyId as string });
    expect(copy.value).toMatchObject({ isConflictCopy: true, conflictOf: id });
    const joined = (await allBodies(writer.port))
      .filter((note) => note.id === id || note.conflictOf === id)
      .map((note) => note.body)
      .join('\n---\n');
    expect(joined).toContain('EDICIÓN DEL MAC');
    expect(joined).toContain(BAIT_TEXT);

    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).toContain('"event":"write.forward","op":"appendToNote","outcome":"forwarded"');
  });

  it('hebra_append_to_note con operationId desde un lector: el reintento lo sirve el registro del escritor', async () => {
    const { writer, client } = await pair();
    const created = await writer.createNote({ body: '# Registro\n\nuno', privacy: OPEN });
    const args = { id: created.id, text: BAIT_TEXT, operationId: 'op-fwd-append-1' };
    const first = await call(client, 'hebra_append_to_note', args);
    expect(first.isError).toBe(false);
    expect(first.value).toMatchObject({ outcome: 'saved', appended: { tail: BAIT_TEXT } });
    const retry = await call(client, 'hebra_append_to_note', args);
    expect(retry.value).toEqual({ ...first.value, replayed: true });
    expect((await writer.port.noteRead(created.id))?.body).toBe(`# Registro\n\nuno\n\n${BAIT_TEXT}`);
    // Otra petición con el mismo id: el rechazo cruza el socket con su código.
    const reused = await call(client, 'hebra_append_to_note', { ...args, text: 'otro' });
    expect(reused).toEqual({ isError: true, value: { error: 'operation_id_reused' } });
    expect(stderrText()).not.toContain(BAIT_TEXT);
    // El escritor de esta versión devuelve el `operationId`: el lector no avisa de nada.
    expect(stderrText()).not.toContain('forward.operation_id_ignored');
  });

  it('hebra_append_to_note con operationId: la copia de conflicto de la ronda queda anotada para el reintento', async () => {
    const { relay, writer, client } = await pair();
    const app = await appDevice(relay);
    const id = await appCreate(app, '# Compartida\n\ntexto base');
    await app.sync.runRound();
    await writer.syncRunner!.requestRound();
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    await app.sync.runRound();

    const args = { id, text: BAIT_TEXT, operationId: 'op-fwd-append-2' };
    const first = await call(client, 'hebra_append_to_note', args);
    expect(first.value.outcome).toBe('conflict_copy');
    const retry = await call(client, 'hebra_append_to_note', args);
    expect(retry.value).toEqual({ ...first.value, replayed: true });
    const copies = (await allBodies(writer.port)).filter(
      (note) => (note.id === id || note.conflictOf === id) && note.body.includes(BAIT_TEXT)
    );
    expect(copies).toHaveLength(1);
  });

  it('hebra_status de un lector es el estado de sync del escritor, con writer other_instance', async () => {
    const { client } = await pair();
    const status = await call(client, 'hebra_status');
    expect(status.value).toMatchObject({
      linked: true,
      writer: 'other_instance',
      lastSyncOutcome: 'ok',
      revoked: false,
      pendingUpload: 0
    });
    expect(typeof status.value.lastSyncAt).toBe('string');
  });

  it('el filtro de privados del LECTOR se aplica antes de reenviar', async () => {
    const { writer, reader } = await pair();
    const hidden = await writer.createNote({ body: '# Secreta\n\n#privado', privacy: OPEN });
    const ctx: ServerContext = {
      port: reader.port,
      privacyConfig: { privateFolders: [], privateTags: ['privado'] },
      status: new RoutedStatusSource(reader, true),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    };
    const client = await connect(ctx);
    const result = await call(client, 'hebra_append_to_note', { id: hidden.id, text: 'no llega' });
    expect(result).toEqual({ isError: true, value: { error: 'not_found' } });
    expect((await writer.port.noteRead(hidden.id))?.body).not.toContain('no llega');
    expect(stderrText()).not.toContain('"event":"write.forward"');
  });

  it('hebra_edit_note desde un lector: la edita el escritor, con su ronda y su estado de sync', async () => {
    const { writer, client } = await pair();
    const created = await writer.createNote({ body: '# Reenviada\n\nuno dos tres', privacy: OPEN });
    const read = await call(client, 'hebra_read_note', { id: created.id });
    const args = {
      id: created.id,
      edits: [{ find: 'dos', replace: BAIT_TEXT }],
      expectedRevision: read.value.revision,
      operationId: 'op-fwd-1'
    };
    const result = await call(client, 'hebra_edit_note', args);
    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({ id: created.id, outcome: 'saved', sync: 'uploaded' });
    expect((await writer.port.noteRead(created.id))?.body).toBe(`# Reenviada\n\nuno ${BAIT_TEXT} tres`);

    // El mismo operationId por el socket: no repite.
    const again = await call(client, 'hebra_edit_note', args);
    expect(again.value).toMatchObject({ outcome: 'saved', replayed: true });

    // Un rechazo con índice cruza el socket con su índice, sin el texto.
    const reread = await call(client, 'hebra_read_note', { id: created.id });
    const missing = await call(client, 'hebra_edit_note', {
      ...args,
      edits: [
        { find: 'uno', replace: '1' },
        { find: 'no está', replace: 'x' }
      ],
      expectedRevision: reread.value.revision,
      operationId: 'op-fwd-2'
    });
    expect(missing).toEqual({ isError: true, value: { error: 'no_match', edit: 1 } });

    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).toContain('"event":"write.forward","op":"editNote","outcome":"forwarded"');
  });

  it('hebra_append_to_note con heading desde un lector: el apartado se resuelve en el escritor, con su prueba (D11)', async () => {
    const { writer, client } = await pair();
    const body = '# Decisiones\n\n## Uno\ntexto uno\n\n## Dos\ntexto dos\n\n## Dos\notro\n';
    const created = await writer.createNote({ body, privacy: OPEN });

    const saved = await call(client, 'hebra_append_to_note', {
      id: created.id,
      text: BAIT_TEXT,
      heading: 'uno'
    });
    expect(saved.isError).toBe(false);
    const stored = (await writer.port.noteRead(created.id))!.body;
    expect(stored).toBe(body.replace('texto uno\n\n## Dos', `texto uno\n\n${BAIT_TEXT}\n\n## Dos`));
    expect(saved.value).toMatchObject({
      id: created.id,
      outcome: 'saved',
      totalChars: stored.length,
      appended: { chars: BAIT_TEXT.length, tail: BAIT_TEXT, line: 6, heading: 'Uno' }
    });
    expect(typeof saved.value.revision).toBe('string');

    // Los dos errores nuevos cruzan el socket (el segundo, con sus candidatos) y no escriben.
    const missing = await call(client, 'hebra_append_to_note', { id: created.id, text: 'x', heading: 'Nada' });
    expect(missing).toEqual({ isError: true, value: { error: 'heading_not_found' } });
    const ambiguous = await call(client, 'hebra_append_to_note', { id: created.id, text: 'x', heading: 'Dos' });
    expect(ambiguous).toEqual({
      isError: true,
      value: {
        error: 'ambiguous_heading',
        candidates: [
          { heading: 'Dos', level: 2, line: 8, occurrence: 1 },
          { heading: 'Dos', level: 2, line: 11, occurrence: 2 }
        ]
      }
    });
    expect((await writer.port.noteRead(created.id))!.body).toBe(stored);

    // `headingOccurrence` cruza también el socket.
    const second = await call(client, 'hebra_append_to_note', {
      id: created.id,
      text: 'final',
      heading: 'Dos',
      headingOccurrence: 2
    });
    expect(second.value).toMatchObject({ outcome: 'saved', appended: { tail: 'final', heading: 'Dos' } });
    expect((await writer.port.noteRead(created.id))!.body.endsWith('## Dos\notro\n\nfinal\n')).toBe(true);

    // Ni el título del apartado ni el texto llegan al log.
    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).not.toContain('"heading":"');
    expect(stderrText()).toContain('"event":"write.forward","op":"appendToNote","outcome":"forwarded"');
  });

  it('50 títulos repetidos de 6 000 caracteres: ambiguous_heading llega con candidatos de 200 como mucho (D11)', async () => {
    const { writer, client } = await pair();
    // Seis mil caracteres que se normalizan a 'T T' (espacios colapsados): el cliente puede
    // pedirlo con un `heading` corto, pero el título guardado es largo.
    const long = `T${' '.repeat(5_998)}T`;
    const short = 'T T';
    const body = Array.from({ length: 50 }, () => `## ${long}\ntexto\n`).join('\n');
    const created = await writer.createNote({ body, privacy: OPEN });
    const result = await call(client, 'hebra_append_to_note', { id: created.id, text: 'x', heading: short });
    expect(result.isError).toBe(true);
    expect(result.value.error).toBe('ambiguous_heading');
    const candidates = result.value.candidates as Array<{ heading: string; occurrence: number }>;
    expect(candidates).toHaveLength(50);
    for (const candidate of candidates) {
      expect(candidate.heading.length).toBeLessThanOrEqual(200);
      expect(candidate.heading).toBe(long.slice(0, 200));
    }
    // Con una aparición, el título de `appended.heading` también viaja cortado.
    const saved = await call(client, 'hebra_append_to_note', {
      id: created.id,
      text: 'x',
      heading: short,
      headingOccurrence: 2
    });
    expect((saved.value.appended as { heading: string }).heading).toBe(long.slice(0, 200));
    // La lectura directa no cruza el socket: `section.heading` sale entero.
    const read = await call(client, 'hebra_read_note', { id: created.id, heading: short, headingOccurrence: 1 });
    expect((read.value.section as { heading: string }).heading).toBe(long);
  });

  it('candidates solo se adjunta a ambiguous_heading: con otro código se descartan (D11)', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, 'fake.sock');
    const fake = createServer((socket) => {
      socket.once('data', (chunk) => {
        const request = JSON.parse(String(chunk)) as { id: number };
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: 'not_found',
            candidates: [{ heading: 'X', level: 1, line: 1, occurrence: 1 }]
          })}\n`
        );
      });
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(path, resolve));
    const error = (await requestWriter(path, 'appendToNote', { id: 'n', text: 'x', privacy: OPEN }, 2_000).catch(
      (caught: unknown) => caught
    )) as { code: string; candidates?: unknown };
    expect(error.code).toBe('not_found');
    expect(error.candidates).toBeUndefined();
    expect(mapWriteError(error).extra).toBeUndefined();
    // Y `mapWriteError` también lo descarta si le llega pegado a otro código.
    expect(mapWriteError(new StoreError('not_found', undefined, [{ heading: 'X', level: 1, line: 1, occurrence: 1 }])).extra).toBeUndefined();
  });

  it('hebra_edit_note desde un lector trae applied y totalChars del cuerpo guardado (D11)', async () => {
    const { writer, client } = await pair();
    const created = await writer.createNote({ body: '# Reenviada\n\nuno dos tres', privacy: OPEN });
    const read = await call(client, 'hebra_read_note', { id: created.id });
    const result = await call(client, 'hebra_edit_note', {
      id: created.id,
      edits: [
        { find: 'dos', replace: 'DOS' },
        { find: 'uno', replace: '' }
      ],
      expectedRevision: read.value.revision,
      operationId: 'op-fwd-proof'
    });
    const stored = (await writer.port.noteRead(created.id))!.body;
    expect(result.value).toMatchObject({
      outcome: 'saved',
      totalChars: stored.length,
      applied: [
        { chars: 3, tail: 'DOS' },
        { chars: 0, tail: '' }
      ]
    });
    // El reintento por el socket devuelve la misma prueba del registro.
    const again = await call(client, 'hebra_edit_note', {
      id: created.id,
      edits: [
        { find: 'dos', replace: 'DOS' },
        { find: 'uno', replace: '' }
      ],
      expectedRevision: read.value.revision,
      operationId: 'op-fwd-proof'
    });
    expect(again.value).toMatchObject({ replayed: true, applied: [{ chars: 3, tail: 'DOS' }, { chars: 0, tail: '' }] });
  });

  it('organización desde un lector: la hace el escritor, con la privacidad del lector', async () => {
    const { relay, writer, reader } = await pair();
    const created = await writer.createNote({ body: '# Organizada\n\ntexto', privacy: OPEN });
    // Las carpetas se crean en la app (el MCP no las gestiona, opción A de David) y llegan
    // al escritor por sync; el lector las ve en la misma SQLite (WAL).
    // La app entra primero en la biblioteca (con contenido local de antes, el motor se
    // niega a fusionar: `library_merge_refused`) y después crea las carpetas.
    const app = await appDevice(relay);
    expect((await app.sync.runRound()).result).toBe('ok');
    const privada = await app.engine.folderCreate(null, 'Privada');
    const publica = await app.engine.folderCreate(null, 'Pública');
    expect((await app.sync.runRound()).result).toBe('ok');
    await writer.syncRunner!.requestRound();
    const ctx: ServerContext = {
      port: reader.port,
      privacyConfig: { privateFolders: [['privada']], privateTags: [] },
      status: new RoutedStatusSource(reader, true),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    };
    const client = await connect(ctx);

    const moved = await call(client, 'hebra_move_note', { id: created.id, folderId: publica.id });
    expect(moved.value).toMatchObject({ folderPath: 'pública', sync: 'uploaded' });
    expect((await writer.port.noteRead(created.id))?.folderId).toBe(publica.id);

    // Hacia la carpeta privada del LECTOR: la herramienta la rechaza antes de reenviar…
    expect(await call(client, 'hebra_move_note', { id: created.id, folderId: privada.id })).toEqual({
      isError: true,
      value: { error: 'not_found' }
    });
    // …y si la petición llega al escritor por el socket, él la rechaza con la misma
    // configuración, dentro del turno en que escribiría.
    const direct = await buildRoutedWriteContext(reader, localWriteContext(reader))
      .organize({
        action: 'moveNote',
        id: created.id,
        folderId: privada.id,
        privacy: ctx.privacyConfig
      })
      .catch((error: unknown) => error);
    expect(direct).toMatchObject({ code: 'not_found' });
    expect((await writer.port.noteRead(created.id))?.folderId).toBe(publica.id);
    expect(stderrText()).toContain('"event":"write.forward","op":"organize","outcome":"forwarded"');
  });

  it('papelera y versiones desde un lector: las hace el escritor, con la privacidad del lector', async () => {
    const { writer, reader, client } = await pair();
    const created = await writer.createNote({ body: '# Reenviada\n\nuno dos tres', privacy: OPEN });

    expect((await call(client, 'hebra_trash_note', { id: created.id })).value).toEqual({
      id: created.id,
      trashed: true,
      sync: 'uploaded'
    });
    expect((await writer.port.noteRead(created.id))?.trashedAt).not.toBeNull();
    const listed = (await call(client, 'hebra_list_trash')).value.notes as Array<{ id: string }>;
    expect(listed.map((note) => note.id)).toContain(created.id);
    expect((await call(client, 'hebra_restore_note', { id: created.id })).value).toMatchObject({
      id: created.id,
      folderPath: '',
      sync: 'uploaded'
    });
    expect((await writer.port.noteRead(created.id))?.trashedAt).toBeNull();

    // Una edición deja la versión; restaurarla desde el lector la guarda el escritor.
    const read = await call(client, 'hebra_read_note', { id: created.id });
    await call(client, 'hebra_edit_note', {
      id: created.id,
      edits: [{ find: 'dos', replace: BAIT_TEXT }],
      expectedRevision: read.value.revision,
      operationId: 'op-fwd-version-1'
    });
    const versions = (await call(client, 'hebra_list_versions', { id: created.id })).value
      .versions as Array<{ versionId: number }>;
    expect(versions).toHaveLength(1);
    const reread = await call(client, 'hebra_read_note', { id: created.id });
    const restored = await call(client, 'hebra_restore_version', {
      id: created.id,
      versionId: versions[0]!.versionId,
      expectedRevision: reread.value.revision,
      operationId: 'op-fwd-version-2'
    });
    expect(restored.value).toMatchObject({ id: created.id, outcome: 'saved', sync: 'uploaded' });
    expect((await writer.port.noteRead(created.id))?.body).toBe('# Reenviada\n\nuno dos tres');

    // La configuración del LECTOR viaja con la petición y el escritor la aplica dentro del
    // turno: con una carpeta configurada que no existe, cerrado ante la duda, sin escribir.
    const routedWrite = buildRoutedWriteContext(reader, localWriteContext(reader));
    await routedWrite.organize({ action: 'trashNote', id: created.id, privacy: OPEN });
    const direct = await routedWrite
      .organize({
        action: 'restoreNote',
        id: created.id,
        privacy: { privateFolders: [['no-existe']], privateTags: [] }
      })
      .catch((error: unknown) => error);
    expect(direct).toMatchObject({ code: 'privacy_config_unresolved' });
    expect((await writer.port.noteRead(created.id))?.trashedAt).not.toBeNull();

    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).toContain('"event":"write.forward","op":"organize","outcome":"forwarded"');
    expect(stderrText()).toContain('"event":"write.forward","op":"restoreVersion","outcome":"forwarded"');
  });

  it('ficheros sueltos desde un lector (D10): los manda y los saca el escritor, con la privacidad del lector', async () => {
    const { relay, writer, reader, client } = await pair({ blobs: true });
    // El fichero nace en otro dispositivo y baja al escritor: hebra-mcp no crea ficheros.
    const app = await appDevice(relay, 'Mac', { blobs: true });
    const blob = await app.engine.blobPut(new TextEncoder().encode('bytes del plano'), {
      mime: 'application/pdf'
    });
    const file = await app.engine.fileCreate(null, 'plano-reenviado.pdf', blob.sha256);
    await app.sync.runRound();
    await writer.syncRunner!.requestRound();

    // La lista la sirve el propio lector, de la SQLite compartida.
    const listed = (await call(client, 'hebra_list_files')).value.files as Array<{ id: string }>;
    expect(listed.map((entry) => entry.id)).toEqual([file.id]);

    expect((await call(client, 'hebra_trash_file', { id: file.id })).value).toEqual({
      id: file.id,
      trashed: true,
      sync: 'uploaded'
    });
    await app.sync.runRound();
    expect(app.engine.filesTrashPage(null, 10).items.map((item) => item.id)).toEqual([file.id]);
    const trashed = (await call(client, 'hebra_list_files', { trashed: true })).value.files as Array<{
      id: string;
    }>;
    expect(trashed.map((entry) => entry.id)).toEqual([file.id]);

    expect((await call(client, 'hebra_restore_file', { id: file.id })).value).toEqual({
      id: file.id,
      folderPath: '',
      sync: 'uploaded'
    });
    await app.sync.runRound();
    expect(app.engine.filesTrashPage(null, 10).items).toEqual([]);

    // La configuración del LECTOR viaja con la petición y el escritor la aplica dentro del
    // turno: con una carpeta configurada que no existe, cerrado ante la duda, sin escribir.
    const routedWrite = buildRoutedWriteContext(reader, localWriteContext(reader));
    const direct = await routedWrite
      .organizeFile({
        action: 'trashFile',
        id: file.id,
        privacy: { privateFolders: [['no-existe']], privateTags: [] }
      })
      .catch((error: unknown) => error);
    expect(direct).toMatchObject({ code: 'privacy_config_unresolved' });
    // Y un id que no es de un fichero, `not_found`, también por el socket.
    const missing = await routedWrite
      .organizeFile({ action: 'trashFile', id: 'no-existe', privacy: OPEN })
      .catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: 'not_found' });
    expect((await writer.port.filesIndex()).files.map((entry) => entry.trashedAt)).toEqual([null]);

    expect(stderrText()).toContain('"event":"write.forward","op":"organizeFile","outcome":"forwarded"');
    expect(stderrText()).toContain('"event":"write.forward","op":"organizeFile","outcome":"remote_error"');
    expect(stderrText()).not.toContain('plano-reenviado');
  });

  it('adjunto desde un lector: el escritor lo baja al disco compartido y el lector lo lee de ahí', async () => {
    const { relay, writer, client } = await pair({ blobs: true });
    const app = await appDevice(relay, 'Mac', { blobs: true });
    expect((await app.sync.runRound()).result).toBe('ok');
    const text = `${BAIT_TEXT} dentro de un adjunto\n`;
    const sha = (await app.engine.blobPut(new TextEncoder().encode(text), { mime: 'text/plain' })).sha256;
    const id = await appCreate(app, `# Con adjunto\n\n![[sha256:${sha}|${BAIT_TEXT}.txt]]\n`);
    expect((await app.sync.runRound()).result).toBe('ok');
    await writer.syncRunner!.requestRound();
    expect(await writer.port.blobRead(sha)).toBeNull();

    const result = (await client.callTool({
      name: 'hebra_read_attachment',
      arguments: { id, attachmentId: sha }
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.content[1]).toEqual({ type: 'text', text });
    expect(await writer.port.blobRead(sha)).not.toBeNull();

    // Por el socket solo viajó `{available}`, y ni el nombre ni el contenido van a stderr.
    expect(stderrText()).toContain('"event":"write.forward","op":"fetchAttachment","outcome":"forwarded"');
    expect(stderrText()).toContain('"event":"attachment.fetch","outcome":"ok"');
    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).not.toContain(sha);
  });

  it('carpetas y adjuntos desde un lector (D9): los hace el escritor por writer.sock, con la privacidad del lector', async () => {
    const { writer, reader } = await pair({ blobs: true });
    const ctx: ServerContext = {
      port: reader.port,
      privacyConfig: { privateFolders: [['privada']], privateTags: [] },
      status: new RoutedStatusSource(reader, true),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    };
    // La carpeta privada del LECTOR existe (la crea el escritor sin filtro: el MCP del
    // escritor no tiene privados).
    await writer.createFolderLocal({ parentId: 'root', name: 'Privada', privacy: OPEN });
    const client = await connect(ctx);

    const created = await call(client, 'hebra_create_folder', { name: BAIT_TEXT });
    expect(created.value).toMatchObject({ path: BAIT_TEXT.toLowerCase(), created: true, sync: 'uploaded' });
    const folderId = created.value.id as string;
    expect((await writer.port.foldersList()).folders.find((folder) => folder.id === folderId)?.name).toBe(
      BAIT_TEXT
    );
    const renamed = await call(client, 'hebra_rename_folder', { folderId, name: 'Audits' });
    expect(renamed.value).toEqual({ id: folderId, path: 'audits', renamed: true, sync: 'uploaded' });

    // La ruta privada del lector: la rechaza la herramienta antes de reenviar…
    expect(await call(client, 'hebra_create_folder', { name: 'Privada' })).toEqual({
      isError: true,
      value: { error: 'folder_unavailable' }
    });
    // …y el escritor, con la misma configuración, si le llega por el socket.
    const direct = await ctx.write!
      .createFolder({ parentId: 'root', name: 'privada', privacy: ctx.privacyConfig })
      .catch((error: unknown) => error);
    expect(direct).toMatchObject({ code: 'folder_unavailable' });

    const note = await writer.createNote({ body: '# Con captura\n\ntexto', privacy: OPEN });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const added = await call(client, 'hebra_add_attachment', {
      id: note.id,
      name: `${BAIT_TEXT}.png`,
      dataBase64: png.toString('base64'),
      operationId: 'op-fwd-adjunto'
    });
    expect(added.value).toMatchObject({ id: note.id, outcome: 'saved', sync: 'uploaded' });
    const sha = added.value.attachmentId as string;
    expect((await writer.port.noteRead(note.id))?.body).toBe(
      `# Con captura\n\ntexto\n\n![[sha256:${sha}|${BAIT_TEXT}.png]]`
    );
    expect(await writer.port.blobRead(sha)).toEqual(new Uint8Array(png));
    expect(await writer.port.blobUploaded(sha)).toBe(true);
    // Reintento por el socket: el escritor lo reconoce por su `operationId`.
    const again = await call(client, 'hebra_add_attachment', {
      id: note.id,
      name: `${BAIT_TEXT}.png`,
      dataBase64: png.toString('base64'),
      operationId: 'op-fwd-adjunto'
    });
    expect(again.value).toMatchObject({ outcome: 'saved', replayed: true });

    for (const op of ['createFolder', 'renameFolder', 'addAttachment']) {
      expect(stderrText()).toContain(`"event":"write.forward","op":"${op}","outcome":"forwarded"`);
    }
    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).not.toContain(sha);
  });

  it('la configuración de privados del LECTOR la aplica el escritor dentro de la escritura', async () => {
    const { writer, reader } = await pair();
    const created = await writer.createNote({ body: '# Visible\n\ntexto', privacy: OPEN });
    const ctx: ServerContext = {
      port: reader.port,
      privacyConfig: { privateFolders: [], privateTags: ['privado'] },
      status: new RoutedStatusSource(reader, true),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    };
    const client = await connect(ctx);
    const read = await call(client, 'hebra_read_note', { id: created.id });
    // Etiquetar hacia privado por edición del Markdown: como un destino inexistente.
    const result = await call(client, 'hebra_edit_note', {
      id: created.id,
      edits: [{ find: 'texto', replace: 'texto #privado' }],
      expectedRevision: read.value.revision,
      operationId: 'op-fwd-privado'
    });
    expect(result).toEqual({ isError: true, value: { error: 'not_found' } });
    expect((await writer.port.noteRead(created.id))?.body).toBe('# Visible\n\ntexto');
    // La rechazó el ESCRITOR (el lector no mira el cuerpo resultante): hubo reenvío.
    expect(stderrText()).toContain('"event":"write.forward","op":"editNote","outcome":"remote_error"');
  });
});

describe('protocolo de writer.sock', () => {
  const handlers: WriterSocketHandlers = {
    createNote: async (input) => ({ id: 'n1', title: 't', folderId: input.folderId ?? 'root' }),
    appendToNote: async (input) => ({ id: input.id, outcome: 'saved' }),
    editNote: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: 'r1.x',
      sync: 'not_linked'
    }),
    organize: async (input) => ({
      id: input.id,
      folderId: 'root',
      favorite: false,
      archived: false,
      trashed: input.action === 'trashNote',
      sync: 'not_linked'
    }),
    restoreVersion: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: `r1.v${input.versionId}`,
      sync: 'not_linked'
    }),
    fetchAttachment: async (input) => ({ available: input.sha256.startsWith('a') }),
    createFolder: async (input) => ({ id: `f-${input.parentId}`, changed: true, sync: 'not_linked' }),
    renameFolder: async (input) => ({ id: input.id, changed: true, sync: 'not_linked' }),
    addAttachment: async (input) => ({
      id: input.id,
      outcome: 'saved',
      revision: 'r1.x',
      attachmentId: 'a'.repeat(64),
      markdown: `![[sha256:${'a'.repeat(64)}|${input.name}]]`,
      sync: 'not_linked'
    }),
    organizeFile: async (input) => ({
      id: input.id,
      folderId: 'root',
      trashed: input.action === 'trashFile',
      sync: 'not_linked'
    }),
    status: async () => ({
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: 0,
      errorsByCode: {},
      revoked: false
    })
  };

  async function listen(dataDir: string, maxMessageBytes?: number): Promise<WriterSocketServer> {
    const server = await WriterSocketServer.listen({
      path: join(dataDir, WRITER_SOCKET_FILE),
      handlers,
      maxMessageBytes
    });
    servers.push(server);
    return server;
  }

  /** Manda `payload` crudo y devuelve lo que responda el escritor hasta cerrar. */
  function raw(path: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = '';
      const socket = createConnection(path, () => socket.write(payload));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (out += chunk));
      socket.on('error', () => undefined);
      socket.once('close', () => resolve(out));
      setTimeout(() => reject(new Error('sin cierre')), 5_000).unref();
    });
  }

  it('borra un writer.sock huérfano al escuchar y queda en 0600', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    writeFileSync(path, 'huérfano');
    await listen(dataDir);
    expect(statSync(path).isSocket()).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      await requestWriter(path, 'createNote', { body: '# x', folderId: null, privacy: OPEN }, 2_000)
    ).toEqual({
      id: 'n1',
      title: 't',
      folderId: 'root'
    });
  });

  it('una línea mayor que el límite se rechaza sin leerla entera y se cierra la conexión', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir, 1_024);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const response = await raw(path, 'x'.repeat(4_096));
    expect(JSON.parse(response)).toEqual({ id: null, ok: false, error: 'message_too_large' });
    // El cliente lo recibe como respuesta del escritor, no como escritor caído.
    await expect(
      requestWriter(path, 'createNote', { body: 'y'.repeat(2_048), folderId: null }, 2_000)
    ).rejects.toBeInstanceOf(WriterRemoteError);
  });

  it('appendToNote lleva operationId opcional hasta el escritor; uno inválido es invalid_request', async () => {
    const seen: Array<string | undefined> = [];
    const path = join(tempDataDir(), WRITER_SOCKET_FILE);
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...handlers,
        appendToNote: async (input) => {
          seen.push(input.operationId);
          return { id: input.id, outcome: 'saved', replayed: true };
        }
      }
    });
    servers.push(server);
    expect(
      await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', operationId: 'op-1', privacy: OPEN }, 2_000)
    ).toEqual({ id: 'n1', outcome: 'saved', replayed: true });
    await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', privacy: OPEN }, 2_000);
    expect(seen).toEqual(['op-1', undefined]);
    for (const operationId of ['', 'o'.repeat(201), 7]) {
      await expect(
        requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', operationId, privacy: OPEN }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(seen).toHaveLength(2);
  });

  describe('conexiones ociosas (B4)', () => {
    /** Escucha con un plazo de ociosidad corto y un `appendToNote` que tarda `slowMs`. */
    async function listenIdle(idleTimeoutMs: number, slowMs = 0) {
      const path = join(tempDataDir(), WRITER_SOCKET_FILE);
      const server = await WriterSocketServer.listen({
        path,
        idleTimeoutMs,
        handlers: {
          ...handlers,
          appendToNote: async (input) => {
            await new Promise((resolve) => setTimeout(resolve, slowMs));
            return { id: input.id, outcome: 'saved' };
          }
        }
      });
      servers.push(server);
      return path;
    }

    /** Conecta, manda `payload` (o nada) y resuelve cuando el escritor cierra. */
    function closedByWriter(path: string, payload: string | null): Promise<{ data: string; ms: number }> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        let data = '';
        const socket = createConnection(path, () => {
          if (payload !== null) socket.write(payload);
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (data += chunk));
        socket.on('error', () => undefined);
        socket.once('close', () => resolve({ data, ms: Date.now() - started }));
        setTimeout(() => {
          socket.destroy();
          reject(new Error('el escritor no cerró la conexión ociosa'));
        }, 5_000).unref();
      });
    }

    it('una conexión que no manda nada se cierra pasado el plazo', async () => {
      const path = await listenIdle(150);
      const { data } = await closedByWriter(path, null);
      expect(data).toBe('');
    });

    it('una línea a medias (sin salto de línea) se cierra pasado el plazo, sin responder', async () => {
      const path = await listenIdle(150);
      const { data } = await closedByWriter(path, '{"id":1,"op":"status","params":{}');
      expect(data).toBe('');
    });

    it('una petición en curso más larga que el plazo no se corta', async () => {
      const path = await listenIdle(100, 400);
      expect(
        await requestWriter(path, 'appendToNote', { id: 'n1', text: 'x', privacy: OPEN }, 5_000)
      ).toEqual({ id: 'n1', outcome: 'saved' });
    });
  });

  it('el límite por defecto admite el cuerpo máximo de §5 en el peor escape JSON', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'createNote',
      params: { body: '\u0001'.repeat(CREATE_BODY_MAX_LENGTH), folderId: null }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('el escritor vuelve a comprobar los límites de §5 y rechaza JSON inválido', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    await expect(
      requestWriter(path, 'createNote', { body: 'x'.repeat(CREATE_BODY_MAX_LENGTH + 1) }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'appendToNote', { id: 'n1', text: 'x'.repeat(20_001), privacy: OPEN }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Sin la privacidad del lector, ninguna escritura: el escritor no supone la suya.
    await expect(
      requestWriter(path, 'createNote', { body: '# x', folderId: null }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'appendToNote', { id: 'n1', text: 'x' }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestWriter(path, 'organize', { action: 'setFavorite', id: 'n1', favorite: true }, 2_000)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // Ni acciones de carpetas dentro de `organize`: crear y renombrar son ops propias desde
    // D9 (3 oct 2026), y mover o borrar carpetas no lo es ninguna.
    for (const action of ['createFolder', 'renameFolder', 'moveFolder', 'trashFolder']) {
      await expect(
        requestWriter(
          path,
          'organize',
          { action, id: 'f1', parentId: 'root', name: 'x', privacy: OPEN },
          2_000
        )
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(JSON.parse(await raw(path, 'no es json\n'))).toEqual({
      id: null,
      ok: false,
      error: 'invalid_request'
    });
  });

  it('editNote: el escritor exige la privacidad del lector y revalida los límites', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const valid = {
      id: 'n1',
      edits: [{ find: 'a', replace: 'b' }],
      expectedRevision: 'r1.x',
      operationId: 'op',
      privacy: { privateFolders: [['diario']], privateTags: ['secreto'] }
    };
    expect(await requestWriter(path, 'editNote', valid, 2_000)).toMatchObject({ outcome: 'saved' });
    for (const params of [
      { ...valid, privacy: null },
      { ...valid, privacy: { privateFolders: ['diario'], privateTags: [] } },
      { ...valid, edits: [] },
      { ...valid, edits: [{ find: '', replace: 'x' }] },
      { ...valid, edits: [{ find: 'a', replace: 'x'.repeat(EDITS_TOTAL_MAX_LENGTH) }] },
      { ...valid, operationId: '' }
    ]) {
      await expect(requestWriter(path, 'editNote', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('papelera y restoreVersion por el socket: privacidad obligatoria, entrada revalidada y sin purga', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const privacy = { privateFolders: [['diario']], privateTags: ['secreto'] };
    for (const action of ['trashNote', 'restoreNote']) {
      expect(await requestWriter(path, 'organize', { action, id: 'n1', privacy }, 2_000)).toMatchObject({
        id: 'n1',
        trashed: action === 'trashNote'
      });
      await expect(
        requestWriter(path, 'organize', { action, id: 'n1' }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ninguna acción de purga ni de vaciar la papelera existe en el protocolo.
    for (const action of ['purgeNote', 'notePurge', 'emptyTrash', 'trashEmpty']) {
      await expect(
        requestWriter(path, 'organize', { action, id: 'n1', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }

    const valid = { id: 'n1', versionId: 7, expectedRevision: 'r1.x', operationId: 'op', privacy };
    expect(await requestWriter(path, 'restoreVersion', valid, 2_000)).toMatchObject({
      outcome: 'saved',
      revision: 'r1.v7'
    });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, versionId: 0 },
      { ...valid, versionId: 1.5 },
      { ...valid, versionId: '7' },
      { ...valid, operationId: '' },
      { ...valid, expectedRevision: 'x'.repeat(2_000) }
    ]) {
      await expect(requestWriter(path, 'restoreVersion', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('organizeFile por el socket (D10): solo mandar y sacar, privacidad obligatoria y sin purga', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const privacy = { privateFolders: [['diario']], privateTags: ['secreto'] };
    for (const action of ['trashFile', 'restoreFile']) {
      expect(
        await requestWriter(path, 'organizeFile', { action, id: 'f1', privacy }, 2_000)
      ).toEqual({ id: 'f1', folderId: 'root', trashed: action === 'trashFile', sync: 'not_linked' });
      // Sin la privacidad del lector, nada: el escritor no supone la suya.
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 'f1' }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        requestWriter(path, 'organizeFile', { action, id: '', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 7, privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      // Y no son acciones de `organize`, que solo admite las de nota.
      await expect(
        requestWriter(path, 'organize', { action, id: 'f1', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ninguna otra acción de ficheros existe en el protocolo: ni purgar o vaciar la
    // papelera, ni crear, renombrar, mover o reemplazar, ni las de nota por esta op.
    for (const action of [
      'purgeFile',
      'filePurge',
      'emptyTrash',
      'trashEmpty',
      'deleteFile',
      'createFile',
      'fileCreate',
      'renameFile',
      'fileRename',
      'moveFile',
      'fileMove',
      'replaceFile',
      'fileReplace',
      'readFile',
      'trashNote',
      'restoreNote'
    ]) {
      await expect(
        requestWriter(path, 'organizeFile', { action, id: 'f1', name: 'x', folderId: 'root', privacy }, 2_000)
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    // Ni como operación propia del socket.
    for (const op of ['purgeFile', 'filePurge', 'trashFile', 'restoreFile', 'createFile', 'moveFile']) {
      expect(
        JSON.parse(await raw(path, `${JSON.stringify({ id: 1, op, params: { id: 'f1', privacy } })}\n`))
      ).toEqual({ id: null, ok: false, error: 'invalid_request' });
    }
  });

  it('fetchAttachment por el socket: privacidad obligatoria, hash validado y respuesta sin bytes', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const valid = { noteId: 'n1', sha256: 'a'.repeat(64), privacy: OPEN };
    expect(await requestWriter(path, 'fetchAttachment', valid, 2_000)).toEqual({ available: true });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, sha256: 'A'.repeat(64) },
      { ...valid, sha256: '../../etc/passwd' },
      { ...valid, sha256: 'a'.repeat(63) },
      { ...valid, noteId: '' }
    ]) {
      await expect(requestWriter(path, 'fetchAttachment', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
  });

  it('carpetas y addAttachment por el socket (D9): privacidad obligatoria, entrada revalidada', async () => {
    const dataDir = tempDataDir();
    await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    expect(
      await requestWriter(path, 'createFolder', { parentId: 'root', name: 'x', privacy: OPEN }, 2_000)
    ).toMatchObject({ id: 'f-root', changed: true });
    expect(await requestWriter(path, 'renameFolder', { id: 'f1', name: 'x', privacy: OPEN }, 2_000)).toMatchObject({
      id: 'f1',
      changed: true
    });
    for (const [op, params] of [
      ['createFolder', { parentId: 'root', name: 'x' }],
      ['createFolder', { parentId: '', name: 'x', privacy: OPEN }],
      ['createFolder', { parentId: 'root', name: 'x'.repeat(1_025), privacy: OPEN }],
      ['renameFolder', { id: 'f1', name: 'x' }],
      ['renameFolder', { id: 'f1', name: 7, privacy: OPEN }]
    ] as const) {
      await expect(requestWriter(path, op, params, 2_000)).rejects.toMatchObject({ code: 'invalid_request' });
    }

    const valid = {
      id: 'n1',
      name: 'a.txt',
      dataBase64: Buffer.from('hola').toString('base64'),
      mimeType: 'text/plain',
      operationId: 'op-1',
      privacy: OPEN
    };
    expect(await requestWriter(path, 'addAttachment', valid, 2_000)).toMatchObject({
      id: 'n1',
      outcome: 'saved'
    });
    for (const params of [
      { ...valid, privacy: undefined },
      { ...valid, dataBase64: 'no es base64!' },
      { ...valid, dataBase64: '' },
      { ...valid, operationId: '' },
      { ...valid, mimeType: 7 },
      { ...valid, id: '' }
    ]) {
      await expect(requestWriter(path, 'addAttachment', params, 2_000)).rejects.toMatchObject({
        code: 'invalid_request'
      });
    }
    // Un adjunto de 5 MiB cabe en una línea; uno de 5 MiB + 1 cabe en la línea pero el
    // escritor lo rechaza con su código.
    const max = Buffer.alloc(5 * 1024 * 1024, 0x61).toString('base64');
    expect(
      await requestWriter(path, 'addAttachment', { ...valid, dataBase64: max }, 10_000)
    ).toMatchObject({ outcome: 'saved' });
    const over = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61).toString('base64');
    await expect(
      requestWriter(path, 'addAttachment', { ...valid, dataBase64: over }, 10_000)
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
  });

  it('una sola petición en vuelo por conexión: varias líneas seguidas se atienden en orden, de una en una', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...handlers,
        createFolder: async (input) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(input.name);
          inFlight -= 1;
          return { id: input.name, changed: true, sync: 'not_linked' };
        }
      }
    });
    servers.push(server);
    const names = ['uno', 'dos', 'tres', 'cuatro'];
    const lines = names
      .map((name, index) =>
        JSON.stringify({ id: index, op: 'createFolder', params: { parentId: 'root', name, privacy: OPEN } })
      )
      .join('\n');
    const responses = await new Promise<string[]>((resolve, reject) => {
      let out = '';
      const socket = createConnection(path, () => socket.write(`${lines}\n`));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        out += chunk;
        const received = out.split('\n').filter((line) => line.length > 0);
        if (received.length === names.length) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('sin respuesta')), 5_000).unref();
    });
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(names);
    expect(responses.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([0, 1, 2, 3]);
  });

  it('el límite por defecto admite el base64 de un adjunto de 5 MiB con su sobre (D9)', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'addAttachment',
      params: {
        id: 'x'.repeat(200),
        name: '\u0001'.repeat(1_024),
        dataBase64: Buffer.alloc(5 * 1024 * 1024).toString('base64'),
        mimeType: '\u0001'.repeat(255),
        operationId: '\u0001'.repeat(200),
        privacy: OPEN
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(MAX_MESSAGE_BYTES).toBe(7_514_796);
  });

  it('el límite por defecto admite las sustituciones máximas de editNote en el peor escape JSON', () => {
    const worst = JSON.stringify({
      id: 1,
      op: 'editNote',
      params: {
        id: 'x'.repeat(200),
        edits: Array.from({ length: 50 }, () => ({
          find: '\u0001'.repeat(EDITS_TOTAL_MAX_LENGTH / 100),
          replace: '\u0001'.repeat(EDITS_TOTAL_MAX_LENGTH / 100)
        })),
        expectedRevision: 'r'.repeat(1_024),
        operationId: 'o'.repeat(200),
        privacy: { privateFolders: [['diario']], privateTags: ['secreto'] }
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThan(MAX_MESSAGE_BYTES);
  });

  it('al cerrar no borra un writer.sock que ya es de otro escritor', async () => {
    const dataDir = tempDataDir();
    const old = await listen(dataDir);
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const newer = await listen(dataDir); // borra el de `old` y escucha en su sitio
    const newerInode = statSync(path).ino;
    await old.close();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).ino).toBe(newerInode);
    await newer.close();
    expect(existsSync(path)).toBe(false);
  });

  it('cliente: sin socket, nadie escuchando y sin respuesta a tiempo', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    await expect(requestWriter(path, 'status', {}, 1_000)).rejects.toMatchObject({
      reason: 'no_socket'
    });
    writeFileSync(path, '');
    await expect(requestWriter(path, 'status', {}, 1_000)).rejects.toMatchObject({
      reason: 'refused'
    });
    rmSync(path);
    const silent = createServer((socket) => socket.resume());
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    await expect(requestWriter(path, 'status', {}, 200)).rejects.toMatchObject({
      reason: 'timeout'
    });
  });
});

describe('lector: qué hace cuando el escritor no responde', () => {
  function fakeInstance(path: string, afterCheck: 'this' | 'other_instance') {
    let role: 'this' | 'other_instance' = 'other_instance';
    const instance: ForwardingInstance = {
      get role() {
        return role;
      },
      writerSocketPath: path,
      checkWriter: vi.fn(async () => {
        role = afterCheck;
      }),
      status: async () => ({
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false,
        writer: role
      })
    };
    return instance;
  }

  /** `WriteContext` local de mentira que cuenta cuántas notas «creó». */
  function localSpy(): WriteContext & { readonly created: number } {
    const counter = { created: 0 };
    const write = buildWriteContext({
      createNote: async () => {
        counter.created += 1;
        return { id: 'local', title: 'local', folderId: 'root' };
      },
      appendToNote: async (input) => ({ id: input.id, outcome: 'saved' as const }),
      editNote: async (input) => ({
        result: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
        wrote: true
      }),
      recordEditConflict: async () => undefined,
      organize: async (input) => ({
        result: { id: input.id, folderId: 'root', favorite: false, archived: false, trashed: false },
        wrote: true
      }),
      restoreVersion: async (input) => ({
        result: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
        wrote: true
      }),
      fetchAttachment: async () => false,
      createFolder: async (input) => ({ result: { id: input.parentId, changed: true }, wrote: true }),
      renameFolder: async (input) => ({ result: { id: input.id, changed: true }, wrote: true }),
      addAttachment: async (input) => ({
        result: {
          note: { id: input.id, outcome: 'saved' as const, revision: 'r1.x' },
          attachmentId: 'a'.repeat(64),
          markdown: ''
        },
        wrote: true
      }),
      organizeFile: async (input) => ({
        result: { id: input.id, folderId: 'root', trashed: input.action === 'trashFile' },
        wrote: true
      }),
      noteRead: async () => null,
      folderDirty: async () => null,
      blobUploaded: async () => null,
      looseFileDirty: async () => null,
      onConflictCopy: () => () => undefined,
      isLinked: () => false,
      requestRound: async () => null
    });
    // `defineProperty`, no `Object.assign`: este copiaría el valor del getter una vez.
    return Object.defineProperty(write, 'created', { get: () => counter.created }) as WriteContext & {
      readonly created: number;
    };
  }

  it('escritor vivo pero mudo (timeout) y bloqueo ajeno: busy_other_instance', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const silent = createServer((socket) => socket.resume());
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(path, resolve));
    const instance = fakeInstance(path, 'other_instance');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local, { timeoutMs: { createNote: 200 } });
    const error = await write.createNote({ body: '# x', privacy: OPEN }).catch((caught: unknown) => caught);
    expect(isBusyOtherInstance(error)).toBe(true);
    expect(instance.checkWriter).toHaveBeenCalledOnce();
    expect(local.created).toBe(0);
    expect(stderrText()).toContain('"outcome":"busy","reason":"timeout"');
  });

  it('conexión cortada tras enviar: toma el relevo pero NO repite la escritura', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const dying = createServer((socket) => socket.once('data', () => socket.destroy()));
    servers.push(dying);
    await new Promise<void>((resolve) => dying.listen(path, resolve));
    const instance = fakeInstance(path, 'this');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    const error = await write.createNote({ body: '# x', privacy: OPEN }).catch((caught: unknown) => caught);
    expect(isBusyOtherInstance(error)).toBe(true);
    expect(instance.role).toBe('this');
    expect(local.created).toBe(0);
    // La siguiente ya es local.
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(local.created).toBe(1);
  });

  it('escritor recién muerto aún sin recoger (zombi): segundo intento de relevo a los 100 ms (B2)', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    // Fichero sin nadie escuchando, como el socket de un escritor muerto por SIGKILL.
    writeFileSync(path, '');
    let checks = 0;
    let role: 'this' | 'other_instance' = 'other_instance';
    const instance: ForwardingInstance = {
      get role() {
        return role;
      },
      writerSocketPath: path,
      // El primero aún lo ve vivo (zombi); el segundo, ya recogido, toma el bloqueo.
      checkWriter: vi.fn(async () => {
        checks += 1;
        if (checks === 2) role = 'this';
      }),
      status: async () => ({
        lastSyncAt: null,
        lastSyncOutcome: null,
        pendingUpload: 0,
        errorsByCode: {},
        revoked: false,
        writer: role
      })
    };
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    const started = Date.now();
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(instance.checkWriter).toHaveBeenCalledTimes(2);
    expect(local.created).toBe(1);
    expect(stderrText()).toContain('"outcome":"takeover","reason":"refused"');
  });

  it('escritor de una versión anterior que ignora el operationId de un append: lo registra y devuelve su respuesta', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const received: Array<Record<string, unknown>> = [];
    // Un escritor anterior: guarda y responde sin `operationId` (no lo conoce).
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        ...writerSocketHandlers(localSpy(), fakeInstance(path, 'this')),
        appendToNote: async (input) => {
          received.push({ ...input });
          return { id: input.id, outcome: 'saved', revision: 'r1.x', totalChars: 9 };
        }
      }
    });
    servers.push(server);
    const write = buildRoutedWriteContext(fakeInstance(path, 'other_instance'), localSpy());
    const text = 'CEBO-escritor-viejo-4e1a';
    const result = await write.appendToNote({ id: 'n1', text, operationId: 'op-viejo', privacy: OPEN });
    // El texto se guardó: la respuesta es la del escritor, sin error y sin `replayed`.
    expect(result).toEqual({ id: 'n1', outcome: 'saved', revision: 'r1.x', totalChars: 9 });
    expect(received).toHaveLength(1);
    expect(stderrText()).toContain('"event":"forward.operation_id_ignored","op":"appendToNote"');
    expect(stderrText()).not.toContain(text);
    expect(stderrText()).not.toContain('"n1"');

    // Sin `operationId` no hay nada que avisar.
    await write.appendToNote({ id: 'n1', text, privacy: OPEN });
    expect(stderrText().split('forward.operation_id_ignored').length - 1).toBe(1);
  });

  it('el escritor actual devuelve el operationId del append', async () => {
    const handlers = writerSocketHandlers(localSpy(), fakeInstance('', 'this'));
    expect(
      await handlers.appendToNote({ id: 'n1', text: 'x', operationId: 'op-eco', privacy: OPEN })
    ).toMatchObject({ id: 'n1', outcome: 'saved', operationId: 'op-eco' });
    expect(await handlers.appendToNote({ id: 'n1', text: 'x', privacy: OPEN })).not.toHaveProperty(
      'operationId'
    );
  });

  it('sin escritor: toma el relevo y escribe en local', async () => {
    const dataDir = tempDataDir();
    const instance = fakeInstance(join(dataDir, WRITER_SOCKET_FILE), 'this');
    const local = localSpy();
    const write = buildRoutedWriteContext(instance, local);
    expect(await write.createNote({ body: '# x', privacy: OPEN })).toMatchObject({ id: 'local' });
    expect(local.created).toBe(1);
    expect(stderrText()).toContain('"outcome":"takeover","reason":"no_socket"');
  });

  it('hebra_status sin escritor que responda: intenta el relevo y da el estado local', async () => {
    const dataDir = tempDataDir();
    const instance = fakeInstance(join(dataDir, WRITER_SOCKET_FILE), 'other_instance');
    const status = await new RoutedStatusSource(instance, false).getStatus();
    expect(status).toMatchObject({ linked: false, writer: 'other_instance', lastSyncAt: null });
    expect(instance.checkWriter).toHaveBeenCalledOnce();
  });

  it('un error del escritor que no es de disponibilidad no provoca relevo', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, WRITER_SOCKET_FILE);
    const server = await WriterSocketServer.listen({
      path,
      handlers: {
        createNote: async () => {
          throw new Error('fallo con texto que no debe viajar');
        },
        appendToNote: async () => {
          throw new Error('x');
        },
        editNote: async () => {
          throw new Error('x');
        },
        organize: async () => {
          throw new Error('x');
        },
        restoreVersion: async () => {
          throw new Error('x');
        },
        fetchAttachment: async () => {
          throw new Error('x');
        },
        createFolder: async () => {
          throw new Error('x');
        },
        renameFolder: async () => {
          throw new Error('x');
        },
        addAttachment: async () => {
          throw new Error('x');
        },
        organizeFile: async () => {
          throw new Error('x');
        },
        status: async () => {
          throw new Error('x');
        }
      }
    });
    servers.push(server);
    const instance = fakeInstance(path, 'this');
    const write = buildRoutedWriteContext(instance, localSpy());
    const error = await write
      .createNote({ body: '# x', privacy: OPEN })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WriterRemoteError);
    expect((error as WriterRemoteError).code).toBe('internal');
    expect(instance.checkWriter).not.toHaveBeenCalled();
    expect(stderrText()).not.toContain('fallo con texto');
    expect(error).not.toBeInstanceOf(WriterUnavailableError);
  });
});
