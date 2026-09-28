/**
 * `serve-http` (SPEC.md §12.1, lote C2): el transporte Streamable HTTP sin estado con el
 * cliente HTTP del SDK, las defensas de la app (Host, tope de cuerpo, 405, `/healthz`,
 * nada de token en la URL) y el arranque (`startServeHttp`): sin autenticación no abre
 * nada, y siempre es el escritor.
 *
 * La autenticación aquí es un bearer fijo de prueba (`staticBearerAuth`): el OAuth de
 * verdad (C3) tiene sus propios tests en `test/http/oauth.test.ts`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MCP_BODY_BYTES } from '../../src/http/app';
import { GrantSecrets } from '../../src/oauth/grants';
import { MemorySecretStore } from '../../src/secrets';
import { httpConfigFor } from '../../src/http/config';
import { ServeHttpError, startServeHttp, type ServeHttpHandle } from '../../src/http/serve-http';
import { WriterRequiredError } from '../../src/server/serve';
import { APPEND_SEPARATOR } from '../../src/store/writes';
import { EDITS_TOTAL_MAX_LENGTH } from '../../src/store/edits';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_FOLDER, BAIT_TAG } from '../fixtures/test-library';
import { baitCalls } from '../fixtures/bait-calls';
import { TOOL_NAMES } from '../fixtures/tool-names';
import {
  connectHttpClient,
  startTestHttpApp,
  staticBearerAuth,
  textOf,
  type TestHttpApp
} from '../fixtures/http-app';

const TOKEN = 'token-de-prueba-c2';

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;
let test: TestContext | undefined;
let app: TestHttpApp | undefined;
const clients: Client[] = [];
const handles: ServeHttpHandle[] = [];
const dirs: string[] = [];

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await app?.close();
  app = undefined;
  await test?.close();
  test = undefined;
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

async function startWithTestLibrary(): Promise<{ test: TestContext; app: TestHttpApp; client: Client }> {
  test = await buildTestContext();
  app = await startTestHttpApp(test.serverContext, staticBearerAuth(TOKEN));
  const client = await connectHttpClient(app.origin, TOKEN);
  clients.push(client);
  return { test, app, client };
}

describe('todas las herramientas por el cliente HTTP del SDK', () => {
  it('tools/list trae todas y ninguna devuelve ni loguea el cebo', async () => {
    const { test, client } = await startWithTestLibrary();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);

    // Las mismas llamadas que el test por `InMemoryTransport` (`test/privacy-and-logs.test.ts`).
    const calls = baitCalls(test.library);
    const texts: string[] = [];
    for (const call of calls) {
      const result = (await client.callTool(call)) as CallToolResult;
      // Las de notas ocultas responden `not_found` (`isError`), pero todas responden.
      expect(result.content.length).toBeGreaterThan(0);
      texts.push(textOf(result));
    }
    // Todas respondieron algo (sin error de transporte), y ninguna con el cebo.
    expect([...new Set(calls.map((call) => call.name))].sort()).toEqual(TOOL_NAMES);
    const output = texts.join('\n');
    expect(output).not.toContain(BAIT_FOLDER);
    expect(output).not.toContain(BAIT_TAG);

    const logged = stderrText();
    expect(logged).not.toContain(BAIT_FOLDER);
    expect(logged).not.toContain(BAIT_TAG);
    expect(logged).not.toContain(test.library.publicNoteTitle);
    expect(logged).not.toContain(test.library.privateFolderNoteId);
    expect(logged).not.toContain(TOKEN);
    // Cada línea es un evento cerrado en JSON; las de HTTP, con ruta de un conjunto cerrado.
    for (const line of logged.split('\n').filter((entry) => entry.trim() !== '')) {
      const parsed = JSON.parse(line) as { event: string; route?: string };
      if (parsed.event === 'http.request') expect(parsed.route).toBe('/mcp');
    }
  });

  it('dos hebra_append_to_note concurrentes a la misma nota: los dos textos, en orden de llegada', async () => {
    const { test, client } = await startWithTestLibrary();
    const id = test.library.publicNote2Id;
    const before = await test.ctx.port.noteRead(id);
    const [first, second] = await Promise.all([
      client.callTool({ name: 'hebra_append_to_note', arguments: { id, text: 'Primero.' } }),
      client.callTool({ name: 'hebra_append_to_note', arguments: { id, text: 'Segundo.' } })
    ]);
    expect(JSON.parse(textOf(first as CallToolResult))).toEqual({ id, outcome: 'saved' });
    expect(JSON.parse(textOf(second as CallToolResult))).toEqual({ id, outcome: 'saved' });
    const after = await test.ctx.port.noteRead(id);
    const body = after?.body ?? '';
    expect(body.startsWith(before?.body ?? '')).toBe(true);
    const tail = body.slice((before?.body ?? '').length);
    expect([
      `${APPEND_SEPARATOR}Primero.${APPEND_SEPARATOR}Segundo.`,
      `${APPEND_SEPARATOR}Segundo.${APPEND_SEPARATOR}Primero.`
    ]).toContain(tail);
  });

  it('hebra_edit_note por HTTP: el mismo contrato y los mismos límites que por stdio', async () => {
    const { test, client } = await startWithTestLibrary();
    const id = test.library.publicNote2Id;
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return { isError: result.isError === true, value: JSON.parse(textOf(result)) as Record<string, unknown> };
    };
    const read = await call('hebra_read_note', { id });
    const edited = await call('hebra_edit_note', {
      id,
      edits: [{ find: 'Texto normal', replace: 'Texto por HTTP' }],
      expectedRevision: read.value.revision,
      operationId: 'op-http-1'
    });
    expect(edited.value).toMatchObject({ id, outcome: 'saved', sync: 'not_linked' });
    const reread = await call('hebra_read_note', { id });
    expect(reread.value.body).toContain('Texto por HTTP');

    // El tope de las sustituciones (100 000 caracteres) en el peor escape JSON cabe en el
    // cuerpo HTTP: llega a la herramienta (aquí, `no_match`), no es un 413.
    const worst = '\u0001'.repeat(EDITS_TOTAL_MAX_LENGTH / 2);
    const atLimit = await call('hebra_edit_note', {
      id,
      edits: [{ find: worst, replace: worst }],
      expectedRevision: reread.value.revision,
      operationId: 'op-http-2'
    });
    expect(atLimit).toEqual({ isError: true, value: { error: 'no_match', edit: 0 } });
    const overLimit = await call('hebra_edit_note', {
      id,
      edits: [{ find: worst, replace: `${worst}x` }],
      expectedRevision: reread.value.revision,
      operationId: 'op-http-3'
    });
    expect(overLimit).toEqual({ isError: true, value: { error: 'invalid_input' } });
  });
});

describe('defensas de la app', () => {
  it('/healthz: 204 sin cuerpo y sin autenticación', async () => {
    await startWithTestLibrary();
    const response = await fetch(`${app!.origin}/healthz`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('POST /mcp sin token: 401 sin leer el cuerpo', async () => {
    await startWithTestLibrary();
    const response = await fetch(`${app!.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(response.status).toBe(401);
  });

  it('GET y DELETE /mcp: 405 (sin estado)', async () => {
    await startWithTestLibrary();
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${app!.origin}/mcp`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}` }
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('nada bajo /mcp/…: el token no puede ir en la URL', async () => {
    await startWithTestLibrary();
    const response = await fetch(`${app!.origin}/mcp/${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    expect(response.status).toBe(404);
    expect(stderrText()).not.toContain(TOKEN);
  });

  it('Host u Origin ajenos: 403', async () => {
    await startWithTestLibrary();
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${app!.origin}/healthz`,
        { headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    const withOrigin = await fetch(`${app!.origin}/healthz`, {
      headers: { origin: 'https://evil.example' }
    });
    expect(withOrigin.status).toBe(403);
  });

  it(`cuerpo de más de ${MAX_MCP_BODY_BYTES} bytes: 413`, async () => {
    await startWithTestLibrary();
    const response = await fetch(`${app!.origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { pad: 'x'.repeat(MAX_MCP_BODY_BYTES) } })
    });
    expect(response.status).toBe(413);
  });

  it('JSON inválido: 400 sin citar el cuerpo en stderr', async () => {
    await startWithTestLibrary();
    const response = await fetch(`${app!.origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: `{"texto": "${BAIT_FOLDER}"`
    });
    expect(response.status).toBe(400);
    expect(stderrText()).not.toContain(BAIT_FOLDER);
  });
});

describe('arranque de serve-http', () => {
  function tempDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-http-'));
    dirs.push(dir);
    return dir;
  }

  it('sin autenticación configurada no arranca ni abre la biblioteca', async () => {
    const dataDir = tempDataDir();
    await expect(
      startServeHttp({
        dataDir,
        secrets: null,
        config: httpConfigFor('http://127.0.0.1', 0),
        version: '0.0.0-test',
        authConfigured: () => false,
        loadAuth: async () => null
      })
    ).rejects.toBeInstanceOf(ServeHttpError);
    expect(existsSync(join(dataDir, 'library.sqlite'))).toBe(false);
    expect(existsSync(join(dataDir, 'writer.lock'))).toBe(false);
  });

  it('arranca como escritor; un segundo serve-http sobre el mismo directorio no arranca', async () => {
    const dataDir = tempDataDir();
    const handle = await startServeHttp({
      dataDir,
      secrets: null,
      config: httpConfigFor('http://127.0.0.1', 0),
      version: '0.0.0-test',
      authConfigured: () => true,
      loadAuth: async () => staticBearerAuth(TOKEN),
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false } }
    });
    handles.push(handle);
    expect(handle.serve.instance.role).toBe('this');

    const client = await connectHttpClient(`http://127.0.0.1:${handle.port}`, TOKEN);
    clients.push(client);
    const status = JSON.parse(
      textOf((await client.callTool({ name: 'hebra_status', arguments: {} })) as CallToolResult)
    );
    expect(status).toMatchObject({ linked: false, writer: 'this' });

    await expect(
      startServeHttp({
        dataDir,
        secrets: null,
        config: httpConfigFor('http://127.0.0.1', 0),
        version: '0.0.0-test',
        authConfigured: () => true,
        loadAuth: async () => staticBearerAuth(TOKEN),
        instance: { checkIntervalMs: null, lock: { releaseOnExit: false, pid: 999_999, isAlive: () => true } }
      })
    ).rejects.toBeInstanceOf(WriterRequiredError);
  });

  it('un segundo arranque no recupera ni revoca concesiones pendientes del escritor', async () => {
    const dataDir = tempDataDir();
    const secrets = new MemorySecretStore();
    const config = httpConfigFor('http://127.0.0.1', 0);
    const first = await startServeHttp({ dataDir, secrets, config, version: '0.0.0-test',
      authConfigured: () => true, loadAuth: async () => staticBearerAuth(TOKEN),
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false } } });
    handles.push(first);
    const grants = await GrantSecrets.open(secrets, []);
    await grants.stage('aa'.repeat(32), 'bb'.repeat(32));
    let recoveries = 0;
    await expect(startServeHttp({ dataDir, secrets, config, version: '0.0.0-test',
      authConfigured: () => true,
      loadAuth: async () => {
        recoveries += 1;
        await GrantSecrets.recoverPending(secrets, [], grants, async () => { throw new Error('should not revoke'); });
        return staticBearerAuth(TOKEN);
      },
      instance: { checkIntervalMs: null, lock: { releaseOnExit: false, pid: 999_999, isAlive: () => true } }
    })).rejects.toBeInstanceOf(WriterRequiredError);
    expect(recoveries).toBe(0);
    expect(await secrets.get('hebra-mcp-oauth-pending')).toContain('bb'.repeat(32));
  });
});
