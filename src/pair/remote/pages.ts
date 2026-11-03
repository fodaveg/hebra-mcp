import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { PairingPreview } from './types';

const BASE_CSP = "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const STYLE = `:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--text:#20201e;--muted:#686762;--accent:#315c4c;--danger:#922f35;--line:#dedbd2}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,sans-serif}main{width:min(100% - 2rem,38rem);margin:clamp(1.5rem,8vh,5rem) auto;padding:clamp(1.25rem,4vw,2.25rem);background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:0 .5rem 2rem #00000010}h1{font-size:clamp(1.55rem,5vw,2.2rem);line-height:1.15;margin:.2rem 0 1rem}p{margin:.8rem 0;color:var(--muted)}ul{padding-left:1.4rem;overflow-wrap:anywhere}form{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.4rem}button{min-height:44px;padding:.65rem 1.1rem;border:0;border-radius:.55rem;background:var(--accent);color:white;font:600 1rem system-ui;cursor:pointer}button.secondary{background:transparent;color:var(--danger);border:1px solid currentColor}button:focus-visible{outline:3px solid #e59a32;outline-offset:3px}.meta{font-size:.9rem}.empty{font-style:italic}@media(prefers-color-scheme:dark){:root{--bg:#181a18;--card:#222522;--text:#f0efe9;--muted:#bbb9b0;--accent:#4e806d;--danger:#ff9ca3;--line:#3b403b}}`;

export function escapeRemoteHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]!);
}

function document(title: string, body: string): string {
  return '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="referrer" content="same-origin"><title>${escapeRemoteHtml(title)}</title>` +
    `<style>${STYLE}</style></head><body><main><h1>${escapeRemoteHtml(title)}</h1>${body}</main></body></html>`;
}

function securityHeaders(res: Response, csp = BASE_CSP): void {
  res.setHeader('content-security-policy', csp);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
}

function hiddenToken(formToken: string): string {
  return `<input type="hidden" name="form_token" value="${escapeRemoteHtml(formToken)}">`;
}

export function sendBridgePage(res: Response, formToken: string): void {
  const nonce = randomBytes(18).toString('base64url');
  const script = `(function(){var f=document.getElementById('bridge'),p=new URLSearchParams(location.hash.slice(1)),v=p.getAll('code');history.replaceState(null,'','/lumbre/connect');if(v.length!==1||!v[0]){document.getElementById('problem').hidden=false;return}f.elements.code.value=v[0];f.submit()}())`;
  const body = '<p>Terminando la conexión con Lumbre…</p>' +
    '<p id="problem" hidden>No se ha recibido una autorización válida. Vuelve a iniciar la conexión.</p>' +
    '<form id="bridge" method="post" action="/lumbre/connect">' + hiddenToken(formToken) +
    '<input type="hidden" name="code" value=""></form>' +
    `<script nonce="${nonce}">${script}</script>`;
  securityHeaders(res, `${BASE_CSP}; script-src 'nonce-${nonce}'`);
  res.status(200).type('html').send(document('Conectar biblioteca', body));
}

export function sendWaitingPage(res: Response, formToken: string, remainingMs?: number): void {
  const remaining = remainingMs === undefined ? '' :
    `<p class="meta">La solicitud caduca en unos ${Math.max(1, Math.ceil(remainingMs / 60_000))} min.</p>`;
  const body = '<p>Abre Hebra en tu dispositivo y aprueba esta solicitud en Ajustes > Sincronización.</p>' +
    '<p>Después vuelve aquí para comprobar la biblioteca antes de conectarla.</p>' + remaining +
    `<form method="post" action="/lumbre/pairing/poll">${hiddenToken(formToken)}<button type="submit">Ya la he aprobado</button></form>` +
    `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(formToken)}<button class="secondary" type="submit">Cancelar</button></form>`;
  securityHeaders(res);
  res.status(200).type('html').send(document('Aprueba en Hebra', body));
}

export function sendPreviewPage(res: Response, formToken: string, preview: PairingPreview): void {
  const titles = preview.titles.length === 0
    ? '<p class="empty">La biblioteca no contiene títulos que mostrar.</p>'
    : `<ul>${preview.titles.slice(0, 3).map((title) => `<li>${escapeRemoteHtml(title || 'Sin título')}</li>`).join('')}</ul>`;
  const records = preview.more ? `más de ${preview.recordsRead}` : String(preview.recordsRead);
  const body = '<p>Comprueba que estas notas pertenecen a la biblioteca que quieres conectar:</p>' + titles +
    `<p class="meta">Biblioteca creada el ${escapeRemoteHtml(preview.vaultCreatedAt)}; ${records} registros leídos.</p>` +
    `<form method="post" action="/lumbre/pairing/confirm">${hiddenToken(formToken)}<button type="submit">Sí, conectar esta biblioteca</button></form>` +
    `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(formToken)}<button class="secondary" type="submit">No, cancelar</button></form>`;
  securityHeaders(res);
  res.status(200).type('html').send(document('Confirma tu biblioteca', body));
}

export function sendRemotePairingMessage(
  res: Response,
  status: number,
  title: string,
  message: string
): void {
  securityHeaders(res, BASE_CSP.replace("form-action 'self'; ", ''));
  res.status(status).type('html').send(document(title, `<p>${escapeRemoteHtml(message)}</p>`));
}
