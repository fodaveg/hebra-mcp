/**
 * Lecturas del puerto que se agrupan o se guardan (`src/store/node-port.ts`):
 * - `libraryId()` (R4.9): el mismo id que `libraryOpen()`, y no vuelve a pasar por la cola
 *   tras la primera lectura.
 * - `resolveLinks()` (R4.5): las mismas resoluciones que `resolveLink` ref a ref, en el
 *   mismo orden, en un solo turno de la cola.
 * - Consultas propias preparadas una vez: llamarlas muchas veces da el mismo resultado.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

describe('NodeLibraryPort: lecturas agrupadas', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('libraryId() es el de libraryOpen() y se repite sin cambios', async () => {
    test = await buildTestContext();
    const expected = (await test.ctx.port.libraryOpen()).libraryId;
    expect(await test.ctx.port.libraryId()).toBe(expected);
    expect(await test.ctx.port.libraryId()).toBe(expected);
  });

  it('resolveLinks() da lo mismo que resolveLink() ref a ref, en el mismo orden', async () => {
    test = await buildTestContext();
    const refs = [
      test.library.publicNoteTitle,
      `id:${test.library.publicNote2Id}`,
      'No existe esta nota',
      test.library.duplicateTitle,
      ''
    ];
    const batch = await test.ctx.port.resolveLinks(refs);
    const single = await Promise.all(refs.map((ref) => test!.ctx.port.resolveLink(ref)));
    expect(batch).toEqual(single);
    expect(batch[0]!.status).toBe('resolved');
    expect(batch[2]!.status).toBe('missing');
    expect(await test.ctx.port.resolveLinks([])).toEqual([]);
  });

  it('las consultas preparadas devuelven lo mismo en llamadas repetidas', async () => {
    test = await buildTestContext();
    const first = await test.ctx.port.notesVisibilityIndex();
    const second = await test.ctx.port.notesVisibilityIndex();
    expect(second).toEqual(first);
    const attachments = await test.ctx.port.noteAttachments(test.library.attachmentsNoteId);
    expect(await test.ctx.port.noteAttachments(test.library.attachmentsNoteId)).toEqual(attachments);
    const trash = await test.ctx.port.trashIndex();
    expect(await test.ctx.port.trashIndex()).toEqual(trash);
  });
});
