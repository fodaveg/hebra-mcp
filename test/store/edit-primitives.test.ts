import { describe, expect, it } from 'vitest';
import { applyEdits, editsWithinLimits, EDITS_MAX_COUNT, EDITS_TOTAL_MAX_LENGTH } from '../../src/store/edits';
import { decodeRevision, encodeRevision } from '../../src/store/revision';

/** Las dos piezas puras de `hebra_edit_note`: sustituciones (`src/store/edits.ts`) y
 *  revisión opaca (`src/store/revision.ts`). */

describe('applyEdits', () => {
  it('sustituye cada find, que aparece una sola vez, sobre el cuerpo leído', () => {
    const result = applyEdits('# Título\n\nuno dos tres', [
      { find: '# Título', replace: '# Nuevo título' },
      { find: 'dos', replace: 'DOS' }
    ]);
    expect(result).toMatchObject({ ok: true, body: '# Nuevo título\n\nuno DOS tres' });
  });

  it('dice dónde quedó cada replace en el cuerpo nuevo, en el orden de edits (D11)', () => {
    const result = applyEdits('# Título\n\nuno dos tres', [
      { find: 'dos', replace: 'DOSDOS' },
      { find: '# Título', replace: '# Nuevo título' }
    ]);
    if (!result.ok) throw new Error('rechazada');
    expect(result.placed.map(({ editIndex, start, end }) => [editIndex, result.body.slice(start, end)])).toEqual([
      [0, 'DOSDOS'],
      [1, '# Nuevo título']
    ]);
  });

  it('busca en el cuerpo LEÍDO: una sustitución no casa con lo que otra insertó', () => {
    const result = applyEdits('a b', [
      { find: 'a', replace: 'b' },
      { find: 'b', replace: 'c' }
    ]);
    expect(result).toMatchObject({ ok: true, body: 'b c' });
  });

  it('find ausente: no_match con el índice de la sustitución', () => {
    expect(applyEdits('uno dos', [{ find: 'uno', replace: '1' }, { find: 'tres', replace: '3' }])).toEqual({
      ok: false,
      code: 'no_match',
      editIndex: 1
    });
  });

  it('find repetido, también solapado consigo mismo: ambiguous_match', () => {
    expect(applyEdits('x x', [{ find: 'x', replace: 'y' }])).toMatchObject({
      ok: false,
      code: 'ambiguous_match',
      editIndex: 0
    });
    expect(applyEdits('aaa', [{ find: 'aa', replace: 'b' }])).toMatchObject({
      ok: false,
      code: 'ambiguous_match'
    });
  });

  it('dos sustituciones sobre el mismo tramo: overlapping_edits', () => {
    expect(
      applyEdits('uno dos tres', [
        { find: 'uno dos', replace: 'x' },
        { find: 'dos tres', replace: 'y' }
      ])
    ).toEqual({ ok: false, code: 'overlapping_edits', editIndex: 1 });
  });

  it('find vacío: nunca casa', () => {
    expect(applyEdits('abc', [{ find: '', replace: 'x' }])).toMatchObject({ ok: false, code: 'no_match' });
  });
});

describe('editsWithinLimits', () => {
  it('entre 1 y el máximo, sin find vacío y con la suma acotada', () => {
    expect(editsWithinLimits([])).toBe(false);
    expect(editsWithinLimits([{ find: 'a', replace: '' }])).toBe(true);
    expect(editsWithinLimits([{ find: '', replace: 'a' }])).toBe(false);
    expect(editsWithinLimits(Array.from({ length: EDITS_MAX_COUNT + 1 }, () => ({ find: 'a', replace: 'b' })))).toBe(
      false
    );
    expect(editsWithinLimits([{ find: 'a', replace: 'x'.repeat(EDITS_TOTAL_MAX_LENGTH - 1) }])).toBe(true);
    expect(editsWithinLimits([{ find: 'a', replace: 'x'.repeat(EDITS_TOTAL_MAX_LENGTH) }])).toBe(false);
  });
});

describe('revisión opaca', () => {
  const revision = {
    libraryId: 'lib-1',
    noteId: 'note-1',
    localSeq: 7,
    bodySha256: 'ab'.repeat(32)
  };

  it('se codifica y se decodifica igual', () => {
    const raw = encodeRevision(revision);
    expect(raw.startsWith('r1.')).toBe(true);
    expect(decodeRevision(raw)).toEqual(revision);
  });

  it('lo que no es una revisión da null, sin lanzar', () => {
    for (const raw of [
      undefined,
      42,
      '',
      'r1.',
      'r2.eyJ4IjoxfQ',
      `r1.${Buffer.from('[1,2,3,4]').toString('base64url')}`,
      `r1.${Buffer.from('no es json').toString('base64url')}`,
      encodeRevision({ ...revision, bodySha256: 'corto' }),
      encodeRevision({ ...revision, localSeq: -1 }),
      `r1.${'A'.repeat(2_000)}`
    ]) {
      expect(decodeRevision(raw)).toBeNull();
    }
  });
});
