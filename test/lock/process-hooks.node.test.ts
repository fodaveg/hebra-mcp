import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriterLock } from '../../src/lock/writer-lock';

/**
 * Los bloqueos de escritor comparten UN oyente de `exit` y de señal por proceso (registro de
 * los vivos). Con uno por bloqueo, `serve-http` pasaba de 10 y Node avisaba con
 * `MaxListenersExceededWarning`.
 */

const dirs: string[] = [];
const locks: WriterLock[] = [];

function lockIn(): WriterLock {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-hooks-'));
  dirs.push(dir);
  const lock = new WriterLock({ dataDir: dir });
  locks.push(lock);
  return lock;
}

const EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const counts = (): number[] => EVENTS.map((event) => process.listenerCount(event));

afterEach(() => {
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('oyentes de proceso de WriterLock', () => {
  it('50 bloqueos vivos no suman oyentes ni disparan MaxListenersExceededWarning', () => {
    const before = counts();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => { warnings.push(warning); };
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < 50; i += 1) expect(lockIn().tryAcquire()).toBe(true);
      // El oyente de `warning` se emite en el siguiente turno del bucle de eventos.
      expect(counts()).toEqual(before.map((count) => count + 1));
      return new Promise<void>((resolve) => setImmediate(() => {
        process.removeListener('warning', onWarning);
        expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
        resolve();
      }));
    } catch (error) {
      process.removeListener('warning', onWarning);
      throw error;
    }
  });

  it('al soltarlos todos no queda ningún oyente nuestro, y se reinstalan al tomar otro', () => {
    const before = counts();
    const held = Array.from({ length: 50 }, () => lockIn());
    for (const lock of held) lock.tryAcquire();
    for (const lock of held.slice(0, 49)) lock.release();
    expect(counts()).toEqual(before.map((count) => count + 1));
    held[49].release();
    expect(counts()).toEqual(before);
    const again = lockIn();
    expect(again.tryAcquire()).toBe(true);
    expect(counts()).toEqual(before.map((count) => count + 1));
  });

  it('un bloqueo sin releaseOnExit no registra nada', () => {
    const before = counts();
    const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-hooks-'));
    dirs.push(dir);
    const lock = new WriterLock({ dataDir: dir, releaseOnExit: false });
    locks.push(lock);
    expect(lock.tryAcquire()).toBe(true);
    expect(counts()).toEqual(before);
  });
});
