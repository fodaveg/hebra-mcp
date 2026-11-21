/**
 * C-27: el hilo de conversión de ofimática. Hilos reales con un trabajo de prueba (código en
 * línea), `CapacityGate` real con memoria simulada y reloj simulado.
 */
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { CapacityGate, ContextUnavailableError } from '../../src/accounts/capacity';
import type { Clock } from '../../src/accounts/lifecycle';
import { handleOfficeJob } from '../../src/office-worker';
import {
  OFFICE_CONVERSION_RESERVE_BYTES,
  OFFICE_FILE_ID_MAX_BYTES,
  OFFICE_ZIP_LIMITS
} from '../../src/server/tools/office-limits';
import {
  createOfficeRunner,
  OFFICE_ANALYZE_BUDGET_MS,
  OFFICE_CONVERT_BUDGET_MS,
  OFFICE_HARD_CUT_GRACE_MS,
  OFFICE_QUEUE_WAIT_MS,
  type OfficeJobData
} from '../../src/store/office-runner';
import { ConversionError, type ConversionInput, type OfficeConverter } from '../../vendor/hebra/src/lib/office-import/types';

const MIB = 1024 * 1024;

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
  ok: `require('node:worker_threads').parentPort.postMessage({ ok: true, result: { converted: true } });`,
  refused: `require('node:worker_threads').parentPort.postMessage({ ok: false, code: 'corrupt', userMessage: 'Archivo dañado.' });`,
  leaky: `require('node:worker_threads').parentPort.postMessage({ ok: false, code: 'secreto-del-documento', userMessage: 'x'.repeat(500) });`,
  hang: `setInterval(() => {}, 1000);`,
  crash: `throw new Error('contenido-del-documento');`
} as const;

