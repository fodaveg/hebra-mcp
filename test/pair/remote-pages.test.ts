import { describe, expect, it, vi } from 'vitest';
import { sendBridgePage, sendContinuePage, sendPreviewPage } from '../../src/pair/remote/pages';

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
