import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type Router
} from 'express';
import {
  sendBridgePage,
  sendContinuePage,
  sendPreviewPage,
  sendRemotePairingMessage,
  sendWaitingPage
} from './pages';
import { REMOTE_PAIRING_ORIGIN, RemotePairingService } from './service';
import {
  RemotePairingError,
  type CommittedAccount,
  type RemotePairingFormAuthorization,
  type RemotePairingSession
} from './types';

export const REMOTE_PAIRING_COOKIE = '__Host-hebra_mcp_pair';

export interface RemotePairingRouterHooks {
  resumeOauth(input: { oauthRequestId: string; account: CommittedAccount }): Promise<string>;
  cancelOauth(input: { oauthRequestId: string }): Promise<void>;
  reauthenticate(input: {
    oauthRequestId: string;
    expectedSub: string;
    pairingSessionId: string;
  }, res: Response): Promise<string | void>;
}

function cookieValue(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const item of header.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name !== REMOTE_PAIRING_COOKIE) continue;
    try { return decodeURIComponent(rest.join('=')); } catch { return null; }
  }
  return null;
}

function bodyString(req: Request, name: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
}

function requireOrigin(req: Request): void {
  if (req.get('origin') !== REMOTE_PAIRING_ORIGIN) throw new RemotePairingError('invalid_form');
}

async function authorizedSession(req: Request, service: RemotePairingService): Promise<{
  session: RemotePairingSession;
  authorization: RemotePairingFormAuthorization;
}> {
  requireOrigin(req);
  const cookie = cookieValue(req);
  if (!cookie) throw new RemotePairingError('invalid_session');
  const session = await service.sessionForCookie(cookie);
  if (!session) throw new RemotePairingError('invalid_session');
  return { session, authorization: { cookie, formToken: bodyString(req, 'form_token') } };
}

function clearCookie(res: Response): void {
  res.clearCookie(REMOTE_PAIRING_COOKIE, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
}

function handleError(res: Response, error: unknown): void {
  if (!(error instanceof RemotePairingError)) {
    sendRemotePairingMessage(res, 503, 'No disponible', 'No se ha podido completar la conexión. Inténtalo de nuevo.');
    return;
  }
  if (error.code === 'expired') {
    sendRemotePairingMessage(res, 410, 'Solicitud caducada', 'Vuelve a iniciar la conexión desde tu aplicación.');
    return;
  }
  if (error.code === 'wrong_account') {
    sendRemotePairingMessage(res, 403, 'Cuenta incorrecta', 'La biblioteca no pertenece a la cuenta que inició esta conexión.');
    return;
  }
  const status = ['invalid_session', 'invalid_form'].includes(error.code) ? 403 :
    error.code === 'not_found' ? 404 : error.code === 'unavailable' ? 503 : 409;
  sendRemotePairingMessage(res, status, 'Conexión rechazada', 'Esta solicitud ya no es válida. Inicia una nueva conexión.');
}

/** Router autocontenido; el servidor principal decide dónde montarlo. */
export function createRemotePairingRouter(
  service: RemotePairingService,
  hooks: RemotePairingRouterHooks
): Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  router.get('/lumbre/connect', async (req, res) => {
    try {
      const cookie = cookieValue(req);
      if (!cookie) throw new RemotePairingError('invalid_session');
      const page = await service.pageForCookie(cookie);
      if (!page) throw new RemotePairingError('invalid_session');
      sendBridgePage(res, page.formToken);
    } catch (error) { handleError(res, error); }
  });

  router.get('/lumbre/pairing/resume', async (req, res) => {
    try {
      const cookie = cookieValue(req);
      if (!cookie) throw new RemotePairingError('invalid_session');
      const page = await service.pageForCookie(cookie);
      if (!page) throw new RemotePairingError('invalid_session');
      sendWaitingPage(res, page.formToken);
    } catch (error) { handleError(res, error); }
  });

  router.post('/lumbre/connect', form, async (req, res) => {
    try {
      const { session, authorization } = await authorizedSession(req, service);
      await service.receiveCredential(session.id, authorization, bodyString(req, 'code'));
      sendWaitingPage(res, await service.formToken(session.id));
    } catch (error) { handleError(res, error); }
  });

  router.post('/lumbre/pairing/poll', form, async (req, res) => {
    try {
      const { session, authorization } = await authorizedSession(req, service);
      const status = await service.poll(session.id, authorization);
      if (status.kind === 'waiting') {
        sendWaitingPage(res, await service.formToken(session.id), status.remainingMs);
      } else if (status.kind === 'preview') {
        sendPreviewPage(res, await service.formToken(session.id), status.preview);
      } else {
        const location = await hooks.reauthenticate({
          oauthRequestId: session.oauthRequestId,
          expectedSub: session.sub,
          pairingSessionId: session.id
        }, res);
        if (location) sendContinuePage(res, 'Vuelve a identificarte',
          'Continúa con la misma cuenta para terminar la conexión.', location,
          'Continuar con Sumego');
        else sendRemotePairingMessage(res, 401, 'Vuelve a identificarte', 'Inicia sesión de nuevo con la misma cuenta para continuar.');
      }
    } catch (error) { handleError(res, error); }
  });

  router.post('/lumbre/pairing/confirm', form, async (req, res) => {
    let session: RemotePairingSession | null = null;
    try {
      const authorized = await authorizedSession(req, service);
      session = authorized.session;
      const result = await service.confirm(session.id, authorized.authorization);
      if (result.kind === 'reauthenticate') {
        const location = await hooks.reauthenticate({ oauthRequestId: session.oauthRequestId,
          expectedSub: session.sub, pairingSessionId: session.id }, res);
        if (location) sendContinuePage(res, 'Vuelve a identificarte',
          'Continúa con la misma cuenta para terminar la conexión.', location,
          'Continuar con Sumego');
        else sendRemotePairingMessage(res, 401, 'Vuelve a identificarte',
          'Inicia sesión de nuevo con la misma cuenta para continuar.');
        return;
      }
      const location = await hooks.resumeOauth({ oauthRequestId: session.oauthRequestId, account: result.account });
      clearCookie(res);
      sendContinuePage(res, 'Biblioteca conectada',
        'La biblioteca está conectada. Continúa para volver a tu aplicación.', location,
        'Continuar');
    } catch (error) {
      if (session) await hooks.cancelOauth({ oauthRequestId: session.oauthRequestId }).catch(() => undefined);
      handleError(res, error);
    }
  });

  router.post('/lumbre/pairing/cancel', form, async (req, res) => {
    try {
      const { session, authorization } = await authorizedSession(req, service);
      try { await service.cancel(session.id, authorization); }
      finally { await hooks.cancelOauth({ oauthRequestId: session.oauthRequestId }); }
      clearCookie(res);
      sendRemotePairingMessage(res, 200, 'Conexión cancelada', 'No se ha conectado ninguna biblioteca.');
    } catch (error) { handleError(res, error); }
  });
  const formError: ErrorRequestHandler = (_error, _req, res, _next) => {
    sendRemotePairingMessage(res, 413, 'Solicitud rechazada', 'La respuesta recibida no tiene un formato válido.');
  };
  router.use(formError);
  return router;
}

export function setRemotePairingCookie(res: Response, cookie: string): void {
  res.cookie(REMOTE_PAIRING_COOKIE, cookie, {
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60_000
  });
}
