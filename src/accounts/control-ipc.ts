import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

const CONTROL_DIR = 'control';
const CONTROL_SOCKET = 'accounts.sock';
const MAX_REQUEST_BYTES = 4_096;
const CONTROL_TIMEOUT_MS = 15_000;
const SAFE_ERRORS = new Set(['account_not_found', 'account_inactive', 'multiuser_not_configured']);

export function accountControlDir(dataDir: string): string { return join(dataDir, CONTROL_DIR); }
function socketPath(dataDir: string): string { return join(accountControlDir(dataDir), CONTROL_SOCKET); }

export interface AccountControlServer { close(): Promise<void> }

/** Socket local 0600; acepta una retirada por conexión y un cuerpo JSON acotado. */
export async function openAccountControlServer(
  dataDir: string,
  removeAccount: (id: string) => Promise<void>
): Promise<AccountControlServer> {
  const directory = accountControlDir(dataDir);
  const path = socketPath(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rm(path, { force: true });
  const jobs = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((socket) => {
    let body = '';
    let handled = false;
    const respond = (value: object): void => { socket.end(`${JSON.stringify(value)}\n`); };
    socket.setEncoding('utf8');
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: string) => {
      if (handled) return;
      if (closing) { handled = true; respond({ ok: false, code: 'unavailable' }); return; }
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) { handled = true; respond({ ok: false, code: 'invalid_request' }); return; }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      try {
        const input = JSON.parse(body.slice(0, newline)) as { op?: unknown; id?: unknown };
        if (input.op !== 'remove-account' || typeof input.id !== 'string' || input.id.length > 128) {
          respond({ ok: false, code: 'invalid_request' }); return;
        }
        const job = removeAccount(input.id);
        jobs.add(job);
        void job.then(() => respond({ ok: true }), (error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          respond({ ok: false, code: SAFE_ERRORS.has(message) ? message : 'remove_failed' });
        }).finally(() => jobs.delete(job));
      } catch { respond({ ok: false, code: 'invalid_request' }); }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  try { await chmod(path, 0o600); }
  catch {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
    throw new Error('control_socket_permissions');
  }
  return { async close() {
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    while (jobs.size > 0) await Promise.allSettled([...jobs]);
    await rm(path, { force: true });
  } };
}

/** `true` si el daemon procesó la orden; `false` permite el fallback offline. */
export async function requestAccountRemoval(dataDir: string, id: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath(dataDir));
    let body = '';
    socket.setEncoding('utf8');
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => { socket.destroy(); reject(new Error('control_timeout')); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'remove-account', id })}\n`));
    socket.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) { socket.destroy(); reject(new Error('control_response_invalid')); return; }
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const result = JSON.parse(body.slice(0, newline)) as { ok?: unknown; code?: unknown };
        if (result.ok === true) resolve(true);
        else reject(new Error(typeof result.code === 'string' ? result.code : 'remove_failed'));
      } catch { reject(new Error('control_response_invalid')); }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}
