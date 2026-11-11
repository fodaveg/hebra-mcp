import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditHarness } from './audit-harness';

// Límite documentado (C11, SPEC.md §6.3 "Versiones" y D16, 11 oct 2026): para saber si una
// versión de una nota VISIBLE lleva una etiqueta privada hay que leer y derivar su cuerpo, y
// eso cuesta tiempo. Medido entonces (Mac, Node 24, ocho versiones de unos 400 KB): mediana
// de unos 285-310 ms con las versiones privadas frente a menos de 1 ms sin ellas. Dato
// histórico: el tiempo NO se mide en la suite (un test de milisegundos no es determinista).
// Lo que sí es contrato y se comprueba aquí: la respuesta es exactamente la misma con las
// versiones privadas presentes y sin ellas, y no contiene nada de su contenido. La única
// diferencia aceptada es el tiempo. Las versiones de una nota oculta no se derivan: la nota
// responde `not_found` antes.
it('la respuesta de una página no cambia con una cola de versiones privadas ni contiene su contenido', async () => {
  const h = await auditHarness(async (_engine, library, db) => {
    const ids: number[] = [];
    // Mismo método de siembra que test/tools/versions-pagination.test.ts. Ocho
    // instantáneas privadas de Markdown normal, dentro del techo de 500 del motor.
    const insert = db.prepare(`INSERT INTO note_versions
      (note_id, created_at, body, body_sha256, byte_length, cause) VALUES (?, ?, ?, ?, ?, NULL)`);
    for (let index = 0; index < 8; index++) {
      const body = `# Redacción privada ${index}\n#secreto\n` +
        '- **dato** y [referencia](https://example.invalid/)\n'.repeat(20);
      ids.push(Number(insert.run(library.versionedNoteId, Date.now() + index * 1_000,
        body, createHash('sha256').update(body).digest('hex'), Buffer.byteLength(body)).lastInsertRowid));
    }
    return ids;
  });
  try {
    const args = { id: h.library.versionedNoteId, limit: 1 };
    const withHidden = await h.call('hebra_list_versions', args);
    expect(withHidden.isError, withHidden.raw).toBe(false);
    await h.mutate(async (_engine, _library, db) => {
      db.prepare('DELETE FROM note_versions WHERE id IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(h.extra));
    });
    const withoutHidden = await h.call('hebra_list_versions', args);
    expect(withoutHidden.isError, withoutHidden.raw).toBe(false);
    expect(withHidden.json).toEqual(withoutHidden.json);
    expect(/#secreto|Redacción privada/.test(withHidden.raw)).toBe(false);
  } finally { await h.close(); }
});
