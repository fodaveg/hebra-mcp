/**
 * La página de autorización (SPEC.md §12.2): pide el secreto del dueño. HTML mínimo, sin
 * recursos externos ni JavaScript; el único estilo va en línea con un `nonce` de la CSP.
 *
 * Cabeceras: CSP cerrada (`default-src 'none'`, el formulario solo puede enviarse aquí y
 * su redirección solo ir a claude.ai, `frame-ancestors 'none'` contra el clickjacking),
 * `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `no-store`. El texto de la
 * página es fijo: no cita nada que venga de la petición salvo el id opaco de la solicitud
 * pendiente, que se escapa igual.
 */
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { CLAUDE_CALLBACK } from './clients';

export type ConsentNotice = 'wrong_secret' | 'expired' | 'locked' | 'not_configured' | null;

const NOTICES: Record<Exclude<ConsentNotice, null>, string> = {
  wrong_secret: 'El secreto no es correcto.',
  expired: 'Esta solicitud ha caducado o ya se usó. Vuelve a conectar desde Claude.',
  locked: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a conectar desde Claude.',
  not_configured: 'Este servidor no tiene secreto del dueño configurado.'
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sendConsentPage(
  res: Response,
  status: number,
  options: { requestId: string | null; notice: ConsentNotice }
): void {
  const nonce = randomBytes(16).toString('base64');
  const callbackOrigin = new URL(CLAUDE_CALLBACK).origin;
  res.status(status);
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `form-action 'self' ${callbackOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'"
    ].join('; ')
  );
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.type('html');

  const notice = options.notice ? `<p class="aviso" role="alert">${escapeHtml(NOTICES[options.notice])}</p>` : '';
  const form =
    options.requestId === null
      ? ''
      : `<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${escapeHtml(options.requestId)}">
<label for="secret">Secreto del dueño</label>
<input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Autorizar</button>
</form>`;

  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Hebra · autorizar a Claude</title>
<style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}
label{display:block;margin:1.5rem 0 .25rem}
input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}
button{margin-top:1rem;padding:.5rem 1rem;font:inherit}
.aviso{color:#a00}
</style>
</head>
<body>
<h1>Conectar Claude con tu biblioteca de Hebra</h1>
<p>Claude (claude.ai) pide leer tu biblioteca y crear o ampliar notas. Solo tú tienes el secreto.</p>
${notice}
${form}
</body>
</html>
`);
}
