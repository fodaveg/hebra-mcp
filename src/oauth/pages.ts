/**
 * Páginas HTML del login con Sumego (SPEC.md §12.9): consentimiento, «acceso denegado», «no
 * disponible» y emparejado revocado. Sin scripts ni recursos externos; todo texto variable va
 * escapado. Cabeceras de todas: `Content-Security-Policy` cerrada, `X-Frame-Options: DENY`,
 * `Cache-Control: no-store` y `Referrer-Policy` (`same-origin` en la de consentimiento, para que
 * el POST lleve su `Origin`; `no-referrer` en el resto).
 *
 * `form-action` de la página de consentimiento suma a `'self'` la `redirect_uri` de esa
 * solicitud (la de Claude o el loopback de Codex, ya validada en `/authorize`): Chrome y Firefox
 * aplican `form-action` también a las redirecciones que siguen al envío del formulario, y con
 * `'self'` solo el 302 final al cliente quedaría bloqueado.
 */
import type { Response } from 'express';
import { PAIRING_REVOKED_REASON } from '../status/pairing-revocation';
import { SUMEGO_CONSENT_PATH } from './sumego';

const BASE_CSP = "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'";
const STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}' +
  'button{font:inherit;padding:.6rem 1.4rem;border-radius:.4rem;border:0;background:#2a5bd7;color:#fff;cursor:pointer}' +
  'dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#666}dd{margin:0}';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/**
 * `no-referrer` en todas salvo la de consentimiento, que lleva `same-origin`: con `no-referrer`
 * el navegador manda el POST del «Permitir» con `Origin: null` y el filtro de Host/Origin de
 * `src/http/app.ts` lo rechaza con 403. `same-origin` no filtra nada fuera de este origen.
 */
type ReferrerPolicy = 'no-referrer' | 'same-origin';

function htmlDocument(title: string, body: string, referrer: ReferrerPolicy = 'no-referrer'): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="${referrer}"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

function send(res: Response, status: number, html: string, csp = BASE_CSP, referrer: ReferrerPolicy = 'no-referrer'): void {
  res.status(status);
  res.setHeader('content-security-policy', csp);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', referrer);
  res.type('html').send(html);
}

/** Origen + ruta de la `redirect_uri`, como fuente CSP; `null` si no se puede expresar. */
function cspSource(redirectUri: string): string | null {
  try {
    const url = new URL(redirectUri);
    const source = `${url.origin}${url.pathname}`;
    return /^[A-Za-z0-9:/._~%-]+$/.test(source) ? source : null;
  } catch { return null; }
}

export interface ConsentPage {
  clientName: string;
  email: string | null;
  scope: string;
  formToken: string;
  redirectUri: string;
}

/** Un solo botón «Permitir»; el token de formulario es de un uso y va ligado a la cookie. */
export function sendConsentPage(res: Response, page: ConsentPage): void {
  const who = page.email ? `<dt>Cuenta</dt><dd>${escapeHtml(page.email)}</dd>` : '';
  const body = `<p><strong>${escapeHtml(page.clientName)}</strong> quiere acceder a tu biblioteca de Hebra.</p>` +
    `<dl><dt>Aplicación</dt><dd>${escapeHtml(page.clientName)}</dd>${who}` +
    `<dt>Alcance</dt><dd>${escapeHtml(page.scope)}, la biblioteca emparejada</dd></dl>` +
    `<form method="post" action="${SUMEGO_CONSENT_PATH}">` +
    `<input type="hidden" name="form_token" value="${escapeHtml(page.formToken)}">` +
    `<p><button type="submit">Permitir</button></p></form>`;
  const target = cspSource(page.redirectUri);
  const csp = target ? BASE_CSP.replace("form-action 'self'", `form-action 'self' ${target}`) : BASE_CSP;
  send(res, 200, htmlDocument('Conectar con Hebra', body, 'same-origin'), csp, 'same-origin');
}

/** El «Permitir» llegó tarde: Lumbre ya no aceptaría el ID token. «No disponible», sin redirigir. */
export function sendConsentExpiredPage(res: Response): void {
  send(res, 503, htmlDocument('No disponible', '<p>La autorización ha caducado antes de pulsar «Permitir». ' +
    'Vuelve a conectar Hebra desde Claude o Codex para empezar de nuevo.</p>'));
}

/** `400`, `403`, `404` o `409` de Lumbre, o un login que no vale: sin redirigir. */
export function sendDeniedPage(res: Response, status = 403): void {
  send(res, status, htmlDocument('Acceso denegado', '<p>No se ha podido autorizar el acceso a la biblioteca. Vuelve a conectar desde la aplicación.</p>'));
}

/** Red, 5xx, 429, `401`, `413`, `503` o una respuesta fuera de contrato: sin redirigir. */
export function sendUnavailablePage(res: Response): void {
  send(res, 503, htmlDocument('No disponible', '<p>El servicio de autorización no está disponible ahora. Inténtalo de nuevo en unos minutos.</p>'));
}

/** Emparejado revocado (SPEC.md §12.9): qué pasó y cómo reemparejar. */
export function sendPairingRevokedPage(res: Response): void {
  send(res, 503, htmlDocument('Conexión con la biblioteca cortada', `<p>${escapeHtml(PAIRING_REVOKED_REASON)}</p>`));
}
