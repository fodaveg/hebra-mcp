/**
 * Reenvío de escrituras del lector al escritor (SPEC.md §8) EN PROCESO, primera parte:
 * dos `LibraryInstance` sobre el mismo directorio de datos, el escritor con sync sobre el
 * relé en memoria de Hebra y otra app de Hebra editando a la vez. El soporte común vive
 * en `forward-harness.ts`.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WRITER_SOCKET_FILE, requestWriter } from "../../src/ipc/writer-socket";
import type { ServerContext } from "../../src/server/context";
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
} from "../../src/server/forward";
import { localWriteContext } from "../../src/server/serve";
import { StoreError } from "../../src/store/errors";
import { mapWriteError } from "../../src/server/tools/write-errors";
import { LibraryInstance } from "../../src/sync/library-instance";
import {
  IDENTITY,
  InMemoryLibraryRelay,
  VAULT_KEY,
  allBodies,
  appCreate,
  appDevice,
  appSave,
} from "../sync/devices";
import {
  BAIT_TEXT,
  OPEN,
  call,
  connect,
  livePid,
  pair,
  servers,
  stderrText,
  tempDataDir,
  useForwardHarness,
} from "./forward-harness";

useForwardHarness();

describe('escritor y lector en proceso, con sync sobre el relé en memoria', () => {

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
    await writer.syncRunner!.requestRound();
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

  it('hebra_add_attachment con heading desde un lector: el apartado se resuelve en el escritor y los errores cruzan el socket', async () => {
    const { writer, client } = await pair();
    const body = '# Decisiones\n\n## Uno\ntexto uno\n\n## Dos\ntexto dos\n\n## Dos\notro\n';
    const created = await writer.createNote({ body, privacy: OPEN });
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const ref = `![[sha256:${createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex')}|c.png]]`;
    const args = { id: created.id, name: 'c.png', dataBase64: png, operationId: 'op-fwd-att-h' };

    const saved = await call(client, 'hebra_add_attachment', { ...args, heading: 'uno' });
    expect(saved.isError).toBe(false);
    expect((await writer.port.noteRead(created.id))!.body).toBe(
      body.replace('texto uno\n\n## Dos', `texto uno\n\n${ref}\n\n## Dos`)
    );
    expect(saved.value).toMatchObject({ outcome: 'saved', markdown: ref, placed: { line: 6, heading: 'Uno' } });

    // Reintento: lo sirve el registro del escritor; con otro apartado, operation_id_reused.
    const retry = await call(client, 'hebra_add_attachment', { ...args, heading: 'uno' });
    expect(retry.value).toMatchObject({ outcome: 'saved', replayed: true, markdown: ref });
    const reused = await call(client, 'hebra_add_attachment', { ...args, heading: 'Dos', headingOccurrence: 1 });
    expect(reused).toEqual({ isError: true, value: { error: 'operation_id_reused' } });

    const other = { ...args, operationId: 'op-fwd-att-h2' };
    expect(await call(client, 'hebra_add_attachment', { ...other, heading: 'Nada' })).toEqual({
      isError: true,
      value: { error: 'heading_not_found' }
    });
    const ambiguous = await call(client, 'hebra_add_attachment', { ...other, heading: 'Dos' });
    expect(ambiguous.value.error).toBe('ambiguous_heading');
    expect(ambiguous.value.candidates).toHaveLength(2);
    expect(await call(client, 'hebra_add_attachment', { ...other, headingOccurrence: 1 })).toEqual({
      isError: true,
      value: { error: 'invalid_input' }
    });
    const second = await call(client, 'hebra_add_attachment', { ...other, heading: 'Dos', headingOccurrence: 2 });
    expect(second.value).toMatchObject({ outcome: 'saved', placed: { heading: 'Dos' } });
    expect((await writer.port.noteRead(created.id))!.body.endsWith(`otro\n\n${ref}\n`)).toBe(true);
    expect(stderrText()).not.toContain('"heading":"');
  });

  it('50 títulos repetidos de 6 000 caracteres: ambiguous_heading llega con candidatos de 200 como mucho (D11)', async () => {
    const { writer, client } = await pair();
    // Seis mil caracteres que se normalizan a 'T T' (espacios colapsados): el cliente puede
    // pedirlo con un `heading` corto, pero el título guardado es largo.
    const long = `T${' '.repeat(5_998)}T`;
    const short = 'T T';
    const body = Array.from({ length: 50 }, () => `## ${long}\ntexto\n`).join('\n');
    const created = await writer.createNote({ body, privacy: OPEN });
    await writer.syncRunner!.requestRound();
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
  }, 30_000); // 50 notas de 6 000 caracteres y una ronda de sync: unos 5,6 s en el Mac (12 oct 2026).

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

  it('operation_id_reused trae por el socket lo que nombra su registro, solo para la puerta final', async () => {
    const dataDir = tempDataDir();
    const path = join(dataDir, 'fake-target.sock');
    const reply = (error: string) =>
      createServer((socket) => {
        socket.once('data', (chunk) => {
          const request = JSON.parse(String(chunk)) as { id: number };
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error, target: 'nota-del-registro' })}\n`);
        });
      });
    const reused = reply('operation_id_reused');
    servers.push(reused);
    await new Promise<void>((resolve) => reused.listen(path, resolve));
    const error = (await requestWriter(path, 'appendToNote', { id: 'n', text: 'x', privacy: OPEN }, 2_000).catch(
      (caught: unknown) => caught
    )) as StoreError;
    const mapped = mapWriteError(error);
    expect(mapped.code).toBe('operation_id_reused');
    expect(mapped.operationTarget).toBe('nota-del-registro');
    // Nunca en la salida: solo el código.
    expect(mapped.extra).toBeUndefined();
    // Con otro código, el campo se descarta.
    const otherPath = join(dataDir, 'fake-target-other.sock');
    const other = reply('no_match');
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(otherPath, resolve));
    const otherError = (await requestWriter(otherPath, 'appendToNote', { id: 'n', text: 'x', privacy: OPEN }, 2_000).catch(
      (caught: unknown) => caught
    )) as StoreError;
    expect(mapWriteError(otherError).operationTarget).toBeUndefined();
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
});
