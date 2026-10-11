/**
 * Búsqueda por ficheros incrustados sin nada privado configurado (SPEC.md §6.3, M6). Desde
 * R6-1 (aa479d3) `hebra_search` y `checkout --consulta` buscaban solo en título y cuerpo para
 * todos, porque una nota visible podía revelar el nombre o el texto de un fichero privado que
 * incrusta. Sin carpetas ni etiquetas privadas no hay nada que revelar: vuelve la búsqueda
 * entera del motor (nombres de adjuntos, texto de PDF). Con algo privado, sigue la de solo
 * título y cuerpo (`codex6-search-embedded.test.ts`, sin tocar).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PrivacyConfig } from '../../src/privacy';
import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';
import { AUDIT_CONFIG, auditHarness, createNote, type AuditHarness } from './audit-harness';
import { capture, removeTempDirs, tempDir } from '../workdir/helpers';

afterEach(removeTempDirs);

const OPEN: PrivacyConfig = { privateFolders: [], privateTags: [] };
const PDF_TEXT = 'PresupuestoTrimestralCodex7';
const FILE_NAME = 'PlanoReformaCodex7';

/**
 * Una nota visible en la raíz que incrusta, por hash, un PDF con texto extraído y un fichero
 * suelto de `Diario` (carpeta privada en `AUDIT_CONFIG`). Ninguno de los dos nombres ni el
 * texto del PDF aparecen en el cuerpo de la nota.
 */
async function scenario(config: PrivacyConfig): Promise<AuditHarness<string>> {
  return auditHarness(async (engine, library) => {
    const pdf = await engine.blobPut(new TextEncoder().encode('%PDF-1.4\n'), { mime: 'application/pdf' });
    await engine.fileCreate(library.folders.diario, 'informe.pdf', pdf.sha256);
    await engine.pdfTextReindexWrite(1, [{ sha256: pdf.sha256, text: PDF_TEXT }], 1, 0, null);
    const plan = await engine.blobPut(new TextEncoder().encode('medidas'), { mime: 'text/plain' });
    await engine.fileCreate(library.folders.diario, `${FILE_NAME}.txt`, plan.sha256);
    const note = await createNote(
      engine,
      null,
      `# Obra visible\ncuerpo público\n![[sha256:${pdf.sha256}|adjunto.pdf]]\n![[sha256:${plan.sha256}|otro.txt]]\n`
    );
    return note.id;
  }, config);
}

function ids(result: { json: { results: Array<{ id: string }> } }): string[] {
  return result.json.results.map((item) => item.id);
}

it('sin privados, hebra_search encuentra la nota por el texto de un PDF incrustado y por el nombre de un adjunto', async () => {
  const h = await scenario(OPEN);
  try {
    expect(ids(await h.call('hebra_search', { query: PDF_TEXT }))).toEqual([h.extra]);
    expect(ids(await h.call('hebra_search', { query: FILE_NAME }))).toEqual([h.extra]);
    // Y un término negativo por el PDF la excluye, como en Hebra.
    expect(ids(await h.call('hebra_search', { query: `público -${PDF_TEXT}` }))).not.toContain(h.extra);
    // El puerto, sin opciones, sigue con el valor seguro: solo título y cuerpo.
    expect((await h.port.search(PDF_TEXT, null, 20)).items).toEqual([]);
    expect((await h.port.search(PDF_TEXT, null, 20, null, null, { embedded: true })).items.map((hit) => hit.id))
      .toEqual([h.extra]);
  } finally {
    await h.close();
  }
});

it('con privados, la misma búsqueda no encuentra nada por los incrustados', async () => {
  const h = await scenario(AUDIT_CONFIG);
  try {
    const pdf = await h.call('hebra_search', { query: PDF_TEXT });
    expect(pdf.json).toEqual({ results: [], nextCursor: null });
    const name = await h.call('hebra_search', { query: FILE_NAME });
    expect(name.json).toEqual({ results: [], nextCursor: null });
    expect(name.raw).not.toContain(FILE_NAME);
  } finally {
    await h.close();
  }
});

it('si config.json pasa de vacío a con privados a mitad de la búsqueda, no sale lo encontrado solo por un incrustado', async () => {
  const h = await scenario(OPEN);
  const path = join(h.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
  h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
  const original = h.port.search.bind(h.port);
  const seen: Array<boolean | undefined> = [];
  const spy = vi.spyOn(h.port, 'search').mockImplementation(async (...args) => {
    const page = await original(...args);
    seen.push(args[5]?.embedded);
    if (seen.length === 1) {
      // La primera página ya trae la nota por el PDF; la configuración cambia antes de
      // que la puerta final la juzgue.
      expect(page.items.map((hit) => hit.id)).toContain(h.extra);
      writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    }
    return page;
  });
  try {
    const result = await h.call('hebra_search', { query: PDF_TEXT });
    expect(seen[0]).toBe(true);
    // La puerta repitió la llamada con la configuración nueva: ya sin incrustados.
    expect(seen.slice(1)).not.toContain(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(result.json).toEqual({ results: [], nextCursor: null });
  } finally {
    spy.mockRestore();
    await h.close();
  }
});

function openerFor(h: AuditHarness<string>, config: PrivacyConfig): OpenLibrary {
  return async () => ({
    role: 'this', linked: true, port: h.port, privacyConfig: config,
    currentPrivacyConfig: async () => config,
    replaceBody: (input) => replaceBody(h.port, { ...input, privacy: config }, () => {}),
    trashConflictCopies: (input) => trashConflictCopies(h.port, { ...input, privacy: config }, () => {}),
    syncRound: async () => ({ kind: 'done', result: 'ok' }), close: async () => {}
  });
}

it('checkout --consulta: sin privados selecciona por el texto del PDF; con privados, no', async () => {
  for (const [config, expected] of [[OPEN, true], [AUDIT_CONFIG, false]] as const) {
    const h = await scenario(config);
    const cwd = tempDir('search-embedded-checkout-');
    try {
      await checkoutCommand(capture(cwd).io, openerFor(h, config), {
        dir: 'trabajo', all: false, consultas: [PDF_TEXT], titulos: [], carpetas: [], forzar: false
      });
      const notas = new Workdir(join(cwd, 'trabajo')).readCheckout().notas.map((entry) => entry.id);
      expect(notas).toEqual(expected ? [h.extra] : []);
    } finally {
      await h.close();
    }
  }
});
