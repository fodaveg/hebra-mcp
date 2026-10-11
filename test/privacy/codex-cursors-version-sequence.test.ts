import { describe, expect, it } from 'vitest';
import { auditHarness, createNote, saveBody } from './audit-harness';

describe('Codex: numeración global de versiones privadas', () => {
  // No se arregla (decisión de la sesión principal, 11 oct 2026; límite en SPEC.md §6.3
  // «Versiones» y D16, C10): `versionId` y el cursor son el id de la tabla de versiones del
  // motor, una secuencia de toda la biblioteca. Se ve que hubo versiones de otras notas,
  // nada de ellas. Se deja la sonda como documentación del límite.
  it.skip('los ids y cursores visibles no deben contar versiones de una nota oculta', async () => {
    const observations: Array<{ delta: number; cursorDelta: number }> = [];
    for (const withHiddenVersion of [false, true]) {
      const h = await auditHarness(async (engine, library) => {
        const visible = await createNote(engine, null, '# Sonda pública\nprimera redacción\n');
        await engine.noteVersionSnapshot(visible.id);
        await saveBody(engine, visible.id, '# Sonda pública\nsegunda redacción\n');
        let hiddenId: string | undefined;
        if (withHiddenVersion) {
          const hidden = await createNote(engine, library.folders.diario, '# Documento oculto\nCEBO_VERSION_PRIVADA\n');
          hiddenId = hidden.id;
          await engine.noteVersionSnapshot(hidden.id);
        }
        await engine.noteVersionSnapshot(visible.id);
        return { visibleId: visible.id, hiddenId };
      });
      try {
        if (h.extra.hiddenId) {
          expect((await h.call('hebra_list_versions', { id: h.extra.hiddenId })).json).toEqual({ error: 'not_found' });
        }
        const page1 = await h.call('hebra_list_versions', { id: h.extra.visibleId, limit: 1 });
        expect(page1.isError, page1.raw).toBe(false);
        expect(page1.json.nextCursor).toMatch(/^v1\./);
        const page2 = await h.call('hebra_list_versions', {
          id: h.extra.visibleId, limit: 1, cursor: page1.json.nextCursor
        });
        expect(page2.isError, page2.raw).toBe(false);
        const older = page2.json.versions[0].versionId;
        observations.push({
          delta: page1.json.versions[0].versionId - older,
          cursorDelta: Number(Buffer.from(page1.json.nextCursor.slice(3), 'base64url').toString()) - older
        });
      } finally {
        await h.close();
      }
    }
    expect(observations[0]).toEqual({ delta: 1, cursorDelta: 1 });
    expect(observations[1], 'Una versión oculta añade un hueco observable en versionId y en el cursor de la nota pública').toEqual(observations[0]);
  });
});