function harness(options: { memoryUsedMib?: number; job?: keyof typeof JOBS } = {}) {
  const clock = new FakeClock();
  const memory = { usedBytes: (options.memoryUsedMib ?? 0) * MIB, limitBytes: 512 * MIB };
  const gate = new CapacityGate({
    readMemory: () => memory,
    highWater: { ratio: 0.8 },
    waitMs: OFFICE_QUEUE_WAIT_MS,
    clock,
    reclaim: async () => undefined
  });
  const workers: Worker[] = [];
  const exited: boolean[] = [];
  const jobs: OfficeJobData[] = [];
  let source: string = JOBS[options.job ?? 'ok'];
  const runner = createOfficeRunner({
    clock,
    createWorker: (data) => {
      jobs.push(data);
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
  return { clock, gate, runner, workers, exited, jobs, memory, started, setJob: (job: keyof typeof JOBS) => { source = JOBS[job]; } };
}

const input = (bytes = 10) => ({ bytes: new Uint8Array(bytes), fileName: 'a.xlsx', format: 'xlsx' as const });

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('no rechazó');
};

describe('reserva en la compuerta', () => {
  it('aparta la reserva medida en C-07 mientras corre y la suelta al terminar bien', async () => {
    const { gate, runner, jobs } = harness();
    const result = runner.run('convert', input(), { gate, key: 'a' });
    await settled();
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 10);
    expect(await result).toEqual({ converted: true });
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
    expect(jobs[0]!.input.budgetMs).toBe(OFFICE_CONVERT_BUDGET_MS);
  });

  it('analyze usa su propio presupuesto', async () => {
    const { gate, runner, jobs } = harness();
    await runner.run('analyze', input(), { gate, key: 'a' });
    expect(jobs[0]!.kind).toBe('analyze');
    expect(jobs[0]!.input.budgetMs).toBe(OFFICE_ANALYZE_BUDGET_MS);
  });

  it('la suelta si el hilo responde un fallo y conserva su código', async () => {
    const { gate, runner } = harness({ job: 'refused' });
    const error = (await rejection(runner.run('convert', input(), { gate, key: 'a' }))) as ConversionError;
    expect(error).toBeInstanceOf(ConversionError);
    expect(error.code).toBe('corrupt');
    expect(error.userMessage).toBe('Archivo dañado.');
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('un código desconocido o un texto largo del hilo se sustituyen por internal y un texto fijo', async () => {
    const { gate, runner } = harness({ job: 'leaky' });
    const error = (await rejection(runner.run('convert', input(), { gate, key: 'a' }))) as ConversionError;
    expect(error.code).toBe('internal');
    expect(error.userMessage).not.toContain('xxx');
    expect(error.message).not.toContain('secreto');
    expect(gate.reservedBytes).toBe(0);
  });

  it('la suelta si el hilo se cae, sin repetir su texto', async () => {
    const { gate, runner } = harness({ job: 'crash' });
    const error = (await rejection(runner.run('convert', input(), { gate, key: 'a' }))) as ConversionError;
    expect(error.code).toBe('internal');
    expect(JSON.stringify([error.message, error.userMessage])).not.toContain('contenido');
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('un archivo por encima del tope de fileId ni reserva ni arranca', async () => {
    const { gate, runner, workers } = harness();
    const big = { ...input(), bytes: new Uint8Array(OFFICE_FILE_ID_MAX_BYTES + 1) };
    const error = (await rejection(runner.run('convert', big, { gate, key: 'a' }))) as ConversionError;
    expect(error.code).toBe('too_large');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
  });
});

describe('corte duro', () => {
  it('un convertidor colgado se mata al agotar presupuesto y gracia, suelta todo y el siguiente corre', async () => {
    const { clock, gate, runner, started, exited, setJob } = harness({ job: 'hang' });
    const cut = OFFICE_CONVERT_BUDGET_MS + OFFICE_HARD_CUT_GRACE_MS;
    const failure = rejection(runner.run('convert', input(), { gate, key: 'a' }));
    await started(1);
    await clock.advance(cut - 1);
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 10);
    await clock.advance(1);
    expect(((await failure) as ConversionError).code).toBe('too_large');
    await until(() => exited.length === 1);
    expect(exited).toEqual([true]);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
    // El servidor sigue respondiendo: la siguiente conversión entra y termina.
    setJob('ok');
    expect(await runner.run('convert', input(), { gate, key: 'a' })).toEqual({ converted: true });
  });

  it('un presupuesto propio mueve el corte', async () => {
    const { clock, gate, runner, started } = harness({ job: 'hang' });
    const failure = rejection(runner.run('convert', { ...input(), budgetMs: 1000 }, { gate, key: 'a' }));
    await started(1);
    await clock.advance(1000 + OFFICE_HARD_CUT_GRACE_MS);
    expect(((await failure) as ConversionError).code).toBe('too_large');
    expect(gate.reservedBytes).toBe(0);
  });
});

describe('cancelación', () => {
  it('con el hilo en marcha lo mata, rechaza con cancelled y suelta la reserva', async () => {
    const { clock, gate, runner, started, exited } = harness({ job: 'hang' });
    const controller = new AbortController();
    const failure = rejection(runner.run('convert', input(), { gate, key: 'a', signal: controller.signal }));
    await started(1);
    controller.abort();
    expect(((await failure) as ConversionError).code).toBe('cancelled');
    await until(() => exited.length === 1);
    expect(exited).toEqual([true]);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('en la cola sale sin arrancar nada ni dejar reserva', async () => {
    const { gate, runner, started, workers } = harness({ job: 'hang' });
    void rejection(runner.run('convert', input(), { gate, key: 'a' }));
    await started(1);
    const controller = new AbortController();
    const waiting = rejection(runner.run('convert', input(), { gate, key: 'a', signal: controller.signal }));
    await settled();
    controller.abort();
    expect(((await waiting) as ConversionError).code).toBe('cancelled');
    expect(workers).toHaveLength(1);
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 10);
  });

  it('una señal ya abortada ni entra en la cola', async () => {
    const { gate, runner, workers } = harness();
    const controller = new AbortController();
    controller.abort();
    const error = (await rejection(runner.run('convert', input(), { gate, key: 'a', signal: controller.signal }))) as ConversionError;
    expect(error.code).toBe('cancelled');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });
});

describe('una conversión a la vez', () => {
  it('la segunda espera a que acabe la primera y no hay dos hilos vivos', async () => {
    const { clock, gate, runner, started, workers, setJob } = harness({ job: 'hang' });
    const first = rejection(runner.run('convert', { ...input(), budgetMs: 1000 }, { gate, key: 'a' }));
    await started(1);
    setJob('ok');
    const second = runner.run('convert', input(), { gate, key: 'b' });
    await settled();
    expect(workers).toHaveLength(1);
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 10);
    await clock.advance(1000 + OFFICE_HARD_CUT_GRACE_MS);
    expect(((await first) as ConversionError).code).toBe('too_large');
    expect(await second).toEqual({ converted: true });
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('si la espera por el hueco se agota, capacity_wait_timeout sin hilo ni reserva extra', async () => {
    const { clock, gate, runner, started, workers } = harness({ job: 'hang' });
    void rejection(runner.run('convert', input(), { gate, key: 'a' }));
    await started(1);
    const waiting = rejection(runner.run('convert', input(), { gate, key: 'b' }));
    await clock.advance(OFFICE_QUEUE_WAIT_MS);
    const error = (await waiting) as ContextUnavailableError;
    expect(error).toBeInstanceOf(ContextUnavailableError);
    expect(error.reason).toBe('capacity_wait_timeout');
    expect(workers).toHaveLength(1);
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 10);
  });
});

describe('reserva con la copia de bytes', () => {
  it('un fichero de 25 MiB aparta 145 MiB y uno pequeño, 120 MiB más su tamaño; todo se suelta', async () => {
    const { gate, runner } = harness({ job: 'hang' });
    const controller = new AbortController();
    const big = rejection(
      runner.run('convert', { ...input(), bytes: new Uint8Array(25 * MIB) }, { gate, key: 'a', signal: controller.signal })
    );
    await settled();
    expect(gate.reservedBytes).toBe(145 * MIB);
    controller.abort();
    await big;
    expect(gate.reservedBytes).toBe(0);
  });

  it('uno pequeño aparta la constante más su tamaño y la suelta entera', async () => {
    const { gate, runner } = harness({ job: 'hang' });
    const controller = new AbortController();
    const failure = rejection(runner.run('convert', input(1234), { gate, key: 'a', signal: controller.signal }));
    await settled();
    expect(gate.reservedBytes).toBe(OFFICE_CONVERSION_RESERVE_BYTES + 1234);
    controller.abort();
    await failure;
    expect(gate.reservedBytes).toBe(0);
  });

  it('lo que cabría con 120 MiB pero no con la suma espera y da capacity_wait_timeout sin hilo', async () => {
    // Límite de 409,6 MiB: con 280 MiB usados caben 120 (400) pero no 145 (425).
    const { clock, gate, runner, workers } = harness({ memoryUsedMib: 280 });
    const failure = rejection(
      runner.run('convert', { ...input(), bytes: new Uint8Array(25 * MIB) }, { gate, key: 'a' })
    );
    await settled();
    expect(gate.waitingCount).toBe(1);
    await clock.advance(OFFICE_QUEUE_WAIT_MS);
    expect(((await failure) as ContextUnavailableError).reason).toBe('capacity_wait_timeout');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
    expect(runner.active).toBe(0);
  });

  it('el mismo caso con un fichero pequeño sí entra', async () => {
    const { gate, runner } = harness({ memoryUsedMib: 280 });
    expect(await runner.run('convert', input(), { gate, key: 'a' })).toEqual({ converted: true });
    expect(gate.reservedBytes).toBe(0);
  });
});

describe('reserva que no cabe', () => {
  it('responde capacity_wait_timeout sin arrancar el hilo ni dejar hueco ni reserva', async () => {
    const { clock, gate, runner, workers } = harness({ memoryUsedMib: 400 });
    const failure = rejection(runner.run('convert', input(), { gate, key: 'a' }));
    await settled();
    expect(gate.waitingCount).toBe(1);
    await clock.advance(OFFICE_QUEUE_WAIT_MS);
    const error = (await failure) as ContextUnavailableError;
    expect(error.reason).toBe('capacity_wait_timeout');
    expect(workers).toHaveLength(0);
    expect(gate.reservedBytes).toBe(0);
    expect(gate.waitingCount).toBe(0);
    expect(runner.active).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('espera y entra en cuanto la memoria baja', async () => {
    const { clock, gate, runner, memory, workers } = harness({ memoryUsedMib: 400 });
    const result = runner.run('convert', input(), { gate, key: 'a' });
    await settled();
    expect(workers).toHaveLength(0);
    memory.usedBytes = 0;
    gate.recheck();
    await clock.advance(1);
    expect(await result).toEqual({ converted: true });
    expect(gate.reservedBytes).toBe(0);
  });
});

describe('hilo de conversión', () => {
  const job = (kind: 'analyze' | 'convert'): OfficeJobData => ({ kind, input: { ...input(), budgetMs: 1000 } });
  const converter: OfficeConverter = {
    formats: ['xlsx'],
    analyze: async () => ({ format: 'xlsx', convertible: true, losses: [] }),
    convert: async () => {
      throw new ConversionError('encrypted', 'Tiene contraseña.');
    }
  };

  it('analyze devuelve la vista previa del convertidor', async () => {
    expect(await handleOfficeJob(job('analyze'), async () => converter)).toEqual({
      ok: true,
      result: { format: 'xlsx', convertible: true, losses: [] }
    });
  });

  it('el convertidor recibe OFFICE_ZIP_LIMITS en el ConversionInput (C-07c)', async () => {
    let recibido: ConversionInput | undefined;
    const espia: OfficeConverter = {
      ...converter,
      analyze: async (entrada) => {
        recibido = entrada;
        return { format: 'xlsx', convertible: true, losses: [] };
      }
    };
    await handleOfficeJob(job('analyze'), async () => espia);
    expect(recibido?.limits).toEqual(OFFICE_ZIP_LIMITS);
  });

  it('un ConversionError viaja con su código y su texto', async () => {
    expect(await handleOfficeJob(job('convert'), async () => converter)).toEqual({
      ok: false,
      code: 'encrypted',
      userMessage: 'Tiene contraseña.'
    });
  });

  it('cualquier otro fallo es internal y no repite su texto', async () => {
    const reply = await handleOfficeJob(job('convert'), async () => {
      throw new Error('contenido-del-documento');
    });
    expect(reply).toMatchObject({ ok: false, code: 'internal' });
    expect(JSON.stringify(reply)).not.toContain('contenido');
  });

  it('un formato sin convertidor registrado (tabla vacía) es internal', async () => {
    expect(await handleOfficeJob(job('analyze'))).toMatchObject({ ok: false, code: 'internal' });
  });
});
