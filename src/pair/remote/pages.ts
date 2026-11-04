import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { ClientLabel, PairingPreview } from './types';

const BASE_CSP = "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const KEY_CUSTODY_NOTICE = '<p>Al aprobar esta conexión, autorizas al servidor del conector a guardar la clave de tu biblioteca. Quien administre ese servidor con acceso root podrá leer sus notas.</p>';
const STYLE = `:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--text:#20201e;--muted:#686762;--accent:#315c4c;--danger:#922f35;--line:#dedbd2}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,sans-serif}main{width:min(100% - 2rem,38rem);margin:clamp(1.5rem,8vh,5rem) auto;padding:clamp(1.25rem,4vw,2.25rem);background:var(--card);border:1px solid var(--line);border-radius:1rem;box-shadow:0 .5rem 2rem #00000010}h1{font-size:clamp(1.55rem,5vw,2.2rem);line-height:1.15;margin:.2rem 0 1rem}p{margin:.8rem 0;color:var(--muted)}ul{padding-left:1.4rem;overflow-wrap:anywhere}form{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.4rem}button,.continue{min-height:44px;padding:.65rem 1.1rem;border:0;border-radius:.55rem;background:var(--accent);color:white;font:600 1rem system-ui;cursor:pointer}.continue{display:inline-flex;align-items:center;text-decoration:none}button.secondary{background:transparent;color:var(--danger);border:1px solid currentColor}button:focus-visible,.continue:focus-visible{outline:3px solid #e59a32;outline-offset:3px}.meta{font-size:.9rem}.empty{font-style:italic}@media(prefers-color-scheme:dark){:root{--bg:#181a18;--card:#222522;--text:#f0efe9;--muted:#bbb9b0;--accent:#4e806d;--danger:#ff9ca3;--line:#3b403b}}`;

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
  // Una ventana abierta por otra página no conserva su control sobre esta: no puede volver a
  // navegarla ni enviar por ella un código ajeno. El flujo no usa `window.opener`: Lumbre vuelve
  // aquí con una redirección de la misma ventana.
  res.setHeader('cross-origin-opener-policy', 'same-origin');
}

function hiddenToken(formToken: string): string {
  return `<input type="hidden" name="form_token" value="${escapeRemoteHtml(formToken)}">`;
}

/**
 * La página a la que vuelve Lumbre con el código en el fragmento. Con `requireClick` (la
 * transacción ya tuvo un código rechazado) el código no se envía solo: la persona pulsa un botón.
 * Así una página hostil que renavegue esta ventana con códigos inventados no puede gastar los
 * intentos de la persona sin que ella haga nada.
 */
export function sendBridgePage(res: Response, formToken: string, requireClick = false): void {
  const nonce = randomBytes(18).toString('base64url');
  // Solo se envía un código con la forma que emite Lumbre: lo demás no llega a tocar la transacción.
  const accept = requireClick ? "document.getElementById('go').hidden=false" : 'f.submit()';
  const script = `(function(){var f=document.getElementById('bridge'),p=new URLSearchParams(location.hash.slice(1)),v=p.getAll('code');history.replaceState(null,'','/lumbre/connect');if(v.length!==1||!/^[a-f0-9]{64}$/.test(v[0])){document.getElementById('problem').hidden=false;return}f.elements.code.value=v[0];${accept}}())`;
  const intro = requireClick
    ? '<p>Lumbre ha devuelto un código nuevo. Pulsa el botón para terminar la conexión.</p>'
    : '<p>Terminando la conexión con Lumbre…</p>';
  const body = intro +
    '<p id="problem" hidden>No se ha recibido una autorización válida. <a href="/lumbre/pairing/start">Vuelve a autorizar en Lumbre</a>.</p>' +
    '<form id="bridge" method="post" action="/lumbre/connect">' + hiddenToken(formToken) +
    '<input type="hidden" name="code" value="">' +
    (requireClick ? '<button id="go" type="submit" hidden>Terminar la conexión</button>' : '') + '</form>' +
    `<script nonce="${nonce}">${script}</script>`;
  securityHeaders(res, `${BASE_CSP}; script-src 'nonce-${nonce}'`);
  res.status(200).type('html').send(document('Conectar biblioteca', body));
}

