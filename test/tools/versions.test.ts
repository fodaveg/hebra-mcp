import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { BAIT_TAG, VERSIONED_NEW_BODY, VERSIONED_OLD_BODY } from '../fixtures/test-library';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { runEditNote } from '../../src/server/tools/edit-note';
import { runTrashNote } from '../../src/server/tools/organize';
import { runReadNote } from '../../src/server/tools/read-note';
import {
  runListVersions,
  runReadVersion,
  runRestoreVersion
} from '../../src/server/tools/versions';

/**
 * «Versiones anteriores» (ampliación de D2, decisión de David del 30 sep 2026) sobre la
 * biblioteca de prueba, sin sync. `versionedNoteId` tiene una versión visible (la primera
 * redacción); `formerlyPrivateNoteId` es visible hoy, pero su única versión llevaba
 * `#secreto/personal` y `BAIT_TAG`. El conflicto con otro dispositivo va en
 * `test/write-tools-sync.test.ts`.
 */

let counter = 0;
function opId(): string {
  counter += 1;
  return `op-version-${process.pid}-${counter}`;
}

describe('versiones anteriores', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  function fresh(): Promise<ToolContext> {
    return resolveToolContext(test!.serverContext);
  }

  async function expectNotFound(promise: Promise<unknown>): Promise<void> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe('not_found');
    expect((error as ToolError).extra).toBeUndefined();
  }

  it('listar y leer las versiones de una nota visible, sin cuerpo ni causa en la lista', async () => {
    test = await buildTestContext();
    const { versionedNoteId: id, versionedNoteVersionId: versionId } = test.library;
    const listed = await runListVersions(await fresh(), { id });
    expect(listed).toEqual({
      id,
      versions: [
        {
          versionId,
          createdAt: expect.any(String) as unknown as string,
          byteLength: Buffer.byteLength(VERSIONED_OLD_BODY, 'utf8')
        }
      ]
    });
    expect(await runReadVersion(await fresh(), { id, versionId })).toMatchObject({
      id,
      versionId,
      body: VERSIONED_OLD_BODY
    });
  });

  it('una versión con etiqueta privada no se lista, no se lee y no se restaura', async () => {
    test = await buildTestContext();
    const { formerlyPrivateNoteId: id, formerlyPrivateVersionId: versionId } = test.library;
    // La nota es visible hoy…
    const read = await runReadNote(await fresh(), { id });
    // …pero su versión no sale, ni por la lista (sin recuento) ni por su id.
    expect(await runListVersions(await fresh(), { id })).toEqual({ id, versions: [] });
    await expectNotFound(runReadVersion(await fresh(), { id, versionId }));
    // Restaurarla responde como una versión que no existe, sin escribir.
    await expectNotFound(
      runRestoreVersion(await fresh(), {
        id,
        versionId,
        expectedRevision: read.revision,
        operationId: opId()
      })
    );
    await expectNotFound(
      runRestoreVersion(await fresh(), {
        id,
        versionId: 999_999,
        expectedRevision: read.revision,
        operationId: opId()
      })
    );
    const after = await runReadNote(await fresh(), { id });
    expect(after.body).toBe(read.body);
    expect(after.body).not.toContain(BAIT_TAG);
    expect(after.revision).toBe(read.revision);
  });

  it('el escritor rechaza restaurar la versión privada aunque la petición se salte la herramienta', async () => {
    test = await buildTestContext();
    const { formerlyPrivateNoteId: id, formerlyPrivateVersionId: versionId } = test.library;
    const read = await runReadNote(await fresh(), { id });
    const error = await test.ctx
      .write!.restoreVersion({
        id,
        versionId,
        expectedRevision: read.revision,
        operationId: opId(),
        privacy: test.ctx.privacyConfig
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not_found' });
    expect((await runReadNote(await fresh(), { id })).body).toBe(read.body);
  });

  it('versiones de una nota oculta, en la papelera o inexistente: not_found, igual', async () => {
    test = await buildTestContext();
    const library = test.library;
    for (const id of [library.privateTagNoteId, library.privateFolderNoteId, library.trashedNoteId, 'no-existe']) {
      await expectNotFound(runListVersions(await fresh(), { id }));
      await expectNotFound(runReadVersion(await fresh(), { id, versionId: library.versionedNoteVersionId }));
    }
    // Una versión que es de OTRA nota tampoco se lee por esta.
    await expectNotFound(
      runReadVersion(await fresh(), { id: library.publicNoteId, versionId: library.versionedNoteVersionId })
    );
    // Una nota que va a la papelera deja de dar sus versiones.
    await runTrashNote(await fresh(), { id: library.versionedNoteId });
    await expectNotFound(runListVersions(await fresh(), { id: library.versionedNoteId }));
  });

  it('restaurar es una edición nueva: deja el cuerpo de la versión y guarda el de antes como versión', async () => {
    test = await buildTestContext();
    const { versionedNoteId: id, versionedNoteVersionId: versionId } = test.library;
    const before = await runReadNote(await fresh(), { id });
    expect(before.body).toBe(VERSIONED_NEW_BODY);

    const operationId = opId();
    const args = { id, versionId, expectedRevision: before.revision, operationId };
    const result = await runRestoreVersion(await fresh(), args);
    expect(result).toMatchObject({ id, outcome: 'saved', sync: 'not_linked' });
    const after = await runReadNote(await fresh(), { id });
    expect(after.body).toBe(VERSIONED_OLD_BODY);
    expect(result.outcome === 'saved' && result.revision).toBe(after.revision);

    // Lo que había (la segunda redacción) queda recuperable como versión.
    const { versions } = await runListVersions(await fresh(), { id });
    const bodies = await Promise.all(
      versions.map(async (version) => (await runReadVersion(await fresh(), { id, versionId: version.versionId })).body)
    );
    expect(bodies).toContain(VERSIONED_NEW_BODY);

    // Reintentar con el mismo operationId no restaura otra vez.
    expect(await runRestoreVersion(await fresh(), args)).toMatchObject({ outcome: 'saved', replayed: true });
    // El mismo operationId con otra petición: operation_id_reused.
    await expect(
      runRestoreVersion(await fresh(), { ...args, versionId: versionId + 1_000 })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
  });

  it('restaurar con una revisión vieja: revision_conflict y la nota no cambia', async () => {
    test = await buildTestContext();
    const { versionedNoteId: id, versionedNoteVersionId: versionId } = test.library;
    const stale = await runReadNote(await fresh(), { id });
    await runEditNote(await fresh(), {
      id,
      edits: [{ find: 'Segunda', replace: 'Tercera' }],
      expectedRevision: stale.revision,
      operationId: opId()
    });
    const current = await runReadNote(await fresh(), { id });
    await expect(
      runRestoreVersion(await fresh(), { id, versionId, expectedRevision: stale.revision, operationId: opId() })
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await runReadNote(await fresh(), { id })).body).toBe(current.body);
  });

  it('un operationId de una edición no vale para restaurar', async () => {
    test = await buildTestContext();
    const { versionedNoteId: id, versionedNoteVersionId: versionId } = test.library;
    const read = await runReadNote(await fresh(), { id });
    const operationId = opId();
    await runEditNote(await fresh(), {
      id,
      edits: [{ find: 'Segunda', replace: 'Tercera' }],
      expectedRevision: read.revision,
      operationId
    });
    const reread = await runReadNote(await fresh(), { id });
    await expect(
      runRestoreVersion(await fresh(), { id, versionId, expectedRevision: reread.revision, operationId })
    ).rejects.toMatchObject({ code: 'operation_id_reused' });
  });
});
