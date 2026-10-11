/**
 * `hebra_add_attachment` con `heading` y `headingOccurrence` (D9 + D11, ampliada el 11 oct
 * 2026, tarea c106e726): la referencia va al final del apartado, subapartados incluidos,
 * con la regla de `hebra_append_to_note`. Sin `heading`, lo de siempre
 * (`add-attachment.test.ts`). El reenvío desde un lector, en `test/forward/forward.test.ts`.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToolContext, type ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { runAddAttachment } from '../../src/server/tools/add-attachment';
import { buildTestContext, type TestContext } from '../fixtures/test-context';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_SHA = createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex');
const REF = `![[sha256:${PNG_SHA}|captura.png]]`;

const BODY = [
  '# Decisiones',
  'intro',
  '',
  '## Uno',
  'texto uno',
  '### Uno.a',
  'hijo',
  '',
  '## Dos',
  'texto dos',
  '',
  '## Dos',
  'otro dos',
  ''
].join('\n');

let counter = 0;
function opId(): string {
  counter += 1;
  return `op-att-heading-${process.pid}-${counter}`;
}

describe('hebra_add_attachment con heading (D11)', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  async function create(body = BODY): Promise<{ id: string; ctx: ToolContext }> {
    test = test ?? (await buildTestContext());
    const created = await test.ctx.write!.createNote({
      body,
      folderId: null,
      privacy: test.serverContext.privacyConfig
    });
    return { id: created.id, ctx: await resolveToolContext(test.serverContext) };
  }

  async function bodyOf(id: string): Promise<string> {
    return (await test!.ctx.port.noteRead(id))!.body;
  }

  async function rejection(promise: Promise<unknown>): Promise<ToolError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }

  const base = (id: string) => ({ id, name: 'captura.png', dataBase64: PNG_BASE64 });

  it('la referencia queda al final del apartado, subapartados incluidos, y la salida dice dónde', async () => {
    const { id, ctx } = await create();
    const result = await runAddAttachment(ctx, {
      ...base(id),
      heading: 'uno',
      operationId: opId()
    });
    const stored = await bodyOf(id);
    // Detrás de `hijo` (último contenido de `Uno`, que incluye `Uno.a`), antes de `## Dos`.
    expect(stored).toBe(BODY.replace('hijo\n\n## Dos', `hijo\n\n${REF}\n\n## Dos`));
    expect(result).toMatchObject({
      id,
      outcome: 'saved',
      attachmentId: PNG_SHA,
      markdown: REF,
      placed: { line: 9, heading: 'Uno' }
    });
    expect(stored.split('\n')[8]).toBe(REF);
  });

  it('un subapartado: la referencia va a su final, no al del padre', async () => {
    const { id, ctx } = await create();
    await runAddAttachment(ctx, { ...base(id), heading: 'Uno.a', operationId: opId() });
    // `Uno.a` es el último subapartado de `Uno`: el resultado coincide, pero el título lo dice.
    const result = await runAddAttachment(ctx, {
      ...base(id),
      name: 'otra.png',
      heading: 'Uno.a',
      operationId: opId()
    });
    expect(result.placed?.heading).toBe('Uno.a');
  });

  it('título repetido: ambiguous_heading con candidatos y sin escribir; headingOccurrence elige', async () => {
    const { id, ctx } = await create();
    const ambiguous = await rejection(
      runAddAttachment(ctx, { ...base(id), heading: 'Dos', operationId: opId() })
    );
    expect(ambiguous.code).toBe('ambiguous_heading');
    expect(JSON.stringify(ambiguous.extra)).toContain('"occurrence":2');
    expect(await bodyOf(id)).toBe(BODY);

    const result = await runAddAttachment(ctx, {
      ...base(id),
      heading: 'Dos',
      headingOccurrence: 2,
      operationId: opId()
    });
    expect(result.placed).toEqual({ line: 15, heading: 'Dos' });
    expect(await bodyOf(id)).toBe(`# Decisiones${BODY.slice('# Decisiones'.length)}`.replace(/\n$/, `\n\n${REF}\n`));
  });

  it('heading_not_found, headingOccurrence sin heading y heading desmedido', async () => {
    const { id, ctx } = await create();
    expect(
      (await rejection(runAddAttachment(ctx, { ...base(id), heading: 'Nada', operationId: opId() })))
        .code
    ).toBe('heading_not_found');
    expect(
      (
        await rejection(
          runAddAttachment(ctx, { ...base(id), heading: 'Dos', headingOccurrence: 3, operationId: opId() })
        )
      ).code
    ).toBe('heading_not_found');
    expect(
      (await rejection(runAddAttachment(ctx, { ...base(id), headingOccurrence: 1, operationId: opId() })))
        .code
    ).toBe('invalid_input');
    expect(
      (
        await rejection(
          runAddAttachment(ctx, { ...base(id), heading: 'x'.repeat(2_000), operationId: opId() })
        )
      ).code
    ).toBe('invalid_input');
    expect(await bodyOf(id)).toBe(BODY);
    // Sin blob huérfano: ninguna de las cuatro llegó a guardar nada (almacén de blobs).
    expect(await test!.ctx.port.blobRead(PNG_SHA)).toBeNull();
  });

  it('nota bloqueada: note_locked, también con heading', async () => {
    const { id, ctx } = await create();
    const locked = 'hebra-locked:v1:no-es-un-envoltorio-valido';
    const db = new DatabaseSync(test!.sqlitePath);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(locked, id);
    db.close();
    expect(
      (await rejection(runAddAttachment(ctx, { ...base(id), heading: 'Uno', operationId: opId() })))
        .code
    ).toBe('note_locked');
    expect(await bodyOf(id)).toBe(locked);
  });

  it('mismo operationId: replayed sin duplicar; con otro heading u occurrence, operation_id_reused', async () => {
    const { id, ctx } = await create();
    const input = { ...base(id), heading: 'Uno', operationId: opId() };
    const first = await runAddAttachment(ctx, input);
    const after = await bodyOf(id);
    const again = await runAddAttachment(ctx, input);
    expect(again).toMatchObject({ outcome: 'saved', replayed: true, attachmentId: PNG_SHA });
    expect(again).toMatchObject({ revision: expect.any(String) });
    expect(first).toMatchObject({ revision: expect.any(String) });
    expect(await bodyOf(id)).toBe(after);
    expect(after.split(REF)).toHaveLength(2);

    expect((await rejection(runAddAttachment(ctx, { ...input, heading: 'Dos', headingOccurrence: 1 }))).code).toBe(
      'operation_id_reused'
    );
    expect((await rejection(runAddAttachment(ctx, { ...input, heading: 'Uno.a' }))).code).toBe(
      'operation_id_reused'
    );
    // La huella compara el heading tal cual: otras mayúsculas son otra petición (B7).
    expect((await rejection(runAddAttachment(ctx, { ...input, heading: 'uno' }))).code).toBe(
      'operation_id_reused'
    );
    // Sin heading también es otra petición.
    const { heading: _heading, ...withoutHeading } = input;
    expect((await rejection(runAddAttachment(ctx, withoutHeading))).code).toBe('operation_id_reused');
    expect(await bodyOf(id)).toBe(after);
  });

  it('apartado que acaba dentro de un bloque de código sin cerrar: lo cierra y la referencia cuenta', async () => {
    const { id, ctx } = await create('# A\n\ntexto\n\n```js\ncodigo');
    const result = await runAddAttachment(ctx, { ...base(id), heading: 'A', operationId: opId() });
    expect(result.attachmentId).toBe(PNG_SHA);
    expect(await bodyOf(id)).toBe(`# A\n\ntexto\n\n\`\`\`js\ncodigo\n\`\`\`\n\n${REF}`);
  });

  it('M1: con apartados detrás, un bloque sin cerrar no se cierra a mitad de la nota: invalid_input sin escribir', async () => {
    const text = '# A\n```\ncode\n\t```\n# B\nb';
    const { id, ctx } = await create(text);
    expect(
      (await rejection(runAddAttachment(ctx, { ...base(id), heading: 'A', operationId: opId() }))).code
    ).toBe('invalid_input');
    expect(await bodyOf(id)).toBe(text);
    expect(await test!.ctx.port.blobRead(PNG_SHA)).toBeNull();
  });

  it('B2: una referencia previa al mismo blob no hace que cuente la nueva dentro de un bloque de código', async () => {
    const { id, ctx } = await create(`# A\n${REF}\n# B\n\`\`\`\ncode`);
    const result = await runAddAttachment(ctx, { ...base(id), heading: 'B', operationId: opId() });
    // La nueva queda fuera del código (el bloque se cierra antes), nunca dentro.
    expect(await bodyOf(id)).toBe(`# A\n${REF}\n# B\n\`\`\`\ncode\n\`\`\`\n\n${REF}`);
    expect(result.placed).toEqual({ line: 8, heading: 'B' });
  });

  it('sin heading: igual que siempre, sin placed', async () => {
    const { id, ctx } = await create();
    const result = await runAddAttachment(ctx, { ...base(id), operationId: opId() });
    expect(await bodyOf(id)).toBe(`${BODY}\n\n${REF}`);
    expect(result).not.toHaveProperty('placed');
    expect(result).toEqual({
      id,
      outcome: 'saved',
      revision: expect.any(String),
      sync: 'not_linked',
      attachmentId: PNG_SHA,
      markdown: REF
    });
  });
});
