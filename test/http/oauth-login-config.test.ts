/**
 * `HEBRA_MCP_OIDC_ISSUER` en la transición de Sumego (SPEC.md §12.9 y §13.6 de Sumego): vale
 * exactamente uno de los dos issuers, comparado como cadena cruda; vacía o ausente es el
 * defecto, `https://id.lumbre.pro`. Sin E/S.
 */
import { describe, expect, it } from 'vitest';
import { HttpConfigError } from '../../src/http/config';
import { DEFAULT_OIDC_ISSUER, readLoginConfig, SUMEGO_ISSUERS } from '../../src/oauth/login-config';

const CLIENT_SECRET = 'secreto-del-cliente-de-sumego-0123456789';

function env(issuer: string | undefined, provider = 'sumego'): NodeJS.ProcessEnv {
  return { HEBRA_MCP_LOGIN_PROVIDER: provider, HEBRA_MCP_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    ...(issuer === undefined ? {} : { HEBRA_MCP_OIDC_ISSUER: issuer }) };
}

describe('issuer de Sumego', () => {
  it('la lista cerrada son los dos orígenes y el defecto sigue siendo id.lumbre.pro', () => {
    expect(SUMEGO_ISSUERS).toEqual(['https://id.lumbre.pro', 'https://id.sumego.es']);
    expect(DEFAULT_OIDC_ISSUER).toBe('https://id.lumbre.pro');
    expect(readLoginConfig(env(undefined)).oidc!.issuer).toBe('https://id.lumbre.pro');
    expect(readLoginConfig(env('')).oidc!.issuer).toBe('https://id.lumbre.pro');
  });

  for (const issuer of SUMEGO_ISSUERS) {
    it(`acepta ${issuer} tal cual, con sumego y con lumbre más cliente`, () => {
      expect(readLoginConfig(env(issuer)).oidc!.issuer).toBe(issuer);
      expect(readLoginConfig(env(issuer, 'lumbre')).oidc!.issuer).toBe(issuer);
    });
  }

  const rejected = [
    'https://id.example.test',
    'https://id.lumbre.pro/',
    'https://id.sumego.es/',
    'http://id.sumego.es',
    'http://id.lumbre.pro',
    'https://ID.SUMEGO.ES',
    'https://Id.Lumbre.Pro',
    'HTTPS://id.sumego.es',
    'https://id.sumego.es:443',
    'https://id.lumbre.pro:8443',
    'https://id.sumego.es/oidc',
    'https://id.sumego.es?x=1',
    'https://id.sumego.es#x',
    'https://usuario@id.sumego.es',
    'https://id.sumego.es.evil.test',
    'https://x.id.sumego.es',
    'https://id.lumbre.pro.',
    'https://sumego.es',
    ' https://id.sumego.es',
    'https://id.sumego.es ',
    'id.sumego.es',
    'https://id.lumbre.pro,https://id.sumego.es'
  ];
  for (const issuer of rejected) {
    it(`rechaza ${JSON.stringify(issuer)}: HttpConfigError que nombra la variable, no el valor`, () => {
      for (const provider of ['sumego', 'lumbre']) {
        let failure: unknown;
        try { readLoginConfig(env(issuer, provider)); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(HttpConfigError);
        expect((failure as HttpConfigError).variable).toBe('HEBRA_MCP_OIDC_ISSUER');
        expect((failure as Error).message).not.toContain(issuer.trim());
      }
    });
  }

  it('con lumbre y sin cliente el issuer no se usa, como hasta ahora', () => {
    expect(readLoginConfig({ HEBRA_MCP_LOGIN_PROVIDER: 'lumbre', HEBRA_MCP_OIDC_ISSUER: 'https://id.example.test' }))
      .toEqual({ provider: 'lumbre', oidc: null });
  });
});
