import { describe, expect, it } from 'vitest';
import { hebraAccountIdOf } from '../../src/pair/remote/account-id';

/**
 * Contrato de docs/80 de Lumbre (lineas 740 y 1520): accountId = sha256hex("hebra-account:" +
 * lowerCase(sub)). Los hashes son literales calculados aparte con
 * `printf '%s' 'hebra-account:sumego|david' | shasum -a 256`, no con la funcion bajo prueba.
 */
describe('hebraAccountIdOf', () => {
  const MINUSCULAS = '28bfd17488c6783852fe686b7e7b71a505b26974119a43377517d86d654d3611';
  const SIN_NORMALIZAR = 'ff4d134274c29cba457283a779f58714eb8dfad80afae187068f0867861658bf';

  it('un sub con mayusculas da el hash del sub en minusculas, no el del sub tal cual', () => {
    expect(hebraAccountIdOf('Sumego|David')).toBe(MINUSCULAS);
    expect(hebraAccountIdOf('Sumego|David')).not.toBe(SIN_NORMALIZAR);
  });

  it('un sub ya en minusculas da el mismo hash literal', () => {
    expect(hebraAccountIdOf('sumego|david')).toBe(MINUSCULAS);
  });
});