export interface RemotePairingNoticePage {
  client?: ClientLabel;
  email: string | null;
  renewal: boolean;
  authorizationUrl: string;
  formToken: string;
}

/**
 * Quién pidió esta conexión, como en el consentimiento normal (`Aplicación`), más el host al que
 * volverá el acceso: sin esto, un enlace preparado por otro completaría el alta sin que se sepa a qué
 * conector va a parar.
 */
function clientBlock(client: ClientLabel | undefined): string {
  if (!client) return '';
  const host = client.callbackHost
    ? `<dt>Devuelve el acceso a</dt><dd>${escapeRemoteHtml(client.callbackHost)}</dd>` : '';
  return `<p><strong>${escapeRemoteHtml(client.name)}</strong> quiere conectarse a tu biblioteca de Hebra. ` +
    'Si no lo has pedido tú, cancela.</p>' +
    `<dl><dt>Aplicación</dt><dd>${escapeRemoteHtml(client.name)}</dd>${host}</dl>`;
}

function accountLabel(email: string | null): string {
  return email ? `<strong>${escapeRemoteHtml(email)}</strong>` : 'la cuenta con la que acabas de entrar';
}

function lumbreLink(url: string): string {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid_lumbre_url');
  return `<p><a class="continue" href="${escapeRemoteHtml(target.toString())}">Continuar en Lumbre</a></p>`;
}

/**
 * Aviso previo (D22, "Alta sin atascos"): antes de salir hacia Lumbre, qué cuenta se va a conectar
 * y qué hace falta, para no descubrirlo cuando el dueño ya tiene la aprobación delante.
 */
export function sendNoticePage(res: Response, page: RemotePairingNoticePage): void {
  const intro = page.renewal
    ? `<p>La conexión de ${accountLabel(page.email)} con su biblioteca se cortó. Al renovarla conservas tus notas y no hay que volver a descargar nada.</p>`
    : `<p>Vas a conectar la biblioteca de ${accountLabel(page.email)}.</p>`;
  const body = clientBlock(page.client) + intro +
    '<p>Antes de empezar, comprueba que tienes:</p><ul>' +
    '<li>Hebra instalada con esta misma cuenta.</li>' +
    '<li>El código de recuperación exportado en el dispositivo con el que vas a aprobar (Hebra &gt; Ajustes &gt; Sincronización).</li>' +
    '<li>Abierta en Lumbre la sesión de esta misma cuenta, no la de otra.</li></ul>' +
    KEY_CUSTODY_NOTICE + lumbreLink(page.authorizationUrl) +
    `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(page.formToken)}<button class="secondary" type="submit">Cancelar</button></form>`;
  securityHeaders(res);
  res.status(200).type('html').send(document(page.renewal ? 'Renueva la conexión' : 'Conecta tu biblioteca', body));
}

/** La sesión de Lumbre de este navegador es de otra cuenta, y aún nadie ha aprobado nada. */
export function sendWrongLumbreAccountPage(res: Response, page: RemotePairingNoticePage | null): void {
  const retry = page
    ? `<p>Cierra esa sesión en Lumbre, entra con ${accountLabel(page.email)} y continúa.</p>${lumbreLink(page.authorizationUrl)}` +
      `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(page.formToken)}<button class="secondary" type="submit">Cancelar</button></form>`
    : '<p>Cierra esa sesión en Lumbre, entra con tu cuenta y vuelve a conectar desde tu aplicación.</p>';
  securityHeaders(res);
  res.status(409).type('html').send(document('Lumbre tiene abierta otra cuenta',
    `<p>La sesión de Lumbre de este navegador es de otra cuenta. No se ha conectado nada ni hace falta aprobar nada en Hebra.</p>${retry}`));
}

