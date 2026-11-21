import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DocSession } from '../vendor/hebra/src/lib/documents/contract';
import * as limits from '../src/store/document-limits';
import {
  DOCUMENT_ERROR_CODES,
  type DocApplyResult,
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

  it('DocSessionLike es estructural: un objeto suelto la cumple', async () => {
    const sesion: DocSessionLike<string, Op> = {
      revision: () => 'r',
      layoutRevision: () => 'l',
      apply: async () => ({
        ok: true,
        changed: true,
        revision: 'r2',
        layoutRevision: 'l',
        inverse: []
      }),
      flush: async () => {},
      close: async () => {}
    };
    expect(sesion.revision()).toBe('r');
    const r = await sesion.apply([], 'agent', { seed: 's' });
    expect(r.ok).toBe(true);
  });

  it('la firma de apply coincide con la de la DocSession real', () => {
    type Real = DocSession<string, Op>;
    expectTypeOf<DocSessionLike<string, Op>['apply']>().toEqualTypeOf<Real['apply']>();
    expectTypeOf<DocSessionLike<string, Op>['layoutRevision']>().toEqualTypeOf<() => string>();
    expectTypeOf<DocSessionLike<string, Op>['close']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<DocSessionLike<string, Op>['flush']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<DocApplyResult<string, Op>>().toEqualTypeOf<
      Awaited<ReturnType<Real['apply']>>
    >();
  });

  it('too_large y op_invalid son códigos de error', () => {
    expect(DOCUMENT_ERROR_CODES).toContain('too_large');
    expect(DOCUMENT_ERROR_CODES).toContain('op_invalid');
    const e: DocumentError<'op_invalid'> = { code: 'op_invalid' };
    expect(e.code).toBe('op_invalid');
  });

  it('topes: cifras del estudio', () => {
    expect(limits.DOCUMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(limits.EDIT_OPS_MAX).toBe(200);
    expect(limits.EDIT_OPS_MAX_BYTES).toBe(512 * 1024);
    expect(limits.DOCUMENT_RESPONSE_MAX_CHARS).toBe(30_000);
    expect(limits.DOCUMENT_EDIT_TIMEOUT_MS).toBeGreaterThan(limits.DOCUMENT_READ_TIMEOUT_MS);
  });
});
