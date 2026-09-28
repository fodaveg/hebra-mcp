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
import { isBusyOtherInstance } from '../../src/store/errors';
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
  async function pair() {
    const dataDir = tempDataDir();
    const relay = new InMemoryLibraryRelay();
    const sync = { transport: relay, identity: IDENTITY, vaultKey: VAULT_KEY, intervalMs: null };
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
    // Ni acciones de carpetas: fuera del MCP (opción A de David, 28 sep 2026).
    for (const action of ['createFolder', 'renameFolder', 'moveFolder']) {
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
      editNote: async (input) => ({ id: input.id, outcome: 'saved' as const, revision: 'r1.x' }),
      recordEditConflict: async () => undefined,
      organize: async (input) => ({
        id: input.id,
        folderId: 'root',
        favorite: false,
        archived: false
      }),
      noteRead: async () => null,
      onConflictCopy: () => () => undefined,
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