/** Lumbre no reconoce el código recibido: no ha pasado nada y se puede volver a autorizar. */
export function sendCodeRejectedPage(res: Response, page: RemotePairingNoticePage | null): void {
  const retry = page
    ? `${lumbreLink(page.authorizationUrl)}<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(page.formToken)}<button class="secondary" type="submit">Cancelar</button></form>`
    : '<p>Vuelve a conectar desde tu aplicación.</p>';
  securityHeaders(res);
  res.status(400).type('html').send(document('Autorización no válida',
    `<p>Lumbre no reconoce la autorización recibida: puede haber caducado o venir de otro enlace. No se ha conectado nada.</p>${retry}`));
}

/**
 * Lumbre está atendiendo demasiadas solicitudes y no ha mirado el código: no ha pasado nada y se
 * puede reintentar pasado el tiempo que indica. La transacción sigue viva.
 */
export function sendRateLimitedPage(res: Response, page: RemotePairingNoticePage | null, retryAfterSeconds: number): void {
  const seconds = Math.max(1, Math.min(3600, Math.ceil(retryAfterSeconds)));
  const retry = page
    ? `<p>Pasado ese tiempo, continúa en Lumbre.</p>${lumbreLink(page.authorizationUrl)}<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(page.formToken)}<button class="secondary" type="submit">Cancelar</button></form>`
    : '<p>Pasado ese tiempo, vuelve a conectar desde tu aplicación.</p>';
  securityHeaders(res);
  res.setHeader('retry-after', String(seconds));
  res.status(429).type('html').send(document('Inténtalo en un momento',
    `<p>Lumbre está atendiendo muchas solicitudes y no ha podido comprobar la autorización. No se ha conectado nada. Espera unos ${seconds} segundos y vuelve a intentarlo.</p>${retry}`));
}

/** La transacción terminó por demasiadas autorizaciones rechazadas seguidas. */
export function sendTooManyCodesPage(res: Response): void {
  securityHeaders(res, BASE_CSP.replace("form-action 'self'; ", ''));
  res.status(429).type('html').send(document('Demasiados intentos',
    '<p>Lumbre ha rechazado varias autorizaciones seguidas, así que esta conexión se ha cerrado. No se ha conectado nada ni se ha borrado nada.</p>' +
    '<p>Espera un rato y vuelve a conectar desde tu aplicación.</p>'));
}

/**
 * Lumbre rechazó (401) el registro de la clave de agente. Con la credencial revocada y con el
 * agente desactivado en Hebra responde igual, así que la página dice solo lo que se sabe.
 * No se ha borrado nada. `tokensKept`: la renovación guardó los tokens nuevos de la credencial
 * que sobrevive, así que al activar el agente no hace falta reconectar.
 */
export function sendAgentRejectedPage(res: Response, tokensKept: boolean): void {
  securityHeaders(res, BASE_CSP.replace("form-action 'self'; ", ''));
  res.status(409).type('html').send(document('Lumbre rechaza esta conexión',
    '<p>Lumbre ha rechazado esta conexión. Comprueba en Hebra que el agente está activado.</p>' +
    (tokensKept
      ? '<p>Si lo activas, no hace falta que vuelvas a conectar: tu biblioteca volverá a funcionar sola. No se ha borrado nada.</p>'
      : '<p>Si lo activas, vuelve a conectar Hebra desde tu aplicación. No se ha borrado nada.</p>')));
}

export function sendWaitingPage(res: Response, formToken: string, remainingMs?: number): void {
  const remaining = remainingMs === undefined ? '' :
    `<p class="meta">La solicitud caduca en unos ${Math.max(1, Math.ceil(remainingMs / 60_000))} min.</p>`;
  const body = '<p>Abre Hebra en tu dispositivo y aprueba esta solicitud en Ajustes > Sincronización.</p>' +
    '<p>Después vuelve aquí para comprobar la biblioteca antes de conectarla.</p>' + KEY_CUSTODY_NOTICE + remaining +
    `<form method="post" action="/lumbre/pairing/poll">${hiddenToken(formToken)}<button type="submit">Ya la he aprobado</button></form>` +
    `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(formToken)}<button class="secondary" type="submit">Cancelar</button></form>`;
  securityHeaders(res);
  res.status(200).type('html').send(document('Aprueba en Hebra', body));
}

