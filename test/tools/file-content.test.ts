import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import {
  ATTACHMENT_PDF,
  ATTACHMENT_PNG,
  BAIT_FOLDER,
  createNote,
  FILE_NAMES
} from '../fixtures/test-library';
import { SqliteLibraryEngine } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import type { ServerContext } from '../../src/server/context';
import { registerTools } from '../../src/server/register-tools';
import type { WriteContext } from '../../src/server/write-context';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { isBusyOtherInstance, StoreError } from '../../src/store/errors';
import { replaceFileText } from '../../src/store/file-writes';
import type { NoteWriteStore, NoteWriteTarget } from '../../src/store/writes';
import { ensureFilePreviousTable, sqliteFilePreviousStore } from '../../src/store/file-previous';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

/**
 * Leer un fichero suelto y reemplazar el texto de uno (D15, decidido por David el 10 oct
 * 2026, tarea F2 de Lumbre), sobre la biblioteca de prueba: `Diario` (y `Diario/2026`)
 * privada y `secreto` etiqueta privada. `Inventario.base` (YAML de Obsidian Bases, en la
 * raíz) es el fichero visible de texto; los ocultos por carpeta y por referencia son los
 * de D10 (`test/tools/files.test.ts`). Todo por el cliente MCP, para comparar respuestas
 * enteras. Sin sync: `sync: "not_linked"`.
 */

const BASE_YAML = 'views:\n  - type: table\n';
const NEW_YAML = 'filters:\n  and:\n    - file.hasTag("proyecto")\nviews:\n  - type: table\n    name: Todo\n';

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

interface RawFile {
  sha256: string;
  name: string;
  folderId: string;
  localSeq: number;
  dirty: number;
}

