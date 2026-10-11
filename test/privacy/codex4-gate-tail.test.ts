import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { gateStats } from '../../src/server/privacy-gate';
import { auditHarness, createNote, NOT_FOUND, saveBody, type AuditHarness } from './audit-harness';
import { ATTACHMENT_TEXT } from '../fixtures/test-library';

// Ajustado en la 3.ª vuelta de d64e187e (arreglo de R4-1): la puerta ya no espera nada
// DESPUÉS de su transacción (mira `config.json` dentro de ella, síncrono), así que no hay
// tercer current() en el que intercalar. El cambio va en la última espera que queda, el
// current() de la puerta justo ANTES de su transacción (el segundo de la llamada).
// No se cambia la puerta ni se fabrica una fila SQLite.
async function duringFinalConfig<T>(h: AuditHarness<T>, change: () => Promise<unknown>) {
  writeFileSync(join(h.dataDir, 'config.json'), JSON.stringify({ privateFolders: [], privateTags: ['secreto'] }));
  const source = await PrivacyConfigSource.open(h.dataDir);
  h.serverContext.privacyConfigSource = source;
  const current = source.current.bind(source);
  let calls = 0;
  const spy = vi.spyOn(source, 'current').mockImplementation(async () => {
    if (++calls === 2) await change();
    return current();
  });
  return { spy, calls: () => calls };
}

it('R4: read_note no entrega cuerpo ocultado durante la huella posterior a la transacción', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# CEBO_R4_COLA\ncuerpo confidencial\n')).id);
  const hook = await duringFinalConfig(h, () => h.mutate((engine) => saveBody(engine, h.extra, '# CEBO_R4_COLA\ncuerpo confidencial\n#secreto\n')));
  try {
    const before = await h.port.privacyEpoch();
    const result = await h.call('hebra_read_note', { id: h.extra });
    expect(hook.calls()).toBeGreaterThanOrEqual(2);
    expect(await h.port.privacyEpoch()).not.toBe(before);
    hook.spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    expect(result.json, 'La huella final espera I/O después del snapshot: salen título y cuerpo de una nota ya privada').toEqual(NOT_FOUND);
  } finally { hook.spy.mockRestore(); await h.close(); }
});

it('R4: read_attachment no entrega bytes compartidos con una oculta durante la huella final', async () => {
  const h = await auditHarness(async () => ({}));
  const hook = await duringFinalConfig(h, () => h.mutate((engine, library) => saveBody(engine, library.privateTagNoteId,
    `# Privada\n#secreto\n![[sha256:${library.attachments.text}|privado.txt]]\n`)));
  try {
    const result = await h.call('hebra_read_attachment', { id: h.library.attachmentsNoteId, attachmentId: h.library.attachments.text });
    expect(hook.calls()).toBeGreaterThanOrEqual(2);
    hook.spy.mockRestore();
    expect((await h.call('hebra_read_attachment', { id: h.library.attachmentsNoteId, attachmentId: h.library.attachments.text })).json).toEqual({ error: 'attachment_unavailable' });
    expect(result.raw, 'Salen bytes que M6 acaba de ocultar antes de enviar la respuesta MCP').not.toContain(ATTACHMENT_TEXT);
  } finally { hook.spy.mockRestore(); await h.close(); }
});

it('R4: append no entrega candidatos del error ocultado durante la huella final', async () => {
  const body = '# Pública\n## CEBO_R4_APARTADO\nuno\n## CEBO_R4_APARTADO\ndos\n';
  const h = await auditHarness(async (engine) => (await createNote(engine, null, body)).id);
  const hook = await duringFinalConfig(h, () => h.mutate((engine) => saveBody(engine, h.extra, body + '#secreto\n')));
  const append = vi.spyOn(h.serverContext.write!, 'appendToNote');
  try {
    const result = await h.call('hebra_append_to_note', { id: h.extra, heading: 'CEBO_R4_APARTADO', text: 'nuevo' });
    expect(hook.calls()).toBeGreaterThanOrEqual(2);
    expect(append).toHaveBeenCalledTimes(1);
    hook.spy.mockRestore();
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    expect(result.json, 'ambiguous_heading publica los candidatos de la nota ocultada después de privacyRecheck').toEqual(NOT_FOUND);
  } finally { append.mockRestore(); hook.spy.mockRestore(); await h.close(); }
});

it('R4 control: config que cambia durante la huella final sí invalida y repite la lectura', async () => {
  const h = await auditHarness(async (engine) => (await createNote(engine, null, '# Config\n#r4cola\n')).id);
  const hook = await duringFinalConfig(h, async () => {
    writeFileSync(join(h.dataDir, 'config.json'), JSON.stringify({ privateFolders: [], privateTags: ['secreto', 'r4cola'] }));
  });
  try {
    gateStats.reset();
    expect((await h.call('hebra_read_note', { id: h.extra })).json).toEqual(NOT_FOUND);
    expect(gateStats.repeatsByConfig).toBe(1);
  } finally { hook.spy.mockRestore(); await h.close(); }
});

it('R4 control: un error de escritura con época cambiada responde not_found sin repetir aunque siga visible', async () => {
  const h = await auditHarness(async (engine) => ({
    target: (await createNote(engine, null, '# Pública\n## Duplicado\nuno\n## Duplicado\ndos\n')).id,
    other: (await createNote(engine, null, '# Ajena\nantes\n')).id
  }));
  const append = h.serverContext.write!.appendToNote.bind(h.serverContext.write);
  const spy = vi.spyOn(h.serverContext.write!, 'appendToNote').mockImplementationOnce(async (input) => {
    try { return await append(input); }
    catch (error) {
      await h.mutate((engine) => saveBody(engine, h.extra.other, '# Ajena\ndespués\n'));
      throw error;
    }
  });
  try {
    const result = await h.call('hebra_append_to_note', { id: h.extra.target, heading: 'Duplicado', text: 'nuevo' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.json).toEqual(NOT_FOUND);
    expect((await h.call('hebra_read_note', { id: h.extra.target })).isError).toBe(false);
  } finally { spy.mockRestore(); await h.close(); }
});
