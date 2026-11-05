/**
 * `hebra_rename_file` arregla las notas que incrustan el fichero (D23, 5 nov 2026; SPEC.md §5 y
 * §6.3), sobre la biblioteca de prueba: `Diario` y `Diario/2026` privadas, `secreto` etiqueta
 * privada. Lo que más importa, que NUNCA se reescribe ni se cuenta una nota oculta, va junto a
 * los casos normales: fichero enlazado por nota privada y por bloqueada, la nota que cruza a
 * privada antes y después de escribir, y que la respuesta no cambia por una nota oculta.
 */
import { extname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveToolContext } from '../../src/server/context';
import { runRenameFile } from '../../src/server/tools/loose-files';
import { planRelink, type RelinkTurn } from '../../src/store/file-relink';
import { FILE_NAMES, createNote } from '../fixtures/test-library';
import { startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';
import type { PrivacyConfig } from '../../src/privacy';

const NOT_FOUND = { isError: true, value: { error: 'not_found' } };
const NO_PRIVATE: PrivacyConfig = { privateFolders: [], privateTags: [] };

describe('hebra_rename_file arregla las notas (D23)', () => {
  let h: LooseFilesHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  async function start(
    config?: PrivacyConfig,
    options?: Parameters<typeof startLooseFiles>[1]
  ): Promise<LooseFilesHarness> {
    h = await startLooseFiles(config, options);
    return h;
  }

  /** Una nota nueva, creada como la crearía la app. */
  const note = (harness: LooseFilesHarness, body: string, folderId: string | null = null): Promise<string> =>
    harness.withEngine(async (engine) => (await createNote(engine, folderId, body)).id);

  /** Cuerpo y `local_seq` de una nota, por otra conexión. */
  const stored = (harness: LooseFilesHarness, id: string) =>
    harness.withEngine(async (engine) => {
      const row = (await engine.noteRead(id))!;
      return { body: row.body, localSeq: row.localSeq };
    });

  it('una nota enlazada visible queda con el enlace nuevo, y `relinked` dice cuántas', async () => {
    const harness = await start();
    const { call, test } = harness;
    const id = test.library.files.inventario;
    const one = await note(harness, `# Una\n\n![[${FILE_NAMES.inventario}]]\n`);
    const two = await note(harness, `# Dos\n\n![[${FILE_NAMES.inventario}|Mi vista]] y ![[${FILE_NAMES.inventario}]]\n`);
    const other = await note(harness, '# Otra\n\nSin incrustar nada.\n');
    const otherBefore = await stored(harness, other);

    const renamed = await call('hebra_rename_file', { id, name: 'Tareas.base', operationId: 'op-rel' });
    expect(renamed.value).toMatchObject({ id, name: 'Tareas.base', outcome: 'saved', relinked: 2 });

    expect((await stored(harness, one)).body).toBe('# Una\n\n![[Tareas.base]]\n');
    // Solo el nombre: el alias se queda.
    expect((await stored(harness, two)).body).toBe('# Dos\n\n![[Tareas.base|Mi vista]] y ![[Tareas.base]]\n');
    expect(await stored(harness, other)).toEqual(otherBefore);

    // Los enlaces derivados siguen al cuerpo: la nota enlaza ya el nombre nuevo.
    const links = (await call('hebra_links', { id: one })).value.outgoing as Array<{ ref: string; resolvedId?: string }>;
    expect(links.map((link) => link.ref)).toEqual(['Tareas.base']);
  });

  it('cada nota arreglada guarda su versión anterior, y no se manda ningún cuerpo', async () => {
    const harness = await start();
    const { call, test } = harness;
    const body = `# Con versión\n\n![[${FILE_NAMES.inventario}]]\n`;
    const id = await note(harness, body);
    await call('hebra_rename_file', { id: test.library.files.inventario, name: 'Tareas.base', operationId: 'op-ver' });
    const versions = (await call('hebra_list_versions', { id })).value.versions as Array<{ versionId: number }>;
    expect(versions.length).toBeGreaterThan(0);
    const previous = await call('hebra_read_version', { id, versionId: versions[0]!.versionId });
    expect(previous.value.body).toBe(body);
  });

  it('sin notas que arreglar, relinked: 0; el nombre igual, already sin escribir', async () => {
    const harness = await start();
    const { call, rawFiles, test } = harness;
    const id = test.library.files.inventario;
    const before = rawFiles();
    const same = await call('hebra_rename_file', { id, name: FILE_NAMES.inventario, operationId: 'op-same' });
    expect(same.value).toMatchObject({ outcome: 'already', relinked: 0 });
    expect(rawFiles()).toEqual(before);
    expect((await call('hebra_rename_file', { id, name: 'Tareas.base', operationId: 'op-none' })).value).toMatchObject({
      outcome: 'saved',
      relinked: 0
    });
  });

  it('reintento con el mismo operationId: lo anotado, sin volver a escribir ni la nota ni el fichero', async () => {
    const harness = await start();
    const { call, rawFiles, test } = harness;
    const id = test.library.files.inventario;
    const noteId = await note(harness, `# Reintento\n\n![[${FILE_NAMES.inventario}]]\n`);
    const args = { id, name: 'Tareas.base', operationId: 'op-idem' };
    expect((await call('hebra_rename_file', args)).value).toMatchObject({ outcome: 'saved', relinked: 1 });
    const noteBefore = await stored(harness, noteId);
    const filesBefore = rawFiles();
    const again = await call('hebra_rename_file', args);
    expect(again.value).toMatchObject({ outcome: 'saved', relinked: 1, replayed: true });
    expect(await stored(harness, noteId)).toEqual(noteBefore);
    expect(rawFiles()).toEqual(filesBefore);
    expect((await call('hebra_rename_file', { ...args, name: 'Otra.base' })).value).toEqual({
      error: 'operation_id_reused'
    });
  });

  it('recuperado del estado started (murió tras escribir): lo da por guardado, sin relinked porque no consta', async () => {
    const harness = await start();
    const { call, exec, test } = harness;
    const id = test.library.files.inventario;
    await note(harness, `# Corte\n\n![[${FILE_NAMES.inventario}]]\n`);
    const args = { id, name: 'Tareas.base', operationId: 'op-corte' };
    await call('hebra_rename_file', args);
    exec(`UPDATE hebra_mcp_operations SET state = 'started', result = NULL WHERE operation_id = ?`, 'op-corte');
    const again = await call('hebra_rename_file', args);
    expect(again.value).toMatchObject({ outcome: 'saved', replayed: true });
    expect(again.value).not.toHaveProperty('relinked');
  });

  it('un enlace a mano o a los bytes, y lo que hay dentro de un bloque de código, se quedan como están', async () => {
    const harness = await start();
    const { call, test } = harness;
    const body = [
      '# Sin tocar',
      '',
      `[[${FILE_NAMES.inventario}]] y ![[carpeta/${FILE_NAMES.inventario}]]`,
      '',
      '```',
      `![[${FILE_NAMES.inventario}]]`,
      '```',
      ''
    ].join('\n');
    const id = await note(harness, body);
    const renamed = await call('hebra_rename_file', {
      id: test.library.files.inventario,
      name: 'Tareas.base',
      operationId: 'op-mano'
    });
    expect(renamed.value).toMatchObject({ outcome: 'saved', relinked: 0 });
    expect((await stored(harness, id)).body).toBe(body);
  });

  it('una nota de la papelera se queda con el nombre anterior y no se cuenta', async () => {
    const harness = await start();
    const { call, withEngine, test } = harness;
    const body = `# Tirada\n\n![[${FILE_NAMES.inventario}]]\n`;
    const id = await note(harness, body);
    await withEngine((engine) => engine.noteTrash(id));
    const renamed = await call('hebra_rename_file', {
      id: test.library.files.inventario,
      name: 'Tareas.base',
      operationId: 'op-papelera'
    });
    expect(renamed.value).toMatchObject({ outcome: 'saved', relinked: 0 });
    expect((await stored(harness, id)).body).toBe(body);
  });

  describe('privacidad', () => {
    it('fichero enlazado por una nota privada: not_found igual que uno inexistente, y nada escrito', async () => {
      const harness = await start();
      const { call, rawFiles, test } = harness;
      const id = test.library.files.inventario;
      const hidden = await note(harness, `# Plan\n#secreto\n\n![[${FILE_NAMES.inventario}]]\n`);
      const visible = await note(harness, `# Pública\n\n![[${FILE_NAMES.inventario}]]\n`);
      const hiddenFolder = await note(harness, `# En diario\n\n![[${FILE_NAMES.plano}]]\n`, test.library.folders.diario);
      const notes = await Promise.all([hidden, visible, hiddenFolder].map((noteId) => stored(harness, noteId)));
      const files = rawFiles();

      const missing = await call('hebra_rename_file', { id: 'no-existe', name: 'x.base', operationId: 'op-no' });
      expect(missing).toEqual(NOT_FOUND);
      expect(await call('hebra_rename_file', { id, name: 'x.base', operationId: 'op-tag' })).toEqual(missing);
      expect(
        await call('hebra_rename_file', { id: test.library.files.plano, name: 'x.pdf', operationId: 'op-carpeta' })
      ).toEqual(missing);
      // Los ficheros ocultos del fixture, por nombre y por los bytes, igual.
      for (const hiddenFile of [test.library.files.referencedByName, test.library.files.referencedByHash]) {
        const name = `x${extname(rawFiles().find((row) => row.id === hiddenFile)!.name)}`;
        expect(await call('hebra_rename_file', { id: hiddenFile, name, operationId: `op-${hiddenFile}` })).toEqual(missing);
      }

      expect(rawFiles()).toEqual(files);
      expect(await Promise.all([hidden, visible, hiddenFolder].map((noteId) => stored(harness, noteId)))).toEqual(notes);
    });

    it('con una nota bloqueada oculta, un fichero que se puede incrustar por nombre: not_found, sin escribir', async () => {
      const harness = await start(undefined, { lockedNote: true });
      const { call, rawFiles, test } = harness;
      const before = rawFiles();
      const locked = await stored(harness, test.library.lockedPrivateNoteId);
      expect(
        await call('hebra_rename_file', { id: test.library.files.inventario, name: 'x.base', operationId: 'op-b1' })
      ).toEqual(NOT_FOUND);
      // Sus adjuntos, también: solo constan en `note_blob_refs`.
      expect(
        await call('hebra_rename_file', { id: test.library.files.referencedByLockedNote, name: 'x', operationId: 'op-b2' })
      ).toEqual(NOT_FOUND);
      expect(rawFiles()).toEqual(before);
      expect(await stored(harness, test.library.lockedPrivateNoteId)).toEqual(locked);
    });

    it('una bloqueada VISIBLE (sin etiquetas privadas) se queda sin tocar y no se cuenta, tenga o no filas de enlace', async () => {
      const harness = await start(NO_PRIVATE, { lockedNote: true });
      const { call, exec, test } = harness;
      const lockedId = test.library.lockedPrivateNoteId;
      const locked = await stored(harness, lockedId);
      // El motor la exige en sus revisiones si le queda una fila de `links`.
      exec(
        `INSERT INTO links (src_note_id, target_kind, target) VALUES (?, 'file', ?)`,
        lockedId,
        FILE_NAMES.inventario
      );
      const plain = await note(harness, `# Normal\n\n![[${FILE_NAMES.inventario}]]\n`);
      const renamed = await call('hebra_rename_file', {
        id: test.library.files.inventario,
        name: 'Tareas.base',
        operationId: 'op-visible'
      });
      expect(renamed.value).toMatchObject({ outcome: 'saved', relinked: 1 });
      expect((await stored(harness, plain)).body).toBe('# Normal\n\n![[Tareas.base]]\n');
      expect(await stored(harness, lockedId)).toEqual(locked);
    });

    it('la nota cruza a privada entre la comprobación de la herramienta y la escritura: el escritor rechaza sin escribir', async () => {
      const harness = await start();
      const { rawFiles, test, withEngine } = harness;
      const id = test.library.files.inventario;
      const noteId = await note(harness, `# Cruza\n\n![[${FILE_NAMES.inventario}]]\n`);
      // Un filtro de ANTES de que cruce: la herramienta ve el fichero y llega al escritor.
      const ctx = await resolveToolContext(test.serverContext);
      await withEngine((engine) => engine.noteMove(noteId, test.library.folders.diario));
      const reached = vi.spyOn(ctx.write!, 'looseFileWrite');
      const before = rawFiles();
      const noteBefore = await stored(harness, noteId);
      await expect(runRenameFile(ctx, { id, name: 'Tareas.base', operationId: 'op-cruza' })).rejects.toMatchObject({
        code: 'not_found'
      });
      expect(reached).toHaveBeenCalledTimes(1);
      reached.mockRestore();
      expect(rawFiles()).toEqual(before);
      expect(await stored(harness, noteId)).toEqual(noteBefore);
    });

    it('la nota cruza a privada DESPUÉS de escribir: la puerta final responde not_found, sin relinked', async () => {
      const harness = await start();
      const { call, test, withEngine } = harness;
      const noteId = await note(harness, `# Cruza tras\n\n![[${FILE_NAMES.inventario}]]\n`);
      const write = test.serverContext.write!;
      const original = write.looseFileWrite!.bind(write);
      const spy = vi.spyOn(write, 'looseFileWrite').mockImplementationOnce(async (input) => {
        const result = await original(input);
        await withEngine((engine) => engine.noteMove(noteId, test.library.folders.diario));
        return result;
      });
      const result = await call('hebra_rename_file', {
        id: test.library.files.inventario,
        name: 'Tareas.base',
        operationId: 'op-tras'
      });
      spy.mockRestore();
      expect(result).toEqual(NOT_FOUND);
    });

    it('el escritor, también sin la herramienta: rechaza un fichero oculto antes de tocar ninguna nota', async () => {
      const harness = await start();
      const { rawFiles, test } = harness;
      const before = rawFiles();
      await expect(
        test.serverContext.write!.looseFileWrite!({
          action: 'renameFile',
          id: test.library.files.referencedByName,
          name: 'x.png',
          operationId: 'op-escritor',
          privacy: test.serverContext.privacyConfig
        })
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(rawFiles()).toEqual(before);
    });

    it('planRelink, cerrado ante la duda: una nota oculta en el conjunto del motor rechaza sin leer ninguna', async () => {
      const noteRead = vi.fn();
      const turn = {
        store: { notesRelinkingFile: () => ['visible', 'oculta'], noteRead },
        live: { isHiddenNote: (id: string) => id === 'oculta' },
        files: { visibleFiles: () => [] },
        index: { files: [] }
      } as unknown as RelinkTurn;
      await expect(
        planRelink(turn, { id: 'f', name: 'a.base', sha256: 'a'.repeat(64), folderId: 'root' }, 'b.base')
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(noteRead).not.toHaveBeenCalled();
    });

    it('un homónimo exacto OCULTO en la misma carpeta: sin notas no cuenta (D17); con notas, not_found y nada escrito', async () => {
      const harness = await start();
      const { call, engineFile, rawFiles, test } = harness;
      const twin = rawFiles().find((row) => row.id === test.library.files.referencedByHash)!;
      const ext = extname(twin.name);
      const quiet = await engineFile(null, `Tranquilo${ext}`, 'uno');
      const linked = await engineFile(null, `Enlazado${ext}`, 'dos');
      const noteId = await note(harness, `# Con homónimo\n\n![[Enlazado${ext}]]\n`);
      const noteBefore = await stored(harness, noteId);

      const refused = await call('hebra_rename_file', { id: linked, name: twin.name, operationId: 'op-twin-1' });
      expect(refused).toEqual(NOT_FOUND);
      expect(await stored(harness, noteId)).toEqual(noteBefore);
      expect(rawFiles().find((row) => row.id === linked)!.name).toBe(`Enlazado${ext}`);

      const allowed = await call('hebra_rename_file', { id: quiet, name: twin.name, operationId: 'op-twin-2' });
      expect(allowed.value).toMatchObject({ outcome: 'saved', relinked: 0 });
      expect(JSON.stringify(allowed)).not.toContain(test.library.files.referencedByHash);
    });
  });

  describe('homónimos en otras carpetas', () => {
    it('el nombre anterior resuelve a OTRO fichero visible: esas notas no lo incrustan y no se tocan', async () => {
      const harness = await start();
      const { call, engineFile, test } = harness;
      const a = await engineFile(null, 'Dup.base', 'uno');
      const b = await engineFile(test.library.folders.proyectos, 'Dup.base', 'dos');
      const [lower, higher] = [a, b].sort();
      const body = '# Dup\n\n![[Dup.base]]\n';
      const noteId = await note(harness, body);
      // El enlace resuelve al de menor id: el otro no se lleva la nota.
      const notMine = await call('hebra_rename_file', { id: higher!, name: 'Otro.base', operationId: 'op-dup-1' });
      expect(notMine.value).toMatchObject({ outcome: 'saved', relinked: 0 });
      expect((await stored(harness, noteId)).body).toBe(body);
      const mine = await call('hebra_rename_file', { id: lower!, name: 'Mio.base', operationId: 'op-dup-2' });
      expect(mine.value).toMatchObject({ outcome: 'saved', relinked: 1 });
      expect((await stored(harness, noteId)).body).toBe('# Dup\n\n![[Mio.base]]\n');
    });

    it('el nombre nuevo lo tiene otro visible de otra carpeta: con notas que arreglar, file_exists y nada escrito', async () => {
      const harness = await start();
      const { call, engineFile, rawFiles, test } = harness;
      const taken = await engineFile(test.library.folders.proyectos, 'Ocupado.base', 'uno');
      const noteId = await note(harness, `# Choca\n\n![[${FILE_NAMES.inventario}]]\n`);
      const noteBefore = await stored(harness, noteId);
      const before = rawFiles();
      const refused = await call('hebra_rename_file', {
        id: test.library.files.inventario,
        name: 'Ocupado.base',
        operationId: 'op-choca'
      });
      expect(refused).toEqual({ isError: true, value: { error: 'file_exists', id: taken } });
      expect(rawFiles()).toEqual(before);
      expect(await stored(harness, noteId)).toEqual(noteBefore);
      // Sin notas que arreglar, como D17: otra carpeta no choca.
      await engineFile(test.library.folders.proyectos, 'Libre.pdf', 'dos');
      expect(
        (await call('hebra_rename_file', { id: test.library.files.acta, name: 'Libre.pdf', operationId: 'op-libre' })).value
      ).toMatchObject({ outcome: 'saved', relinked: 0 });
    });
  });
});