describe('ficheros sueltos: leer y reemplazar el texto (D15)', () => {
  let test: TestContext | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await test?.close();
    test = undefined;
    client = undefined;
    server = undefined;
  });

  async function start(
    privacyConfig?: PrivacyConfig,
    write?: (base: WriteContext) => WriteContext
  ): Promise<TestContext> {
    test = await buildTestContext(privacyConfig);
    const ctx: ServerContext = write
      ? { ...test.serverContext, write: write(test.serverContext.write!) }
      : test.serverContext;
    server = new McpServer({ name: 'hebra-mcp-file-test', version: '0.0.0' });
    registerTools(server, ctx);
    client = new Client({ name: 'hebra-mcp-file-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return test;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client!.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** El primer bloque de texto, como JSON. */
  function json(result: CallToolResult): Record<string, unknown> {
    const block = result.content[0] as { type: string; text: string };
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  async function readText(id: string): Promise<{ meta: Record<string, unknown>; text: string }> {
    const result = await call('hebra_read_file', { id });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return { meta: json(result), text: (result.content[1] as { text: string }).text };
  }

  async function replace(args: Record<string, unknown>): Promise<CallToolResult> {
    return call('hebra_replace_file_text', args);
  }

  /** La fila de `files` tal como está en disco, por otra conexión de solo lectura. */
  function raw(id: string): RawFile {
    const db = new DatabaseSync(test!.sqlitePath, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT sha256, name, folder_id, local_seq, dirty FROM files WHERE id = ?')
        .get(id) as Record<string, unknown>;
      return {
        sha256: String(row.sha256),
        name: String(row.name),
        folderId: String(row.folder_id),
        localSeq: Number(row.local_seq),
        dirty: Number(row.dirty)
      };
    } finally {
      db.close();
    }
  }

  /** Cuántos contenidos anteriores guardó el escritor (`hebra_mcp_file_previous`). */
  function previousCount(): number {
    const db = new DatabaseSync(test!.sqlitePath, { readOnly: true });
    try {
      const row = db.prepare('SELECT count(*) AS n FROM hebra_mcp_file_previous').get() as {
        n: number;
      };
      return Number(row.n);
    } finally {
      db.close();
    }
  }

  /** Otro dispositivo (o Hebra) tocando la MISMA biblioteca: el motor por otra conexión. */
  async function withEngine<T>(run: (engine: SqliteLibraryEngine) => Promise<T>): Promise<T> {
    const { db, conn } = openNodeSqliteConn(test!.sqlitePath);
    try {
      const engine = await SqliteLibraryEngine.open(conn, 'otro-dispositivo', {
        journalMode: 'WAL',
        blobs: new FsBlobStore(test!.dataDir)
      });
      return await run(engine);
    } finally {
      db.close();
    }
  }

  async function createFile(
    folderId: string | null,
    name: string,
    bytes: Uint8Array | string,
    mime: string | null
  ): Promise<string> {
    return withEngine(async (engine) => {
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      const blob = await engine.blobPut(data, { mime });
      return (await engine.fileCreate(folderId, name, blob.sha256)).id;
    });
  }

  it('un .base de ida y vuelta: leer, reemplazar con el sha256 leído y releer lo nuevo', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const before = raw(id);

    const read = await readText(id);
    expect(read.text).toBe(BASE_YAML);
    expect(read.meta).toEqual({
      id,
      name: FILE_NAMES.inventario,
      folderPath: '',
      mimeType: 'text/yaml',
      byteLength: Buffer.byteLength(BASE_YAML),
      sha256: sha256(BASE_YAML),
      updatedAt: expect.any(String),
      totalChars: BASE_YAML.length,
      truncated: false,
      nextOffset: null
    });

    const replaced = await replace({
      id,
      expectedSha256: read.meta.sha256,
      text: NEW_YAML,
      operationId: 'op-base-1'
    });
    expect(replaced.isError).not.toBe(true);
    expect(json(replaced)).toEqual({
      id,
      outcome: 'saved',
      sha256: sha256(NEW_YAML),
      byteLength: Buffer.byteLength(NEW_YAML),
      mimeType: 'text/yaml',
      previousSha256: sha256(BASE_YAML),
      sync: 'not_linked'
    });

    const reread = await readText(id);
    expect(reread.text).toBe(NEW_YAML);
    expect(reread.meta.sha256).toBe(sha256(NEW_YAML));
    expect(reread.meta.mimeType).toBe('text/yaml');

    // Misma identidad (id, nombre y carpeta), contenido nuevo, sucia y con un `local_seq`
    // más para que el sync suba el cambio. El contenido anterior queda guardado.
    const after = raw(id);
    expect(after).toEqual({
      sha256: sha256(NEW_YAML),
      name: before.name,
      folderId: before.folderId,
      localSeq: before.localSeq + 1,
      dirty: 1
    });
    expect(previousCount()).toBe(1);
    const listed = json(await call('hebra_list_files', {})).files as Array<{ id: string; name: string }>;
    expect(listed.find((file) => file.id === id)?.name).toBe(FILE_NAMES.inventario);
    expect(JSON.stringify(listed)).not.toContain(sha256(NEW_YAML));
  });

  it('con undoOperationId vuelve al contenido de antes del reemplazo, como un reemplazo más', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    await replace({ id, expectedSha256: sha256(BASE_YAML), text: NEW_YAML, operationId: 'op-1' });

    const undone = await replace({
      id,
      expectedSha256: sha256(NEW_YAML),
      undoOperationId: 'op-1',
      operationId: 'op-2'
    });
    expect(json(undone)).toMatchObject({
      outcome: 'saved',
      sha256: sha256(BASE_YAML),
      previousSha256: sha256(NEW_YAML)
    });
    expect((await readText(id)).text).toBe(BASE_YAML);
    expect(raw(id).sha256).toBe(sha256(BASE_YAML));

    // Un `operationId` que no es un reemplazo de ESTE fichero (o no existe), `invalid_input`.
    for (const undoOperationId of ['no-existe', 'op-2-otro']) {
      const result = await replace({
        id,
        expectedSha256: sha256(BASE_YAML),
        undoOperationId,
        operationId: `op-undo-${undoOperationId}`
      });
      expect(json(result)).toEqual({ error: 'invalid_input' });
    }
    // Texto y vuelta atrás a la vez, o ninguno: `invalid_input`.
    expect(
      json(
        await replace({ id, expectedSha256: sha256(BASE_YAML), operationId: 'op-3' })
      )
    ).toEqual({ error: 'invalid_input' });
    expect(
      json(
        await replace({
          id,
          expectedSha256: sha256(BASE_YAML),
          text: 'x',
          undoOperationId: 'op-1',
          operationId: 'op-4'
        })
      )
    ).toEqual({ error: 'invalid_input' });
  });

  it('si el fichero cambió por debajo desde la lectura, file_changed y no se escribe', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const read = await readText(id);

    // Otro dispositivo lo reescribe (la misma vía que el editor de Bases de Hebra).
    const theirs = 'views:\n  - type: cards\n';
    await withEngine(async (engine) => {
      const blob = await engine.blobPut(new TextEncoder().encode(theirs), { mime: 'text/yaml' });
      await engine.fileReplace(id, blob.sha256, sha256(BASE_YAML));
    });
    const seq = raw(id).localSeq;

    const rejected = await replace({
      id,
      expectedSha256: read.meta.sha256,
      text: NEW_YAML,
      operationId: 'op-stale'
    });
    expect(rejected.isError).toBe(true);
    expect(json(rejected)).toEqual({ error: 'file_changed' });
    expect(raw(id).sha256).toBe(sha256(theirs));
    expect(raw(id).localSeq).toBe(seq);
    expect(previousCount()).toBe(0);
    expect((await readText(id)).text).toBe(theirs);

    // Releído, con la base nueva, sí.
    const fresh = await readText(id);
    const saved = await replace({
      id,
      expectedSha256: fresh.meta.sha256,
      text: NEW_YAML,
      operationId: 'op-fresh'
    });
    expect(json(saved)).toMatchObject({ outcome: 'saved', previousSha256: sha256(theirs) });
  });

  it('reintentar con el mismo operationId devuelve lo anotado (replayed) sin volver a escribir', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const args = { id, expectedSha256: sha256(BASE_YAML), text: NEW_YAML, operationId: 'op-retry' };
    const first = json(await replace(args));
    const seq = raw(id).localSeq;

    const second = json(await replace(args));
    expect(second).toEqual({ ...first, replayed: true });
    expect(raw(id).localSeq).toBe(seq);
    expect(previousCount()).toBe(1);

    // El mismo `operationId` con otra petición, `operation_id_reused`, sin escribir.
    expect(json(await replace({ ...args, text: 'otra cosa\n' }))).toEqual({
      error: 'operation_id_reused'
    });
    expect(raw(id).localSeq).toBe(seq);
    // Y el de otra escritura (un append con `operationId`), tampoco.
    const append = await call('hebra_append_to_note', {
      id: library.publicNoteId,
      text: 'línea',
      operationId: 'op-de-una-nota'
    });
    expect(append.isError).not.toBe(true);
    expect(
      json(await replace({ ...args, operationId: 'op-de-una-nota' }))
    ).toEqual({ error: 'operation_id_reused' });
  });

  it('«ya estaba»: el contenido nuevo es el actual, no escribe y lo dice', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const seq = raw(id).localSeq;
    const result = json(
      await replace({
        id,
        // La base da igual si el fichero ya tiene ese contenido.
        expectedSha256: 'b'.repeat(64),
        text: BASE_YAML,
        operationId: 'op-already'
      })
    );
    expect(result).toEqual({
      id,
      outcome: 'already',
      sha256: sha256(BASE_YAML),
      byteLength: Buffer.byteLength(BASE_YAML),
      mimeType: 'text/yaml',
      previousSha256: sha256(BASE_YAML),
      sync: 'not_linked'
    });
    expect(raw(id).localSeq).toBe(seq);
    expect(previousCount()).toBe(0);
  });

  it('privacidad: leer y reemplazar un oculto responde lo mismo que un id inexistente, sin escribir', async () => {
    // `Archivo` es privada; se borra (sus ficheros van a la papelera, con la carpeta
    // guardada como lápida) y se crea otra con el mismo nombre (la configuración sigue
    // resolviendo). Un fichero que Hebra sacó de la papelera queda VIVO en la lápida.
    const { library } = await start({ privateFolders: [['diario'], ['archivo']], privateTags: ['secreto'] });
    const ids = await withEngine(async (engine) => {
      const put = async (folderId: string, name: string): Promise<string> => {
        const blob = await engine.blobPut(new TextEncoder().encode(`${BAIT_FOLDER} ${name}\n`), {
          mime: 'text/plain'
        });
        return (await engine.fileCreate(folderId, name, blob.sha256)).id;
      };
      // En la carpeta privada misma (no en una subcarpeta).
      const inPrivate = await put(library.folders.diario, 'en-diario.txt');
      // En una subcarpeta privada ya borrada, sacado de la papelera desde Hebra.
      const viejo = await engine.folderCreate(library.folders.diario, 'Viejo-2');
      const inDeletedSub = await put(viejo.id, 'en-viejo.txt');
      await engine.folderTrash(viejo.id);
      await engine.fileRestore(inDeletedSub);
      // En la carpeta privada configurada, ya borrada y vuelta a crear.
      const archivo = await engine.folderCreate(null, 'Archivo');
      const inDeletedPrivate = await put(archivo.id, 'en-archivo.txt');
      await engine.folderTrash(archivo.id);
      await engine.folderCreate(null, 'Archivo');
      await engine.fileRestore(inDeletedPrivate);
      return { inPrivate, inDeletedSub, inDeletedPrivate };
    });

    const hidden: Record<string, string> = {
      'carpeta privada': ids.inPrivate,
      'subcarpeta privada': library.files.privateFolder,
      'subcarpeta privada ya borrada (vivo)': ids.inDeletedSub,
      'carpeta privada ya borrada (vivo)': ids.inDeletedPrivate,
      'carpeta privada ya borrada (papelera)': library.files.trashedDeletedPrivateFolder,
      'enlazado desde una nota oculta por nombre': library.files.referencedByName,
      'enlazado desde una nota oculta por sha': library.files.referencedByHash,
      'enlazado desde una nota oculta y bloqueada': library.files.referencedByLockedNote
    };
    const expectedSha256 = 'c'.repeat(64);
    const missingRead = await call('hebra_read_file', { id: 'no-existe' });
    const missingReplace = await replace({
      id: 'no-existe',
      expectedSha256,
      text: 'nuevo',
      operationId: 'op-missing'
    });
    expect(missingRead).toEqual({ content: [{ type: 'text', text: '{"error":"not_found"}' }], isError: true });
    expect(missingReplace).toEqual(missingRead);

    for (const [label, id] of Object.entries(hidden)) {
      const before = raw(id);
      expect(await call('hebra_read_file', { id }), label).toEqual(missingRead);
      // Con su sha256 de verdad, para que no pueda fallar por la base.
      expect(
        await replace({ id, expectedSha256: before.sha256, text: 'nuevo', operationId: `op-${id}` }),
        label
      ).toEqual(missingReplace);
      expect(raw(id), label).toEqual(before);
    }
    expect(previousCount()).toBe(0);

    // Y en el escritor, aunque la herramienta no lo mirara (una petición de un lector).
    for (const [label, id] of Object.entries(hidden)) {
      const error = await replaceFileText(
        test!.ctx.port as unknown as NoteWriteTarget,
        {
          id,
          expectedSha256: raw(id).sha256,
          text: 'nuevo',
          operationId: `op-writer-${id}`,
          privacy: { privateFolders: [['diario'], ['archivo']], privateTags: ['secreto'] }
        },
        null,
        () => {}
      ).catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(StoreError);
      expect((error as StoreError).code, label).toBe('not_found');
    }
  });

  it('un fichero de la papelera no se lee ni se reemplaza: not_found', async () => {
    const { library } = await start();
    const id = library.files.trashed;
    expect(json(await call('hebra_read_file', { id }))).toEqual({ error: 'not_found' });
    expect(
      json(await replace({ id, expectedSha256: raw(id).sha256, text: 'x', operationId: 'op-t' }))
    ).toEqual({ error: 'not_found' });
    // Ni una lápida, ni el id de una nota visible, ni un adjunto por su hash.
    for (const other of [library.files.tombstone, library.publicNoteId, library.attachments.png]) {
      expect(json(await call('hebra_read_file', { id: other }))).toEqual({ error: 'not_found' });
    }
  });

  it('una imagen sale como contenido image y un PDF como recurso embebido', async () => {
    const { library } = await start();
    const png = await createFile(library.folders.lumbre, 'captura.png', ATTACHMENT_PNG, null);
    const pdf = await createFile(null, 'plano-real.pdf', ATTACHMENT_PDF, 'application/pdf');

    const image = await call('hebra_read_file', { id: png });
    expect(json(image)).toMatchObject({
      id: png,
      name: 'captura.png',
      // Como en hebra_list_files: la ruta del índice de carpetas, en minúsculas.
      folderPath: 'proyectos/lumbre',
      mimeType: 'image/png',
      byteLength: ATTACHMENT_PNG.length,
      sha256: sha256(ATTACHMENT_PNG)
    });
    expect(image.content[1]).toEqual({
      type: 'image',
      data: Buffer.from(ATTACHMENT_PNG).toString('base64'),
      mimeType: 'image/png'
    });

    const document = await call('hebra_read_file', { id: pdf });
    expect(document.content[1]).toEqual({
      type: 'resource',
      resource: {
        uri: `hebra-file:${sha256(ATTACHMENT_PDF)}`,
        mimeType: 'application/pdf',
        blob: Buffer.from(ATTACHMENT_PDF).toString('base64')
      }
    });

    // Reemplazar el texto de una imagen o un PDF: `file_type_not_allowed`, sin escribir.
    for (const id of [png, pdf]) {
      const before = raw(id);
      expect(
        json(await replace({ id, expectedSha256: before.sha256, text: 'hola', operationId: `op-${id}` }))
      ).toEqual({ error: 'file_type_not_allowed' });
      expect(raw(id)).toEqual(before);
    }
  });

  it('tipo no permitido y topes de tamaño, al leer y al reemplazar', async () => {
    const { library } = await start();
    // `Acta.pdf` dice ser un PDF y sus bytes no lo son.
    expect(json(await call('hebra_read_file', { id: library.files.acta }))).toEqual({
      error: 'file_type_not_allowed',
      mimeType: 'application/pdf'
    });
    const zip = await createFile(null, 'datos.zip', 'PK\u0003\u0004 no es texto', 'application/zip');
    expect(json(await call('hebra_read_file', { id: zip }))).toEqual({
      error: 'file_type_not_allowed',
      mimeType: 'application/zip'
    });

    // Más de 5 MiB: se rechaza por el tamaño que ya sabe el almacén.
    const huge = await createFile(null, 'enorme.txt', 'a'.repeat(5 * 1024 * 1024 + 1), 'text/plain');
    expect(json(await call('hebra_read_file', { id: huge }))).toEqual({
      error: 'file_too_large',
      byteLength: 5 * 1024 * 1024 + 1,
      maxBytes: 5 * 1024 * 1024
    });

    // Un texto nuevo de más de 1 000 000 bytes, y un fichero actual de más (se lee por
    // tramos, pero no se reemplaza: su contenido anterior se guarda entero).
    const id = library.files.inventario;
    expect(
      json(
        await replace({
          id,
          expectedSha256: sha256(BASE_YAML),
          text: 'é'.repeat(500_001),
          operationId: 'op-big-text'
        })
      )
    ).toEqual({ error: 'file_too_large', byteLength: 1_000_002, maxBytes: 1_000_000 });
    const big = await createFile(null, 'largo.md', 'b'.repeat(1_000_001), 'text/markdown');
    const bigRead = await call('hebra_read_file', { id: big, maxChars: 10 });
    expect(json(bigRead)).toMatchObject({
      mimeType: 'text/markdown',
      totalChars: 1_000_001,
      truncated: true,
      nextOffset: 10
    });
    expect(
      json(
        await replace({
          id: big,
          expectedSha256: sha256('b'.repeat(1_000_001)),
          text: 'corto',
          operationId: 'op-big-file'
        })
      )
    ).toEqual({ error: 'file_too_large', byteLength: 1_000_001, maxBytes: 1_000_000 });

    // Un texto que no se puede guardar tal cual (NUL, una mitad suelta de un par
    // suplente) o un hash que no lo es: `invalid_input`.
    for (const args of [
      { text: 'a\u0000b', expectedSha256: sha256(BASE_YAML) },
      { text: 'a\ud800b', expectedSha256: sha256(BASE_YAML) },
      { text: 'ok', expectedSha256: 'no-es-un-hash' },
      { text: 'GIF89a empieza como una imagen', expectedSha256: sha256(BASE_YAML) }
    ]) {
      expect(json(await replace({ id, operationId: `op-${args.text}`, ...args }))).toEqual({
        error: 'invalid_input'
      });
    }
    expect(raw(id).sha256).toBe(sha256(BASE_YAML));
  });

  it('un fichero que pasa a oculto entre la lectura y la escritura no se escribe: not_found', async () => {
    let makeHidden: (() => Promise<void>) | null = null;
    // La herramienta ya lo ha visto visible; antes del turno del escritor, una nota de la
    // carpeta privada lo incrusta por nombre (regla b de D10).
    const { library } = await start(undefined, (base) => ({
      ...base,
      replaceFileText: async (input) => {
        if (makeHidden) await makeHidden();
        return base.replaceFileText!(input);
      }
    }));
    const id = library.files.inventario;
    const read = await readText(id);
    makeHidden = async () => {
      await withEngine(async (engine) => {
        await createNote(engine, library.folders.diario, `# Diario\n\n![[${FILE_NAMES.inventario}]]\n`);
      });
    };
    const before = raw(id);
    const result = await replace({
      id,
      expectedSha256: read.meta.sha256,
      text: NEW_YAML,
      operationId: 'op-race'
    });
    expect(json(result)).toEqual({ error: 'not_found' });
    expect(raw(id)).toEqual(before);
    expect(previousCount()).toBe(0);
    // Y desde entonces tampoco se lee.
    makeHidden = null;
    expect(json(await call('hebra_read_file', { id }))).toEqual({ error: 'not_found' });
  });

  it('el contenido nuevo no puede dejar el fichero oculto (bytes de un adjunto de una nota oculta)', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const before = raw(id);
    // Exactamente los bytes del adjunto de la nota privada: con ellos, el fichero pasaría a
    // estar enlazado por hash desde una nota oculta.
    const result = await replace({
      id,
      expectedSha256: sha256(BASE_YAML),
      text: `${BAIT_FOLDER} en un adjunto privado\n`,
      operationId: 'op-to-hidden'
    });
    expect(sha256(`${BAIT_FOLDER} en un adjunto privado\n`)).toBe(library.privateAttachmentSha);
    expect(json(result)).toEqual({ error: 'not_found' });
    expect(raw(id)).toEqual(before);
    expect((await readText(id)).text).toBe(BASE_YAML);
  });

  it('un lector sin escritor responde busy_other_instance al reemplazar', async () => {
    await start();
    const { openNodeLibraryPort } = await import('../../src/store/node-port');
    const reader = await openNodeLibraryPort({
      sqlitePath: test!.sqlitePath,
      dataDir: test!.dataDir,
      mode: 'readOnly'
    });
    try {
      const error = await replaceFileText(
        reader,
        {
          id: test!.library.files.inventario,
          expectedSha256: sha256(BASE_YAML),
          text: NEW_YAML,
          operationId: 'op-reader',
          privacy: { privateFolders: [], privateTags: [] }
        },
        null,
        () => {}
      ).catch((caught: unknown) => caught);
      expect(isBusyOtherInstance(error)).toBe(true);
    } finally {
      reader.close();
    }
  });

  // --- Revisión de D15 (10 oct 2026) ---------------------------------------------------

  /** Un turno de escritura del puerto de la prueba, con partes del almacén cambiadas. */
  function wrappedTarget(patch: (store: NoteWriteStore) => Partial<NoteWriteStore>): NoteWriteTarget {
    const port = test!.ctx.port as unknown as NoteWriteTarget;
    return {
      writeExclusive: (operation) =>
        port.writeExclusive((store) => operation({ ...store, ...patch(store) }))
    };
  }

  const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };

  it('M1: deshacer no pisa un cambio posterior al reemplazo (file_changed, sin escribir)', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    await replace({ id, expectedSha256: sha256(BASE_YAML), text: NEW_YAML, operationId: 'op-x' });
    // David añade una vista desde Hebra después del reemplazo X.
    const theirs = `${NEW_YAML}  - type: cards\n    name: Mía\n`;
    await withEngine(async (engine) => {
      const blob = await engine.blobPut(new TextEncoder().encode(theirs), { mime: 'text/yaml' });
      await engine.fileReplace(id, blob.sha256, sha256(NEW_YAML));
    });
    const before = raw(id);
    // El agente relee (base al día) y pide deshacer X: perdería la vista.
    const reread = await readText(id);
    const undo = await replace({
      id,
      expectedSha256: reread.meta.sha256,
      undoOperationId: 'op-x',
      operationId: 'op-undo-x'
    });
    expect(json(undo)).toEqual({ error: 'file_changed' });
    expect(raw(id)).toEqual(before);
    expect((await readText(id)).text).toBe(theirs);
  });

  it('M2: un texto con BOM vuelve con su BOM; devolver lo leído responde already', async () => {
    const { library } = await start();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = 'nombre;cantidad\npan;2\n';
    const bytes = new Uint8Array([...bom, ...new TextEncoder().encode(body)]);
    const id = await createFile(library.folders.lumbre, 'compra.csv', bytes, 'text/csv');
    const before = raw(id);

    const read = await readText(id);
    expect(read.text).toBe(body);
    expect(read.meta.sha256).toBe(sha256(bytes));
    const same = json(
      await replace({ id, expectedSha256: read.meta.sha256, text: read.text, operationId: 'op-bom-1' })
    );
    expect(same).toMatchObject({ outcome: 'already', sha256: sha256(bytes) });
    expect(raw(id)).toEqual(before);

    const next = 'nombre;cantidad\npan;3\n';
    const saved = json(
      await replace({ id, expectedSha256: read.meta.sha256, text: next, operationId: 'op-bom-2' })
    );
    const nextBytes = new Uint8Array([...bom, ...new TextEncoder().encode(next)]);
    expect(saved).toMatchObject({
      outcome: 'saved',
      sha256: sha256(nextBytes),
      byteLength: nextBytes.length
    });
    // Un texto que ya trae su U+FEFF no lleva otro.
    const explicit = json(
      await replace({
        id,
        expectedSha256: sha256(nextBytes),
        text: `﻿${next}`,
        operationId: 'op-bom-3'
      })
    );
    expect(explicit).toMatchObject({ outcome: 'already', sha256: sha256(nextBytes) });
  });

  it('B1: un fichero de más de 1 000 000 bytes da file_too_large sin bajarlo ni leerlo', async () => {
    const { library } = await start();
    const big = 'b'.repeat(1_000_001);
    const id = await createFile(library.folders.lumbre, 'largo.md', big, 'text/markdown');
    let blobReads = 0;
    let downloads = 0;
    const target = wrappedTarget((store) => ({
      blobRead: (sha: string) => {
        blobReads += 1;
        return store.blobRead(sha);
      }
    }));
    const error = await replaceFileText(
      target,
      { id, expectedSha256: sha256(big), text: 'corto', operationId: 'op-b1', privacy: OPEN },
      async () => {
        downloads += 1;
        return true;
      },
      () => {}
    ).catch((caught: unknown) => caught);
    expect((error as StoreError).code).toBe('file_too_large');
    expect({ blobReads, downloads }).toEqual({ blobReads: 0, downloads: 0 });
  });

  it('B5: morir entre fileReplace y finish; el reintento lo da por guardado sin volver a escribir', async () => {
    const { library } = await start();
    const id = library.files.inventario;
    const input = {
      id,
      expectedSha256: sha256(BASE_YAML),
      text: NEW_YAML,
      operationId: 'op-corte',
      privacy: OPEN
    };
    // El proceso muere justo después de reemplazar: `finish` no llega a anotarse.
    const dying = wrappedTarget((store) => ({
      operations: {
        ...store.operations,
        finish: () => {
          throw new Error('SIGKILL simulado');
        }
      }
    }));
    await expect(replaceFileText(dying, input, null, () => {})).rejects.toThrow('SIGKILL simulado');
    const afterCut = raw(id);
    expect(afterCut.sha256).toBe(sha256(NEW_YAML));

    const retry = await replaceFileText(test!.ctx.port as unknown as NoteWriteTarget, input, null, () => {});
    expect(retry).toEqual({
      wrote: false,
      result: {
        id,
        outcome: 'saved',
        sha256: sha256(NEW_YAML),
        byteLength: Buffer.byteLength(NEW_YAML),
        mimeType: 'text/yaml',
        previousSha256: sha256(BASE_YAML),
        replayed: true
      }
    });
    expect(raw(id)).toEqual(afterCut);
    // Y desde ahí se puede deshacer: el contenido anterior se guardó antes del corte.
    const undone = json(
      await replace({ id, expectedSha256: sha256(NEW_YAML), undoOperationId: 'op-corte', operationId: 'op-u' })
    );
    expect(undone).toMatchObject({ outcome: 'saved', sha256: sha256(BASE_YAML) });
  });
});

