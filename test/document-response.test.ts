import { describe, expect, it } from 'vitest';
import { documentError, documentOk, pageResponse } from '../src/server/document-response';
import { ToolError } from '../src/server/errors';
import { DOCUMENT_RESPONSE_MAX_CHARS } from '../src/store/document-limits';
import { DOCUMENT_ERROR_CODES, type DocumentErrorCode } from '../src/store/document-types';

const SENTINEL = 'CENTINELA-contenido-del-documento-9f3a';
const base = { id: 'F1', name: 'hoja.ods', revision: 'r1', byteLength: 10 };

function textOf(result: { content: unknown }): string {
  return (result.content as { text: string }[])[0].text;
}

describe('documentOk', () => {
  it('lleva untrustedContent true y no se puede pisar desde el payload', () => {
    const out = JSON.parse(textOf(documentOk(base, { untrustedContent: false, cells: [1] })));
    expect(out.untrustedContent).toBe(true);
    expect(out.cells).toEqual([1]);
    expect(out.id).toBe('F1');
  });

  it('pasado el tope de 30.000 caracteres responde too_large, no un texto cortado', () => {
    const out = documentOk(base, { big: 'x'.repeat(DOCUMENT_RESPONSE_MAX_CHARS) });
    expect(out.isError).toBe(true);
    expect(JSON.parse(textOf(out)).code).toBe('too_large');
    expect(textOf(out).length).toBeLessThan(200);
  });

  it('justo en el tope sale entera', () => {
    const empty = textOf(documentOk(base, { pad: '' })).length;
    const out = documentOk(base, { pad: 'x'.repeat(DOCUMENT_RESPONSE_MAX_CHARS - empty) });
    expect(out.isError).toBeUndefined();
    expect(textOf(out).length).toBe(DOCUMENT_RESPONSE_MAX_CHARS);
  });
});

describe('pageResponse', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i, text: 'y'.repeat(900) }));

  it('cada página cabe en 30.000 caracteres y el cursor las recorre sin perder ni repetir', () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = pageResponse(base, items, { cursor });
      const text = textOf(result);
      expect(text.length).toBeLessThanOrEqual(DOCUMENT_RESPONSE_MAX_CHARS);
      const page = JSON.parse(text);
      expect(page.untrustedContent).toBe(true);
      expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map((it: { i: number }) => it.i));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(items.map((it) => it.i));
  });

  it('la última página lleva nextCursor null y una lista vacía cabe en una', () => {
    expect(JSON.parse(textOf(pageResponse(base, []))).nextCursor).toBeNull();
    expect(JSON.parse(textOf(pageResponse(base, [1, 2]))).nextCursor).toBeNull();
  });

  it('un cursor ajeno, mal formado o fuera de rango es invalid_input', () => {
    for (const cursor of ['g1.2', 'd1.', 'd1.-1', 'd1.x', 'd1.3', '2']) {
      expect(() => pageResponse(base, [1, 2], { cursor })).toThrow(ToolError);
    }
    expect(() => pageResponse(base, [1, 2], { cursor: 'd1.2' })).not.toThrow();
  });

  it('un elemento que no cabe ni solo da too_large, no una página vacía con cursor', () => {
    const out = pageResponse(base, [{ big: 'z'.repeat(DOCUMENT_RESPONSE_MAX_CHARS) }]);
    expect(out.isError).toBe(true);
    expect(JSON.parse(textOf(out)).code).toBe('too_large');
  });
});

describe('documentError', () => {
  /** Un detalle hostil por código: campos válidos, más extras y textos con el centinela. */
  const hostile: Record<DocumentErrorCode, Record<string, unknown>> = {
    precondition_failed: { opIndex: 2, target: 'B2', actual: SENTINEL, message: SENTINEL },
    generation_changed: { value: SENTINEL },
    batch_invalid: {
      issues: Array.from({ length: 30 }, (_, i) => ({
        opIndex: i,
        path: 'ops[0].range',
        reason: 'range_invalid',
        cellValue: SENTINEL,
        nested: { message: SENTINEL }
      })),
      message: SENTINEL
    },
    op_unsupported: { opIndex: 1, found: SENTINEL },
    document_invalid: { message: SENTINEL, cause: new Error(SENTINEL) },
    document_too_complex: { message: SENTINEL },
    document_busy: { retryAfterSeconds: 3, message: SENTINEL },
    too_large: { maxChars: 30000, text: SENTINEL },
    op_invalid: { opIndex: 4, value: SENTINEL, detail: { text: SENTINEL } },
    file_too_large: { byteLength: 30, maxBytes: 20, name: SENTINEL },
    file_unavailable: { message: SENTINEL },
    file_exists: { id: 'F9', name: SENTINEL },
    operation_id_reused: { previous: SENTINEL },
    writer_outdated: { message: SENTINEL },
    not_found: { name: SENTINEL },
    space_access_denied: { message: SENTINEL },
    doc_head_invalid: { head: SENTINEL }
  };

  it('el caso hostil cubre todos los códigos', () => {
    expect(Object.keys(hostile).sort()).toEqual([...DOCUMENT_ERROR_CODES].sort());
  });

  it.each(DOCUMENT_ERROR_CODES)('%s: el centinela del documento no sale en la respuesta', (code) => {
    const result = documentError({ code, ...hostile[code] } as never);
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.parse(text).code).toBe(code);
    expect(JSON.parse(text).error).toBe(code);
  });

  it('conserva los campos propios de su código y acota issues a 20', () => {
    const precondition = JSON.parse(textOf(documentError({ code: 'precondition_failed', opIndex: 2, target: 'B2' })));
    expect(precondition).toMatchObject({ opIndex: 2, target: 'B2' });
    const batch = JSON.parse(textOf(documentError({ code: 'batch_invalid', issues: hostile.batch_invalid.issues as never })));
    expect(batch.issues).toHaveLength(20);
    expect(batch.issues[0]).toEqual({ opIndex: 0, path: 'ops[0].range', reason: 'range_invalid' });
    const busy = JSON.parse(textOf(documentError({ code: 'document_busy', retryAfterSeconds: 5 })));
    expect(busy.retryAfterSeconds).toBe(5);
  });

  it('un texto largo dentro de un error se corta', () => {
    const out = JSON.parse(
      textOf(documentError({ code: 'precondition_failed', opIndex: 0, target: 'A'.repeat(5000) }))
    );
    expect(out.target.length).toBe(200);
  });
});
