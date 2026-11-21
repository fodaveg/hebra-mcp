/**
 * B-M02: la cola y el hilo de los trabajos de documentos. Hilos reales con un trabajo de
 * prueba (código en línea), `CapacityGate` real con memoria simulada y reloj simulado.
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { CapacityGate } from '../../src/accounts/capacity';
import type { Clock } from '../../src/accounts/lifecycle';
import { handleDocumentJob } from '../../src/document-worker';
import {
  createDocumentJobRunner,
  documentReserveBytes,
  DocumentJobError,
  type DocumentJobKind
} from '../../src/store/document-jobs';
import {
  DOCUMENT_EDIT_TIMEOUT_MS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_QUEUE_WAIT_MS,
  DOCUMENT_READ_TIMEOUT_MS
} from '../../src/store/document-limits';

const MIB = 1024 * 1024;

/** Espera de verdad (un hilo tarda en morir) hasta que `done()` sea cierto. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 400 && !done(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function settled(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

class FakeClock implements Clock {
  private time = 0;
  private timers: Array<{ at: number; run: () => void }> = [];
  now(): number { return this.time; }
  setTimer(run: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, run };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter((entry) => entry !== timer); };
  }
  get pending(): number { return this.timers.length; }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((entry) => entry !== due);
      this.time = Math.max(this.time, due.at);
      due.run();
      await settled();
    }
    this.time = end;
    await settled();
  }
}

/** Trabajos de prueba: el código que corre el hilo. */
const JOBS = {
  ok: `require('node:worker_threads').parentPort.postMessage({ ok: true, result: 'hecho' });`,
  refused: `require('node:worker_threads').parentPort.postMessage({ ok: false, code: 'secreto-del-documento' });`,
  hang: `setInterval(() => {}, 1000);`,
  crash: `throw new Error('contenido-del-documento');`
} as const;

function harness(
  options: { memoryUsedMib?: number; job?: keyof typeof JOBS; gateWaitMs?: number } = {}
) {
  const clock = new FakeClock();
  const memory = { usedBytes: (options.memoryUsedMib ?? 0) * MIB, limitBytes: 512 * MIB };
  const gate = new CapacityGate({
    readMemory: () => memory,
    highWater: { ratio: 0.8 },
    waitMs: options.gateWaitMs ?? DOCUMENT_QUEUE_WAIT_MS,
    clock,
    reclaim: async () => undefined
  });
  const workers: Worker[] = [];
  const exited: boolean[] = [];
  let source: string = JOBS[options.job ?? 'ok'];
  const runner = createDocumentJobRunner({
    clock,
    createWorker: () => {
      const worker = new Worker(source, { eval: true, stdout: true, stderr: true });
      worker.once('exit', () => exited.push(true));
      workers.push(worker);
      return worker;
    }
  });
  const started = async (count: number): Promise<void> => {
    await until(() => workers.length >= count);
    expect(workers).toHaveLength(count);
  };
  return { clock, gate, runner, workers, exited, memory, setJob: (job: keyof typeof JOBS) => { source = JOBS[job]; }, started };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('no rechazó');
};

