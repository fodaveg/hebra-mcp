/**
 * `hebra_read_note` perezosa (A4.0 del plan de memoria, 6 nov 2026): registrada con
 * `privacyLoad: 'lazy'`, solo carga en el filtro de privados la nota pedida, sus homónimas por
 * título y el original de una copia de conflicto. Cada caso pasa por `expectLazyEquivalent`
 * (`test/fixtures/privacy-load.ts`): sin preguntas por notas no cargadas y con la respuesta
 * idéntica a la de `'all'`; y además se comprueba QUÉ responde.
 *
 * Es la herramienta de referencia del patrón para A4-A8.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import { expectLazyEquivalent } from '../fixtures/privacy-load';
import {
  AUDIT_CONFIG,
  auditHarness,
  createNote,
  lockedBody,
  NOT_FOUND,
  saveBody,
  type AuditHarness
} from '../privacy/audit-harness';

/** Título de una visible con dos homónimas ocultas (por carpeta y por etiqueta). */
const ONE_VISIBLE = 'Homónima perezosa';
/** Título que solo llevan notas ocultas. */
const ONLY_HIDDEN = 'Homónima solo oculta';
const LOCKED_TITLE = 'Nota bloqueada perezosa';

interface Extra {
  visibleHomonymId: string;
  hiddenDuplicateId: string;
  lockedId: string;
}

/** La biblioteca de prueba más: homónimas visibles y ocultas, una oculta con el título
 *  repetido de la biblioteca (`duplicateTitle`) y una nota bloqueada en la raíz. */
async function lazyHarness(config: PrivacyConfig): Promise<AuditHarness<Extra>> {
  return auditHarness<Extra>(async (engine, library) => {
    const visible = await createNote(engine, null, `# ${ONE_VISIBLE}\nLa que se ve.\n`);
    await createNote(engine, library.folders.diario2026, `# ${ONE_VISIBLE}\nOculta por carpeta.\n`);
    await createNote(engine, null, `# ${ONE_VISIBLE}\n#secreto\nOculta por etiqueta.\n`);
    await createNote(engine, library.folders.diario2026, `# ${ONLY_HIDDEN}\nOculta por carpeta.\n`);
    await createNote(engine, null, `# ${ONLY_HIDDEN}\n#secreto/personal\nOculta por etiqueta.\n`);
    const hiddenDuplicate = await createNote(
      engine,
      library.folders.diario2026,
      `# ${library.duplicateTitle}\nCandidata oculta.\n`
    );
    const locked = await createNote(engine, null, `# ${LOCKED_TITLE}\nAntes de bloquearla.\n`);
    await saveBody(engine, locked.id, lockedBody(LOCKED_TITLE, []));
    return { visibleHomonymId: visible.id, hiddenDuplicateId: hiddenDuplicate.id, lockedId: locked.id };
  }, config);
}

describe('hebra_read_note con privacyLoad lazy: igual que con la biblioteca entera', () => {
  let h: AuditHarness<Extra> | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const read = (args: Record<string, unknown>) => expectLazyEquivalent(h!.serverContext, 'hebra_read_note', args);

  it('nota pública por id', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await read({ id: h.library.publicNoteId });
    expect(call.isError).toBe(false);
    expect(call.json.id).toBe(h.library.publicNoteId);
  });

  it('privada por carpeta, privada por etiqueta, en la papelera e inexistente: not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    for (const id of [
      h.library.privateFolderNoteId,
      h.library.privateTagNoteId,
      h.library.trashedNoteId,
      h.library.trashedPrivateTagNoteId,
      'no-existe-0000'
    ]) {
      const call = await read({ id });
      expect(call.json, id).toEqual(NOT_FOUND);
    }
  });

  it('bloqueada: oculta con etiquetas privadas (A1), visible sin ellas', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    expect((await read({ id: h.extra.lockedId })).json).toEqual(NOT_FOUND);
    await h.close();

    h = await lazyHarness({ privateFolders: [['diario']], privateTags: [] });
    const call = await read({ id: h.extra.lockedId });
    expect(call.isError).toBe(false);
    expect(call.json.id).toBe(h.extra.lockedId);
    // Con `heading`, una bloqueada es `note_locked`: también igual.
    expect((await read({ id: h.extra.lockedId, heading: 'Algo' })).json).toEqual({ error: 'note_locked' });
  });

  it('por título: la única visible entre homónimas ocultas', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await read({ title: ONE_VISIBLE });
    expect(call.isError).toBe(false);
    expect(call.json.id).toBe(h.extra.visibleHomonymId);
  });

  it('por título: dos visibles y una oculta es ambiguous_title, solo con las visibles', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await read({ title: h.library.duplicateTitle });
    expect(call.json.error).toBe('ambiguous_title');
    const ids = (call.json.candidates as Array<{ id: string }>).map((candidate) => candidate.id).sort();
    expect(ids).toEqual([h.library.duplicateNoteAId, h.library.duplicateNoteBId].sort());
    expect(ids).not.toContain(h.extra.hiddenDuplicateId);
  });

  it('por título: solo homónimas ocultas, not_found', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    expect((await read({ title: ONLY_HIDDEN })).json).toEqual(NOT_FOUND);
  });

  it('copia de conflicto: conflictOf del original visible', async () => {
    h = await lazyHarness(AUDIT_CONFIG);
    const call = await read({ id: h.library.conflictCopyId });
    expect(call.isError).toBe(false);
    expect(call.json.conflictOf).toBe(h.library.publicNoteId);
  });
});
