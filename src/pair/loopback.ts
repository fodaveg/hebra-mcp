/**
 * Listener loopback del emparejado con Lumbre (SPEC.md §7.1, contrato L2a de Lumbre,
 * RFC 8252 §7.3). Lumbre devuelve el código de emparejado con una NAVEGACIÓN del
 * navegador a `http://127.0.0.1:<puerto>/lumbre/connect?code=<64 hex>&apiOrigin=…`.
 *
 * Obligaciones de la auditoría de Lumbre que cumple este fichero (cada una con su test en
 * `test/pair/loopback.test.ts`):
 * - (1) El `apiOrigin` de la query se IGNORA: ni se lee. Mientras el listener escucha,
 *   cualquier web puede disparar esta URL con un `apiOrigin` falso para que el canje (y el
 *   verifier) vaya a otro sitio; el canje usa siempre el Lumbre configurado (`./pair.ts`).
 * - (2) Solo vale un `code` que case con `^[a-f0-9]{64}$` (uno solo en la query). Uno
 *   que no case responde 400 y el listener SIGUE escuchando: una petición basura de otra
 *   web no puede cerrar el flujo de David.
 * - (3) Una sola respuesta válida, con `Referrer-Policy: no-referrer` y una página sin
 *   recursos externos (`Content-Security-Policy: default-src 'none'`), y después se cierra
 *   el listener y todas sus conexiones.
 * - (5) Escucha en la IP literal `127.0.0.1`, nunca en `localhost` (el nombre puede
 *   resolver a otra interfaz o reescribirse en `/etc/hosts`).
 * Caduca a los 5 minutos (`LOOPBACK_TIMEOUT_MS`): cierra y rechaza con `expired`.
 *
 * El código recibido no se escribe en ningún log: solo sale por la promesa `code`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';
/** La ruta fija de retorno de Lumbre (`HEBRA_LOOPBACK_RETURN_PATH`). */
export const LOOPBACK_RETURN_PATH = '/lumbre/connect';
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;
export const PAIRING_CODE_PATTERN = /^[a-f0-9]{64}$/;

export type LoopbackErrorCode = 'expired' | 'closed';

export class LoopbackError extends Error {
  constructor(readonly code: LoopbackErrorCode) {
    super(code);
    this.name = 'LoopbackError';
  }
}

export interface LoopbackListener {
  readonly port: number;
  /** `http://127.0.0.1:<puerto>`: el `webOrigin` que se manda a Lumbre. */
  readonly webOrigin: string;
  /** El código, cuando llega la primera petición válida. Rechaza con `LoopbackError`. */
  readonly code: Promise<string>;
  /** Cierra sin esperar al código (rechaza `code` con `closed` si seguía pendiente). */
  close(): Promise<void>;
}

/** Cabeceras de TODAS las respuestas, válidas o no. */
const COMMON_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  Connection: 'close'
} as const;

/** La página de la respuesta válida: texto, sin scripts, estilos ni recursos externos. */
const DONE_PAGE =
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>hebra-mcp</title></head>' +
  '<body><p>hebra-mcp ha recibido el código de Lumbre. Ya puedes cerrar esta pestaña y ' +
  'volver a la terminal.</p></body></html>';

function reply(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type });
  res.end(body);
}

/** El `code` de la query si es EXACTAMENTE uno y tiene la forma de Lumbre. */
function codeOf(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
  if (url.pathname !== LOOPBACK_RETURN_PATH) return null;
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || !PAIRING_CODE_PATTERN.test(codes[0])) return null;
  return codes[0];
}

export async function openLoopbackListener(
  options: { timeoutMs?: number } = {}
): Promise<LoopbackListener> {
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: LoopbackError) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Quien abre el listener puede no llegar a esperar `code` (falla antes): sin esto, un
  // `close()` o la caducidad serían un rechazo sin manejar.
  code.catch(() => undefined);

  const server = createServer((req, res) => {
    if (settled) {
      reply(res, 410, 'hebra-mcp ya ha recibido un código.\n', 'text/plain; charset=utf-8');
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      reply(res, 405, 'Método no admitido.\n', 'text/plain; charset=utf-8');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (url.pathname !== LOOPBACK_RETURN_PATH) {
      reply(res, 404, 'No encontrado.\n', 'text/plain; charset=utf-8');
      return;
    }
    const received = codeOf(req);
    if (received === null) {
      reply(res, 400, 'Código de emparejado no válido.\n', 'text/plain; charset=utf-8');
      return;
    }
    settled = true;
    res.once('finish', () => {
      void shutdown().then(() => resolveCode(received));
    });
    reply(res, 200, DONE_PAGE, 'text/html; charset=utf-8');
  });

  let closing: Promise<void> | null = null;
  function shutdown(): Promise<void> {
    if (closing) return closing;
    clearTimeout(timer);
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    void shutdown().then(() => rejectCode(new LoopbackError('expired')));
  }, options.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  timer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    port,
    webOrigin: `http://${LOOPBACK_HOST}:${port}`,
    code,
    async close() {
      if (!settled) {
        settled = true;
        rejectCode(new LoopbackError('closed'));
      }
      await shutdown();
    }
  };
}
