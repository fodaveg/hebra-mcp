import { describe, expect, expectTypeOf, it } from 'vitest';
import * as limits from '../src/store/document-limits';
import {
  DOCUMENT_ERROR_CODES,
  type DocSessionLike,
  type DocumentError,
  type DocumentErrorCode,
  type EditIn,
  type WriteOut
} from '../src/store/document-types';

type Op = { type: 'setCells'; sheet: string };

/** Los tipos se comprueban con `npm run typecheck`; aquí además lo que se ve en ejecución. */
describe('tipos y topes de documentos del MCP', () => {
  it('EditIn lleva expectedRevision y expectedLayout, y exige ops o undoOperationId', () => {
    const ok: EditIn<Op> = {
      id: 'F1',
      operationId: 'op-1',
      expectedRevision: 'r1',
      expectedLayout: 'l1',
      ops: [{ type: 'setCells', sheet: 'A', expect: { A1: null } }]
    };
    const deshacer: EditIn<Op> = { id: 'F1', operationId: 'op-2', undoOperationId: 'op-1' };
    expect(ok.expectedLayout).toBe('l1');
    expect(deshacer.id).toBe('F1');
    // @ts-expect-error sin ops ni undoOperationId no es una edición
    const mal: EditIn<Op> = { id: 'F1', operationId: 'op-3' };
    expect(mal).toBeDefined();
  });

  it('WriteOut lleva revision y layoutRevision opcional', () => {
    expectTypeOf<WriteOut['revision']>().toEqualTypeOf<string>();
    expectTypeOf<WriteOut['layoutRevision']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<WriteOut['outcome']>().toEqualTypeOf<'saved' | 'already' | 'validated'>();
  });

  it('un código fuera de la lista no compila y la unión coincide con la tabla', () => {
    expectTypeOf<DocumentErrorCode>().toEqualTypeOf<(typeof DOCUMENT_ERROR_CODES)[number]>();
    expect(new Set(DOCUMENT_ERROR_CODES).size).toBe(DOCUMENT_ERROR_CODES.length);
    const e: DocumentError<'file_too_large'> = {
      code: 'file_too_large',
      byteLength: 30,
      maxBytes: limits.DOCUMENT_MAX_BYTES
    };
    expect(e.maxBytes).toBe(25 * 1024 * 1024);
    // @ts-expect-error falta maxBytes
    const mal: DocumentError<'file_too_large'> = { code: 'file_too_large', byteLength: 1 };
    expect(mal.code).toBe('file_too_large');
  });

  it('DocSessionLike es estructural: un objeto suelto la cumple', () => {
    const sesion: DocSessionLike = {
      revision: () => 'r',
      apply: async () => ({ revision: 'r2', changed: {} }),
      close: () => {}
    };
    expect(sesion.revision()).toBe('r');
  });

  it('topes: cifras del estudio', () => {
    expect(limits.DOCUMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(limits.EDIT_OPS_MAX).toBe(200);
    expect(limits.EDIT_OPS_MAX_BYTES).toBe(512 * 1024);
    expect(limits.DOCUMENT_RESPONSE_MAX_CHARS).toBe(30_000);
    expect(limits.DOCUMENT_EDIT_TIMEOUT_MS).toBeGreaterThan(limits.DOCUMENT_READ_TIMEOUT_MS);
  });
});
