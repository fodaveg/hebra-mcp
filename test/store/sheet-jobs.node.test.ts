/**
 * H-95b: la cola de los trabajos de hojas (`src/store/sheet-jobs.ts`). `CapacityGate` real con
 * memoria simulada y reloj simulado, como `document-jobs.node.test.ts`.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `SlotQueue` con `maxJobs` 2 en vez de `SHEET_JOBS_MAX`: cae «de uno en uno»;
 * - reservar `documentReserveBytes` en vez de `sheetJobReserveBytes`: cae «aparta la reserva de hojas»;
 * - no soltar el hueco cuando la compuerta rechaza: cae «la compuerta sin sitio» (el siguiente no entra);
 * - `done` sin `once`: cae «soltar dos veces» (la cola cuenta un hueco de más).
 */
import { describe, expect, it } from 'vitest';
import { CapacityGate } from '../../src/accounts/capacity';
import type { Clock } from '../../src/accounts/lifecycle';
import { DocumentJobError } from '../../src/store/document-jobs';
import { DOCUMENT_QUEUE_WAIT_MS } from '../../src/store/document-limits';
import { createSheetJobQueue } from '../../src/store/sheet-jobs';
import { SHEET_DOCUMENT_MAX_BYTES, SHEET_JOB_RESERVE_BYTES, SHEET_JOBS_MAX } from '../../src/store/sheet-limits';

const MIB = 1024 * 1024;

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

function harness(memoryUsedMib = 0) {
  const clock = new FakeClock();
  const memory = { usedBytes: memoryUsedMib * MIB, limitBytes: 512 * MIB };
  const gate = new CapacityGate({
    readMemory: () => memory,
    highWater: { ratio: 0.8 },
    waitMs: DOCUMENT_QUEUE_WAIT_MS,
    clock,
    reclaim: async () => undefined
  });
  const queue = createSheetJobQueue({ clock });
  return { clock, gate, memory, queue, capacity: (key: string) => ({ gate, key }) };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('no rechazó');
};

describe('cola de trabajos de hojas (H-95b)', () => {
  it('aparta la reserva de hojas, sea cual sea el tamaño del .ods, y la suelta', async () => {
    const { gate, queue, capacity } = harness();
    const small = await queue.admit(capacity('a'), 1);
    expect(gate.reservedBytes).toBe(SHEET_JOB_RESERVE_BYTES);
    small.done();
    expect(gate.reservedBytes).toBe(0);
    const top = await queue.admit(capacity('a'), SHEET_DOCUMENT_MAX_BYTES);
    expect(gate.reservedBytes).toBe(SHEET_JOB_RESERVE_BYTES);
    top.done();
    expect(queue.active).toBe(0);
  });

  it('por encima del tope no espera ni reserva: RangeError', async () => {
    const { gate, queue, capacity } = harness();
    await expect(queue.admit(capacity('a'), SHEET_DOCUMENT_MAX_BYTES + 1)).rejects.toThrow('sheet_document_too_large');
    expect(gate.reservedBytes).toBe(0);
    expect(queue.active).toBe(0);
  });

  it('de uno en uno: dos cuentas con memoria de sobra no entran a la vez', async () => {
    expect(SHEET_JOBS_MAX).toBe(1);
    const { queue, capacity } = harness();
    const first = await queue.admit(capacity('a'), 0);
    let second: { done(): void } | null = null;
    const waiting = queue.admit(capacity('b'), 0).then((ticket) => (second = ticket));
    await settled();
    expect(second).toBeNull();
    expect(queue.active).toBe(1);
    first.done();
    await waiting;
    expect(second).not.toBeNull();
    second!.done();
    expect(queue.active).toBe(0);
  });

  it('el hueco sin reserva (el de hebra_read_sheet) cuenta en la misma cola', async () => {
    const { queue, capacity } = harness();
    const release = await queue.slot();
    let admitted = false;
    const waiting = queue.admit(capacity('a'), 0).then((ticket) => ((admitted = true), ticket));
    await settled();
    expect(admitted).toBe(false);
    release();
    (await waiting).done();
    expect(admitted).toBe(true);
  });

  it('sin hueco en DOCUMENT_QUEUE_WAIT_MS: document_busy, sin dejar nada apartado', async () => {
    const { clock, gate, queue, capacity } = harness();
    const first = await queue.admit(capacity('a'), 0);
    const late = rejection(queue.admit(capacity('b'), 0));
    const lateSlot = rejection(queue.slot());
    await clock.advance(DOCUMENT_QUEUE_WAIT_MS);
    for (const error of [await late, await lateSlot]) {
      expect(error).toBeInstanceOf(DocumentJobError);
      expect((error as DocumentJobError).code).toBe('document_busy');
    }
    first.done();
    expect(gate.reservedBytes).toBe(0);
    expect(queue.active).toBe(0);
  });

  it('la compuerta sin sitio: document_busy y el hueco vuelve a la cola', async () => {
    const { clock, gate, memory, queue, capacity } = harness(400);
    const refused = rejection(queue.admit(capacity('a'), 0));
    await clock.advance(DOCUMENT_QUEUE_WAIT_MS);
    const error = await refused;
    expect(error).toBeInstanceOf(DocumentJobError);
    expect((error as DocumentJobError).code).toBe('document_busy');
    expect(queue.active).toBe(0);
    memory.usedBytes = 0;
    const next = await queue.admit(capacity('b'), 0);
    expect(gate.reservedBytes).toBe(SHEET_JOB_RESERVE_BYTES);
    next.done();
  });

  it('una cancelación saca de la cola con su razón', async () => {
    const { queue, capacity } = harness();
    const first = await queue.admit(capacity('a'), 0);
    const cancel = new AbortController();
    const waiting = rejection(queue.admit(capacity('b'), 0, cancel.signal));
    cancel.abort(new Error('cliente-se-fue'));
    expect(((await waiting) as Error).message).toBe('cliente-se-fue');
    first.done();
    expect(queue.active).toBe(0);
  });

  it('soltar dos veces cuenta una', async () => {
    const { gate, queue, capacity } = harness();
    const ticket = await queue.admit(capacity('a'), 0);
    ticket.done();
    ticket.done();
    expect(gate.reservedBytes).toBe(0);
    expect(queue.active).toBe(0);
    const slot = await queue.slot();
    slot();
    slot();
    expect(queue.active).toBe(0);
  });
});
