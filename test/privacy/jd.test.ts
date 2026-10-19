/**
 * Privacidad de `hebra_jd_new_id` y `hebra_jd_audit` (D18, 19 oct 2026; SPEC.md §6.3): lo
 * privado no existe para el MCP. Una categoría con algo que quien pide no ve no admite IDs
 * nuevos (`category_has_hidden`, uno para todo), sin decir qué ni qué número:
 * - una carpeta privada dentro de la categoría;
 * - una nota privada del JDex con el prefijo de la categoría;
 * - una carpeta privada fuera del árbol, con el prefijo de la categoría;
 * - con el JDex oculto, no se puede crear nada;
 * - una plantilla oculta: la de serie, y la simulación lo dice;
 * - en ningún caso sale el nombre ni el número de lo oculto, ni en la respuesta ni en el log;
 * - la auditoría no lo nombra ni lo cuenta.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { buildRoutedWriteContext, RoutedStatusSource, writerSocketHandlers } from '../../src/server/forward';
import { registerTools } from '../../src/server/register-tools';
import { localWriteContext } from '../../src/server/serve';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { LibraryInstance, LIBRARY_SQLITE_FILE } from '../../src/sync/library-instance';
import { startJd, type JdHarness } from '../fixtures/jd-library';
import { createNote } from '../fixtures/test-library';

const HAS_HIDDEN = { isError: true, value: { error: 'category_has_hidden' } };

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][]).map(([line]) => String(line)).join('');
}

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = undefined;
});

describe('Johnny.Decimal (D18): privacidad', () => {
  let h: JdHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  /** Ni la respuesta ni el log nombran lo oculto. */
  function expectHidden(result: unknown, secrets: string[]): void {
    const text = JSON.stringify(result) + stderrText();
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  }

  async function simulate(category: string, args: Record<string, unknown> = {}) {
    return h!.call('hebra_jd_new_id', { mode: 'simulate', category, title: 'Nuevo', ...args });
  }

  it('una carpeta privada dentro de la categoría da category_has_hidden, sin nombrarla', async () => {
    h = await startJd({
      extraPrivateFolders: [['20-29 trabajo', '21 productos', '21.15 secreto']],
      prepare: async (engine, ids) => {
        await engine.folderCreate(ids.category21, '21.15 Secreto');
      }
    });
    const result = await simulate('21');
    expect(result).toEqual(HAS_HIDDEN);
    expectHidden(result, ['21.15', '21.16', 'Secreto']);
    // Las demás categorías siguen: el 22 no tiene nada oculto.
    expect((await simulate('22')).value).toMatchObject({ mode: 'simulate', id: '22.11' });
  });

  it('una nota privada del JDex con el prefijo de la categoría da lo mismo', async () => {
    h = await startJd({
      prepare: async (engine, ids) => {
        await createNote(engine, ids.jdex, '# 21.17 Nota privada\n\n#secreto\n');
      }
    });
    const result = await simulate('21');
    expect(result).toEqual(HAS_HIDDEN);
    expectHidden(result, ['21.17', '21.18', 'privada']);
    expect((await simulate('22')).isError).toBe(false);
  });

  it('una carpeta privada fuera del árbol, con el prefijo de la categoría, da lo mismo', async () => {
    h = await startJd({
      prepare: async (engine) => {
        const diario = (await engine.foldersList()).folders.find((folder) => folder.name === 'Diario')!;
        await engine.folderCreate(diario.id, '21.16 Fuera');
      }
    });
    const result = await simulate('21');
    expect(result).toEqual(HAS_HIDDEN);
    expectHidden(result, ['21.16', 'Fuera', 'Diario']);
    expect((await simulate('22')).isError).toBe(false);
  });

  it('con el JDex oculto no se puede crear nada, tampoco señalando otro JDex visible', async () => {
    h = await startJd({
      extraPrivateFolders: [['00-09 sistema', '00 sistema', '00.00 jdex']],
      prepare: async (engine) => {
        const otros = await engine.folderCreate(null, 'Otros');
        await engine.folderCreate(otros.id, '00.00 Copia del JDex');
      }
    });
    const foldersBefore = h.rawFolders();
    const notesBefore = h.rawNotes();
    expect(await simulate('21')).toEqual({ isError: true, value: { error: 'jdex_not_found' } });
    expect(await simulate('21', { jdexFolderId: h.ids.jdex })).toEqual({ isError: true, value: { error: 'jdex_not_found' } });
    const copy = h.rawFolders().find((folder) => folder.name === '00.00 Copia del JDex')!;
    for (const category of ['21', '22']) {
      const result = await simulate(category, { jdexFolderId: copy.id });
      expect(result, category).toEqual(HAS_HIDDEN);
      expectHidden(result, [h.ids.jdex, '00.00 JDex', '21.11', '21.12']);
    }
    expect(await h.call('hebra_jd_audit', {})).toEqual({ isError: true, value: { error: 'jdex_not_found' } });
    expect(h.rawFolders()).toEqual(foldersBefore);
    expect(h.rawNotes()).toEqual(notesBefore);
  });

  it('una plantilla oculta: se usa la de serie y la simulación lo dice', async () => {
    h = await startJd({ templateSuffix: '\n#secreto\n' });
    const result = await simulate('21');
    expect(result.isError, JSON.stringify(result.value)).toBe(false);
    expect(result.value.template).toEqual({ source: 'builtin' });
    const writes = result.value.writes as Array<{ kind: string; body?: string }>;
    expect(writes[0]!.body).not.toContain('Plantilla propia');
    expectHidden(result, [h.ids.templateNote, 'Plantilla propia', 'secreto']);
    // Y se aplica igual, con la de serie.
    const applied = await h.call('hebra_jd_new_id', { mode: 'apply', planId: result.value.planId, operationId: 'op-t' });
    expect(applied.isError, JSON.stringify(applied.value)).toBe(false);
    expect(h.rawNotes().find((note) => note.title === '21.13 Nuevo')!.body).toContain('## Dónde vive');
  });

  it('un título con una etiqueta privada se rechaza en la simulación, sin escribir', async () => {
    h = await startJd();
    const result = await simulate('21', { title: 'Algo #secreto' });
    expect(result).toEqual({ isError: true, value: { error: 'not_found' } });
    expect(h.rawNotes().some((note) => note.title.startsWith('21.13'))).toBe(false);
  });

  it('la auditoría no nombra ni cuenta lo oculto', async () => {
    h = await startJd({
      extraPrivateFolders: [['20-29 trabajo', '21 productos', '21.15 secreto']],
      prepare: async (engine, ids) => {
        await engine.folderCreate(ids.category21, '21.15 Secreto');
        await engine.folderCreate(ids.category21, '21.11 Repetida oculta');
        await createNote(engine, ids.jdex, '# 21.17 Nota privada\n\n#secreto\n');
      }
    });
    const visible = await h.call('hebra_jd_audit', {});
    expect(visible.isError, JSON.stringify(visible.value)).toBe(false);
    expectHidden(visible, ['21.15', 'Secreto', '21.17', 'privada']);
    // La carpeta repetida es visible: esa sí sale.
    const findings = visible.value.findings as Array<{ kind: string; number?: string }>;
    expect(findings.some((finding) => finding.kind === 'duplicate-id' && finding.number === '21.11')).toBe(true);
  });
});