/** Lo que se pierde al retirar la copia anterior, y la casilla aparte que lo acepta. */
function lossBlock(preview: PairingPreview, unconfirmed: boolean): string {
  if (!preview.replacesLibrary || preview.pendingWrites === 0) return '';
  const what = typeof preview.pendingWrites === 'number'
    ? `En la copia anterior hay ${preview.pendingWrites} ${preview.pendingWrites === 1 ? 'escritura' : 'escrituras'} que todavía no se ${preview.pendingWrites === 1 ? 'ha subido' : 'han subido'} a tu biblioteca. Si continúas, se perderán.`
    : 'No se ha podido comprobar si la copia anterior tiene escrituras sin subir. Si las tiene, se perderán.';
  const reminder = unconfirmed ? '<p><strong>Marca la casilla para continuar.</strong></p>' : '';
  return `<p><strong>${what}</strong></p>${reminder}` +
    '<p><label><input type="checkbox" name="accept_loss" value="1" form="confirm"> ' +
    'Entiendo que se pueden perder esas escrituras</label></p>';
}

export function sendPreviewPage(
  res: Response,
  formToken: string,
  preview: PairingPreview,
  options: { unconfirmedLoss?: boolean } = {}
): void {
  const titles = preview.titles.length === 0
    ? '<p class="empty">La biblioteca no contiene títulos que mostrar.</p>'
    : `<ul>${preview.titles.slice(0, 3).map((title) => `<li>${escapeRemoteHtml(title || 'Sin título')}</li>`).join('')}</ul>`;
  const records = preview.more ? `más de ${preview.recordsRead}` : String(preview.recordsRead);
  const replaces = preview.replacesLibrary
    ? '<p><strong>Esta biblioteca es distinta de la que tenías conectada.</strong> Al confirmar se retira la conexión anterior y se borra su copia de este servidor. Las notas que tengas en Hebra no se tocan.</p>' +
      lossBlock(preview, options.unconfirmedLoss === true)
    : '';
  const body = clientBlock(preview.client) + replaces + '<p>Comprueba que estas notas pertenecen a la biblioteca que quieres conectar:</p>' + titles +
    `<p class="meta">Biblioteca creada el ${escapeRemoteHtml(preview.vaultCreatedAt)}; ${records} registros leídos.</p>` + KEY_CUSTODY_NOTICE +
    `<form id="confirm" method="post" action="/lumbre/pairing/confirm">${hiddenToken(formToken)}<button type="submit">Sí, conectar esta biblioteca</button></form>` +
    `<form method="post" action="/lumbre/pairing/cancel">${hiddenToken(formToken)}<button class="secondary" type="submit">No, cancelar</button></form>`;
  securityHeaders(res);
  res.status(options.unconfirmedLoss ? 409 : 200).type('html').send(document('Confirma tu biblioteca', body));
}

/** Rompe la cadena de redirect del POST: `form-action` no bloquea el clic posterior. */
export function sendContinuePage(
  res: Response,
  title: string,
  message: string,
  location: string,
  label: string
): void {
  let href: string;
  try {
    if (location.startsWith('/') && !location.startsWith('//')) href = location;
    else {
      const url = new URL(location);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      href = url.toString();
    }
  } catch { throw new Error('invalid_oauth_continuation'); }
  const body = `<p>${escapeRemoteHtml(message)}</p>` +
    `<p><a class="continue" href="${escapeRemoteHtml(href)}">${escapeRemoteHtml(label)}</a></p>`;
  securityHeaders(res, BASE_CSP.replace("form-action 'self'; ", ''));
  res.status(200).type('html').send(document(title, body));
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
