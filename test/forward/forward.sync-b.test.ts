/**
 * Reenvío de escrituras del lector al escritor (SPEC.md §8) EN PROCESO, segunda parte
 * (organización y resto de herramientas). El soporte común vive en `forward-harness.ts`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "../../src/server/context";
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
} from "../../src/server/forward";
import { localWriteContext } from "../../src/server/serve";
import { appCreate, appDevice } from "../sync/devices";
import {
  BAIT_TEXT,
  OPEN,
  call,
  connect,
  pair,
  stderrText,
  useForwardHarness,
} from "./forward-harness";

useForwardHarness();

describe('escritor y lector en proceso, con sync sobre el relé en memoria', () => {
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

  it('leer y reemplazar un fichero suelto desde un lector (D15): baja y escribe el escritor, con la privacidad del lector', async () => {
    const { relay, writer, reader, client } = await pair({ blobs: true });
    // Un `.base` creado en la app (como lo deja su editor de Bases): llega al escritor con
    // la ronda, pero sus bytes siguen en el relé.
    const yaml = `views:\n  - type: table\n    name: ${BAIT_TEXT}\n`;
    const app = await appDevice(relay, 'Mac', { blobs: true });
    const blob = await app.engine.blobPut(new TextEncoder().encode(yaml), { mime: 'text/yaml' });
    const file = await app.engine.fileCreate(null, 'Tareas.base', blob.sha256);
    expect((await app.sync.runRound()).result).toBe('ok');
    await writer.syncRunner!.requestRound();
    expect(await writer.port.blobRead(blob.sha256)).toBeNull();

    // Leer: el lector pide al escritor que lo baje (`fetchFile`) y lo lee del disco.
    const read = (await client.callTool({
      name: 'hebra_read_file',
      arguments: { id: file.id }
    })) as CallToolResult;
    expect(read.isError).not.toBe(true);
    expect(read.content[1]).toEqual({ type: 'text', text: yaml });
    const meta = JSON.parse((read.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(meta).toMatchObject({ id: file.id, mimeType: 'text/yaml', sha256: blob.sha256 });

    // Reemplazar: lo hace el escritor, con la ronda esperada allí; la app recibe el
    // contenido nuevo con la misma identidad.
    const next = 'views:\n  - type: cards\n';
    const nextSha = createHash('sha256').update(next).digest('hex');
    const args = { id: file.id, expectedSha256: blob.sha256, text: next, operationId: 'op-fwd-file' };
    const replaced = await call(client, 'hebra_replace_file_text', args);
    expect(replaced).toEqual({
      isError: false,
      value: {
        id: file.id,
        outcome: 'saved',
        sha256: nextSha,
        byteLength: next.length,
        mimeType: 'text/yaml',
        previousSha256: blob.sha256,
        sync: 'uploaded'
      }
    });
    // El reintento lo sirve el registro del escritor, sin volver a escribir.
    expect((await call(client, 'hebra_replace_file_text', args)).value).toMatchObject({
      outcome: 'saved',
      replayed: true
    });
    expect((await app.sync.runRound()).result).toBe('ok');
    const onApp = app.engine.fileRead(file.id, null);
    expect(onApp).toMatchObject({ id: file.id, name: 'Tareas.base', sha256: nextSha });
    expect(new TextDecoder().decode((await app.sync.readBlob(nextSha))!)).toBe(next);

    // La privacidad del LECTOR viaja y la aplica el escritor dentro del turno.
    const routedWrite = buildRoutedWriteContext(reader, localWriteContext(reader));
    const unresolved = await routedWrite.replaceFileText!({
      id: file.id,
      expectedSha256: nextSha,
      text: 'otra',
      operationId: 'op-fwd-unresolved',
      privacy: { privateFolders: [['no-existe']], privateTags: [] }
    }).catch((error: unknown) => error);
    expect(unresolved).toMatchObject({ code: 'privacy_config_unresolved' });
    const missing = await routedWrite.replaceFileText!({
      id: 'no-existe',
      expectedSha256: nextSha,
      text: 'otra',
      operationId: 'op-fwd-missing',
      privacy: OPEN
    }).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: 'not_found' });

    expect(stderrText()).toContain('"event":"write.forward","op":"fetchFile","outcome":"forwarded"');
    expect(stderrText()).toContain('"event":"write.forward","op":"replaceFileText","outcome":"forwarded"');
    expect(stderrText()).not.toContain(BAIT_TEXT);
    expect(stderrText()).not.toContain('Tareas.base');
    expect(stderrText()).not.toContain(nextSha);
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
    await writer.syncRunner!.requestRound();
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