describe('reenvío lector→escritor (D18)', () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  const instances: LibraryInstance[] = [];
  const clients: Array<{ client: Client; server: McpServer }> = [];

  afterEach(async () => {
    for (const { client, server } of clients.splice(0)) {
      await client.close();
      await server.close();
    }
    for (const instance of instances.splice(0)) await instance.close();
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('simular y aplicar desde un lector: el plan vive en el escritor, que escribe con la privacidad del lector', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hebra-mcp-jd-fwd-'));
    dirs.push(dataDir);
    const writer = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false },
      writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
    });
    instances.push(writer);
    // El sistema JD, escrito por otra conexión, como la app.
    const { db, conn } = openNodeSqliteConn(join(dataDir, LIBRARY_SQLITE_FILE));
    let category21 = '';
    try {
      const engine = await SqliteLibraryEngine.open(conn, 'otro-dispositivo', { journalMode: 'WAL' });
      const area0 = await engine.folderCreate(null, '00-09 Sistema');
      const cat00 = await engine.folderCreate(area0.id, '00 Sistema');
      const jdex = await engine.folderCreate(cat00.id, '00.00 JDex');
      const area2 = await engine.folderCreate(null, '20-29 Trabajo');
      category21 = (await engine.folderCreate(area2.id, '21 Productos')).id;
      await engine.folderCreate(category21, '21.11 Uno');
      await createNote(engine, jdex.id, '# 21.11 Uno\n');
      await engine.folderCreate(area2.id, '22 Otra');
      const privado = await engine.folderCreate(null, 'Privado');
      await engine.folderCreate(privado.id, '22.40 Oculta');
    } finally {
      db.close();
    }
    // Un proceso vivo declara el bloqueo del lector: no puede tomarlo y reenvía.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    const reader = await LibraryInstance.open({
      dataDir,
      checkIntervalMs: null,
      lock: { releaseOnExit: false, pid: child.pid! }
    });
    instances.push(reader);
    expect(reader.role).toBe('other_instance');
    const privacy: PrivacyConfig = { privateFolders: [['privado']], privateTags: [] };
    const server = new McpServer({ name: 'hebra-mcp-jd-fwd', version: '0.0.0' });
    registerTools(server, {
      port: reader.port,
      privacyConfig: privacy,
      status: new RoutedStatusSource(reader, false),
      write: buildRoutedWriteContext(reader, localWriteContext(reader))
    });
    const client = new Client({ name: 'hebra-mcp-jd-fwd-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    clients.push({ client, server });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        isError: result.isError === true,
        value: JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
      };
    };

    // La carpeta privada del LECTOR con el prefijo 22 la juzga el escritor.
    const hidden = await call('hebra_jd_new_id', { mode: 'simulate', category: '22', title: 'Nada' });
    expect(hidden).toEqual(HAS_HIDDEN);
    expect(JSON.stringify(hidden)).not.toContain('22.40');

    const plan = await call('hebra_jd_new_id', { mode: 'simulate', category: '21', title: 'Reenviado' });
    expect(plan.value).toMatchObject({ mode: 'simulate', id: '21.12', noteName: '21.12 Reenviado' });
    const applied = await call('hebra_jd_new_id', { mode: 'apply', planId: plan.value.planId, operationId: 'op-fwd' });
    expect(applied.isError, JSON.stringify(applied.value)).toBe(false);
    expect((applied.value.created as unknown[]).length).toBe(2);
    const folders = (await writer.port.foldersList()).folders;
    expect(folders.some((folder) => folder.name === '21.12 Reenviado' && folder.parentId === category21)).toBe(true);
    // El reintento lo sirve el registro del escritor.
    expect(await call('hebra_jd_new_id', { mode: 'apply', planId: plan.value.planId, operationId: 'op-fwd' })).toEqual({
      isError: false,
      value: { ...applied.value, replayed: true }
    });
    // La auditoría, en el lector, no nombra la carpeta oculta.
    const audit = await call('hebra_jd_audit', {});
    expect(audit.isError, JSON.stringify(audit.value)).toBe(false);
    expect(JSON.stringify(audit)).not.toContain('22.40');
    expect(stderrText()).toContain('"event":"write.forward","op":"jdNewId","outcome":"forwarded"');
    expect(stderrText()).not.toContain('Reenviado');
  });
});