describe('hebra_mcp_file_previous: el tope (B5)', () => {
  function entry(operationId: string, text: string, createdAt: number) {
    return {
      operationId,
      fileId: 'f1',
      previousSha256: 'a'.repeat(64),
      previousText: text,
      nextSha256: 'b'.repeat(64),
      mime: 'text/plain',
      createdAt
    };
  }

  it('al pasar el tope de entradas o de bytes caen las más antiguas, nunca la recién guardada', () => {
    const db = new DatabaseSync(':memory:');
    try {
      ensureFilePreviousTable(db);
      const store = sqliteFilePreviousStore(db, { maxEntries: 3, maxBytes: 10 });
      const now = 1_000_000;
      store.save(entry('e1', 'aa', now + 1));
      store.save(entry('e2', 'bb', now + 2));
      store.save(entry('e3', 'cc', now + 3));
      store.save(entry('e4', 'dd', now + 4));
      const alive = (): string[] =>
        ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].filter((id) => store.lookup(id, now) !== null);
      expect(alive()).toEqual(['e2', 'e3', 'e4']);
      // 7 + 2 = 9 bytes caben; con la siguiente, 11 > 10: caen las más antiguas.
      store.save(entry('e5', 'xxxxxxx', now + 5));
      expect(alive()).toEqual(['e4', 'e5']);
      // Una sola que ya pasa el tope de bytes se queda: es la vuelta atrás del reemplazo
      // que se acaba de hacer.
      store.save(entry('e6', 'x'.repeat(50), now + 6));
      expect(alive()).toEqual(['e6']);
    } finally {
      db.close();
    }
  });

  it('M1: una tabla de antes de next_sha256 (564a6e3) se migra, y sus filas quedan sin él', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE hebra_mcp_file_previous (
        operation_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, previous_sha256 TEXT NOT NULL,
        previous_text TEXT NOT NULL, previous_bytes INTEGER NOT NULL, mime TEXT,
        created_at INTEGER NOT NULL) WITHOUT ROWID`);
      db.prepare(
        `INSERT INTO hebra_mcp_file_previous VALUES ('vieja', 'f1', ?, 'texto', 5, 'text/plain', 10)`
      ).run('a'.repeat(64));
      ensureFilePreviousTable(db);
      ensureFilePreviousTable(db);
      const store = sqliteFilePreviousStore(db);
      expect(store.lookup('vieja', 10)?.nextSha256).toBeNull();
      store.save(entry('nueva', 'otro', 20));
      expect(store.lookup('nueva', 20)?.nextSha256).toBe('b'.repeat(64));
    } finally {
      db.close();
    }
  });
});
