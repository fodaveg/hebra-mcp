import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { auditHarness } from './audit-harness';

// Límite documentado (C11, SPEC.md §6.3 «Versiones» y D16, 11 oct 2026): para saber si una
// versión de una nota VISIBLE lleva una etiqueta privada hay que leer y derivar su cuerpo, y
// eso cuesta tiempo. Medido aquí (Mac, Node 24): mediana de unos 285-310 ms con las ocho
// versiones privadas de unos 400 KB frente a menos de 1 ms sin ellas. Las versiones que
// quedan fuera por el estado de su nota (oculta) no se derivan: la nota responde
// `not_found` antes. Se deja la sonda para medirlo, sin contarla como fallo.
it.skip('la latencia de una página no revela una cola de versiones privadas', async () => {
  const h = await auditHarness(async (_engine, library, db) => {
    const ids: number[] = [];
    // Mismo método de siembra que test/tools/versions-pagination.test.ts. Ocho
    // instantáneas privadas de Markdown normal, dentro del techo de 500 del motor.
    const insert = db.prepare(`INSERT INTO note_versions
      (note_id, created_at, body, body_sha256, byte_length, cause) VALUES (?, ?, ?, ?, ?, NULL)`);
    for (let index = 0; index < 8; index++) {
      const body = `# Redacción privada ${index}\n#secreto\n` +
        '- **dato** y [referencia](https://example.invalid/)\n'.repeat(8_000);
      ids.push(Number(insert.run(library.versionedNoteId, Date.now() + index * 1_000,
        body, createHash('sha256').update(body).digest('hex'), Buffer.byteLength(body)).lastInsertRowid));
    }
    return ids;
  });
  try {
    const args = { id: h.library.versionedNoteId, limit: 1 };
    const expected = (await h.call('hebra_list_versions', args)).json;
    const median = async () => {
      const measurements: number[] = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        const response = await h.call('hebra_list_versions', args);
        measurements.push(performance.now() - started);
        // Las salidas son exactamente iguales: la única variable observada es tiempo.
        expect(response.json).toEqual(expected);
      }
      return measurements.sort((a, b) => a - b)[1]!;
    };
    const withHidden = await median();
    await h.mutate(async (_engine, _library, db) => {
      db.prepare('DELETE FROM note_versions WHERE id IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(h.extra));
    });
    await h.call('hebra_list_versions', args); // calienta igualmente la variante sin ocultas
    const withoutHidden = await median();
    // Margen amplio contra jitter: cinco veces el control y 50 ms adicionales.
    expect(withHidden,
      `Tiempo observable por versiones ocultas: mediana con=${withHidden.toFixed(1)}ms, sin=${withoutHidden.toFixed(1)}ms`)
      .toBeLessThanOrEqual(withoutHidden * 5 + 50);
  } finally { await h.close(); }
}, 30_000);