describe('reserva en la compuerta', () => {
  it('con el tope de documento reserva los 114 MiB del estudio', () => {
    expect(documentReserveBytes(DOCUMENT_MAX_BYTES)).toBe(114 * MIB);
  });

  it('aparta la reserva mientras corre el hilo y la suelta al terminar bien', async () => {
    const { gate, runner } = harness();
    const seen: number[] = [];
    const result = runner.run('read', {}, { gate, key: 'a', documentBytes: 25 * MIB });
    await settled();
    seen.push(gate.reservedBytes);
    expect(await result).toBe('hecho');
    expect(seen).toEqual([114 * MIB]);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('la suelta si el hilo responde un fallo, sin repetir su texto', async () => {
    const { gate, runner } = harness({ job: 'refused' });
    const error = (await rejection(runner.run('read', {}, { gate, key: 'a' }))) as DocumentJobError;
    expect(error.code).toBe('document_job_failed');
    expect(error.message).not.toContain('secreto');
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('la suelta si el hilo se cae, sin repetir su texto', async () => {
    const { gate, runner } = harness({ job: 'crash' });
    const error = (await rejection(runner.run('edit', {}, { gate, key: 'a' }))) as DocumentJobError;
    expect(error.code).toBe('document_job_failed');
    expect(error.message).not.toContain('contenido');
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });
});

describe('plazo', () => {
  it.each<[DocumentJobKind, number]>([
    ['read', DOCUMENT_READ_TIMEOUT_MS],
    ['edit', DOCUMENT_EDIT_TIMEOUT_MS]
  ])('un %s colgado se mata a los %i ms y suelta todo', async (kind, timeout) => {
    const { clock, gate, runner, started, exited } = harness({ job: 'hang' });
    const job = runner.run(kind, {}, { gate, key: 'a', documentBytes: MIB });
    const failure = rejection(job);
    await started(1);
    await clock.advance(timeout - 1);
    expect(gate.reservedBytes).toBeGreaterThan(0);
    await clock.advance(1);
    expect(((await failure) as DocumentJobError).code).toBe('document_timeout');
    await until(() => exited.length === 1);
    expect(exited).toEqual([true]);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe('cancelación', () => {
  it('con el hilo en marcha lo mata, rechaza con la razón y suelta la reserva', async () => {
    const { clock, gate, runner, started, exited } = harness({ job: 'hang' });
    const controller = new AbortController();
    const failure = rejection(runner.run('read', {}, { gate, key: 'a', signal: controller.signal }));
    await started(1);
    controller.abort(new Error('cancelado'));
    expect(((await failure) as Error).message).toBe('cancelado');
    await until(() => exited.length === 1);
    expect(exited).toEqual([true]);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('en la cola sale sin arrancar nada ni dejar reserva', async () => {
    const { gate, runner, started, workers } = harness({ job: 'hang' });
    const holders = [0, 1].map(() => rejection(runner.run('read', {}, { gate, key: 'a' })));
    await started(2);
    const controller = new AbortController();
    const waiting = rejection(runner.run('read', {}, { gate, key: 'a', signal: controller.signal }));
    await settled();
    controller.abort(new Error('cancelado'));
    expect(((await waiting) as Error).message).toBe('cancelado');
    expect(workers).toHaveLength(2);
    expect(gate.reservedBytes).toBe(2 * documentReserveBytes(0));
    void holders;
  });

  it('una señal ya abortada ni entra en la cola', async () => {
    const { gate, runner, workers } = harness();
    const controller = new AbortController();
    controller.abort(new Error('cancelado'));
    const error = (await rejection(runner.run('read', {}, { gate, key: 'a', signal: controller.signal }))) as Error;
    expect(error.message).toBe('cancelado');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });
});

describe('document_busy', () => {
  it('el tercer trabajo espera 20 s con dos en marcha y responde document_busy sin hilo', async () => {
    const { clock, gate, runner, started, workers, exited } = harness({ job: 'hang' });
    const long = { timeoutMs: 60_000 };
    const first = rejection(runner.run('read', {}, { gate, key: 'a', ...long }));
    const second = rejection(runner.run('read', {}, { gate, key: 'b', ...long }));
    await started(2);
    const third = rejection(runner.run('read', {}, { gate, key: 'c' }));
    await clock.advance(DOCUMENT_QUEUE_WAIT_MS - 1);
    expect(workers).toHaveLength(2);
    await clock.advance(1);
    expect(((await third) as DocumentJobError).code).toBe('document_busy');
    expect(workers).toHaveLength(2);
    // Los dos primeros siguen vivos con su reserva: la espera del tercero no les toca.
    expect(gate.reservedBytes).toBe(2 * documentReserveBytes(0));
    expect(runner.active).toBe(2);
    // Cuando acaban por plazo, sueltan todo.
    await clock.advance(60_000);
    expect(((await first) as DocumentJobError).code).toBe('document_timeout');
    expect(((await second) as DocumentJobError).code).toBe('document_timeout');
    await until(() => exited.length === 2);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('el tercero entra en cuanto uno termina, dentro de la espera', async () => {
    const { clock, gate, runner, started, setJob } = harness({ job: 'hang' });
    const first = rejection(runner.run('read', {}, { gate, key: 'a' }));
    const second = rejection(runner.run('read', {}, { gate, key: 'a' }));
    await started(2);
    setJob('ok');
    const third = runner.run('read', {}, { gate, key: 'a' });
    await clock.advance(DOCUMENT_READ_TIMEOUT_MS);
    expect(await third).toBe('hecho');
    await first;
    await second;
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('si la reserva no cabe en la compuerta, document_busy sin arrancar el hilo ni dejar hueco', async () => {
    const { clock, gate, runner, workers } = harness({ memoryUsedMib: 400 });
    const failure = rejection(runner.run('read', {}, { gate, key: 'a', documentBytes: 25 * MIB }));
    await settled();
    expect(gate.waitingCount).toBe(1);
    await clock.advance(DOCUMENT_QUEUE_WAIT_MS);
    expect(((await failure) as DocumentJobError).code).toBe('document_busy');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
    expect(gate.waitingCount).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe('hilo de trabajos', () => {
  it('un tipo desconocido responde un código cerrado', async () => {
    expect(await handleDocumentJob('no-existe', {})).toEqual({ ok: false, code: 'document_job_unknown_kind' });
  });
});
