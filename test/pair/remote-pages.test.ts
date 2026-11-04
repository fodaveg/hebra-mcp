import { describe, expect, it, vi } from 'vitest';
import { sendBridgePage, sendContinuePage, sendNoticePage, sendPreviewPage, sendWrongLumbreAccountPage } from '../../src/pair/remote/pages';

describe('páginas del emparejado remoto', () => {
  it('puentea solo el fragmento con CSP nonce y sin recursos externos', () => {
    const response = fakeResponse();
    sendBridgePage(response.res, 'csrf-secret');
    expect(response.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(response.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(response.body).toContain("location.hash.slice(1)");
    expect(response.body).toContain("history.replaceState(null,'','/lumbre/connect')");
    expect(response.body).not.toMatch(/https?:\/\//);
  });

  it('la página puente solo envía un código con la forma de Lumbre', () => {
    const response = fakeResponse();
    sendBridgePage(response.res, 'csrf-secret');
    const pattern = /\.test\(v\[0\]\)/.test(response.body) ? /\/\^\[a-f0-9\]\{64\}\$\//.exec(response.body) : null;
    expect(pattern).not.toBeNull();
    expect(/^[a-f0-9]{64}$/.test('basura')).toBe(false);
    expect(/^[a-f0-9]{64}$/.test('ab'.repeat(32))).toBe(true);
  });

  it('el aviso previo escapa el email, nombra lo que hace falta y solo enlaza a https', () => {
    const response = fakeResponse();
    sendNoticePage(response.res, { email: '<b>@x', renewal: true, formToken: 'csrf',
      authorizationUrl: 'https://app.lumbre.pro/integrations/hebra?deviceId=1' });
    expect(response.body).toContain('&lt;b&gt;@x');
    expect(response.body).toContain('Renueva la conexión');
    expect(response.body).toContain('Hebra instalada');
    expect(() => sendNoticePage(fakeResponse().res, { email: null, renewal: false, formToken: 'c',
      authorizationUrl: 'javascript:alert(1)' })).toThrow('invalid_lumbre_url');
  });

  it('con otra bóveda, la confirmación dice lo que va a pasar con la anterior', () => {
    const response = fakeResponse();
    sendPreviewPage(response.res, 'csrf', { titles: [], vaultCreatedAt: '2026-01-01T00:00:00.000Z', recordsRead: 0,
      more: false, replacesLibrary: true });
    expect(response.body).toContain('distinta de la que tenías conectada');
    expect(response.body).toContain('se borra su copia de este servidor');
  });

  it('nombra al conector y el host del callback, escapados, en el aviso y en la confirmación', () => {
    const client = { name: '<script>x</script> Claude', callbackHost: 'evil.example:8443' };
    const notice = fakeResponse();
    sendNoticePage(notice.res, { client, email: null, renewal: false, formToken: 'csrf',
      authorizationUrl: 'https://app.lumbre.pro/integrations/hebra' });
    const preview = fakeResponse();
    sendPreviewPage(preview.res, 'csrf', { titles: [], vaultCreatedAt: '2026-01-01T00:00:00.000Z', recordsRead: 0,
      more: false, client });
    for (const page of [notice, preview]) {
      expect(page.body).toContain('&lt;script&gt;x&lt;/script&gt; Claude');
      expect(page.body).not.toContain('<script>x');
      expect(page.body).toContain('evil.example:8443');
    }
  });

  it('con escrituras sin subir en la copia anterior, dice cuántas y pide una casilla aparte', () => {
    const base = { titles: [], vaultCreatedAt: '2026-01-01T00:00:00.000Z', recordsRead: 0, more: false, replacesLibrary: true };
    const some = fakeResponse();
    sendPreviewPage(some.res, 'csrf', { ...base, pendingWrites: 3 });
    expect(some.body).toContain('3 escrituras que todavía no se han subido');
    expect(some.body).toContain('name="accept_loss"');
    const unknown = fakeResponse();
    sendPreviewPage(unknown.res, 'csrf', { ...base, pendingWrites: null });
    expect(unknown.body).toContain('No se ha podido comprobar');
    expect(unknown.body).toContain('name="accept_loss"');
    const none = fakeResponse();
    sendPreviewPage(none.res, 'csrf', { ...base, pendingWrites: 0 });
    expect(none.body).not.toContain('accept_loss');
    const again = fakeResponse();
    sendPreviewPage(again.res, 'csrf', { ...base, pendingWrites: 3 }, { unconfirmedLoss: true });
    expect(again.body).toContain('Marca la casilla');
  });

  it('otra cuenta en Lumbre: nombra la que se va a conectar y no pide aprobar nada', () => {
    const response = fakeResponse();
    sendWrongLumbreAccountPage(response.res, { email: 'david@example.test', renewal: false, formToken: 'csrf',
      authorizationUrl: 'https://app.lumbre.pro/integrations/hebra' });
    expect(response.body).toContain('david@example.test');
    expect(response.body).toContain('ni hace falta aprobar nada');
    const gone = fakeResponse();
    sendWrongLumbreAccountPage(gone.res, null);
    expect(gone.body).toContain('vuelve a conectar desde tu aplicación');
  });

  it('escapa títulos, limita la UI al preview recibido y ofrece cancelar', () => {
    const response = fakeResponse();
    sendPreviewPage(response.res, 'csrf', {
      titles: ['<img src=x onerror=alert(1)>', '', 'Título largo '.repeat(30)],
      vaultCreatedAt: '2026-01-01T00:00:00.000Z',
      recordsRead: 3,
      more: false
    });
    expect(response.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(response.body).not.toContain('<img src=x');
    expect(response.body).toContain('Sin título');
    expect(response.body).toContain('/lumbre/pairing/cancel');
    expect(response.body).toContain('min-height:44px');
  });

  it('rompe el redirect del POST con un clic explícito y rechaza esquemas activos', () => {
    const response = fakeResponse();
    sendContinuePage(response.res, 'Continúa', 'Vuelve a la aplicación',
      'https://client.example/callback?code=abc&state=def', 'Continuar');
    expect(response.body).toContain('href="https://client.example/callback?code=abc&amp;state=def"');
    expect(response.body).not.toContain('http-equiv="refresh"');
    expect(response.headers['content-security-policy']).not.toContain('form-action');
    expect(() => sendContinuePage(fakeResponse().res, 'No', 'No',
      'javascript:alert(1)', 'No')).toThrow('invalid_oauth_continuation');
  });
});

function fakeResponse() {
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value; }),
    type: vi.fn().mockReturnThis(),
    send: vi.fn((value: string) => { body = value; return res; })
  };
  return { res: res as never, headers, get body() { return body; } };
}
