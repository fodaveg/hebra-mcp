import { deferred } from '../fixtures/deferred';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountControlDir, requestAccountRemoval } from '../../src/accounts/control-ipc';

// Real EOF, with no timeout race: once both peers have closed, the promise must settle.
async function responseAtEof(response: string): Promise<unknown> {
  const dataDir = await mkdtemp(join(tmpdir(), 'hm-ipc-'));
  await mkdir(accountControlDir(dataDir));
  const { promise: peerClosed, resolve: closePeer } = deferred();
  const server = createServer((socket) => {
    socket.on('data', () => socket.end(response));
    socket.on('close', closePeer);
  });
  await new Promise<void>((resolve) => server.listen(join(accountControlDir(dataDir), 'accounts.sock'), resolve));
  let outcome: unknown = 'pending';
  const pending = requestAccountRemoval(dataDir, 'account').then(
    (value) => { outcome = value; }, (error: unknown) => { outcome = error; }
  );
  try {
    await peerClosed;
    // Flush completion callbacks after the real socket's close event.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (outcome !== 'pending') await pending;
    return outcome;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('account removal IPC terminal responses', () => {
  it.each(['', '{"ok":true}'])('rejects incomplete EOF response %j', async (response) => {
    expect(await responseAtEof(response)).toEqual(new Error('control_response_incomplete'));
  });
  it('accepts only a complete success frame', async () => {
    expect(await responseAtEof('{"ok":true}\n')).toBe(true);
  });
});
