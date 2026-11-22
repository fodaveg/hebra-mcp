/**
 * Topes de hojas del MCP (H-95). Las cifras de aquí son las medidas que cita la cabecera de
 * `src/store/sheet-limits.ts` (22 nov 2026, contenedor de 512 MiB, 220 MiB de lastre, Node 24.21.0
 * con `--liftoff-only`): el test comprueba que los topes salen de ellas y que la reserva es la que
 * mantiene a dos cuentas bajo el presupuesto con la compuerta real.
 *
 * Rotura vista: con `SHEET_JOB_RESERVE_BYTES` a 0, la compuerta deja entrar a las dos cuentas a
 * la vez y el pico pasa de los 409,6 MiB del presupuesto.
 */
import { describe, expect, it } from 'vitest';
import { CapacityGate, DEFAULT_HIGH_WATER } from '../../src/accounts/capacity';
import type { Clock } from '../../src/accounts/lifecycle';
import {
  SHEET_CONTAINER_BYTES,
  SHEET_DISK_PER_DOCUMENT_MAX_BYTES,
  SHEET_DOCUMENT_MAX_BYTES,
  SHEET_JOB_RESERVE_BYTES,
  SHEET_JOBS_MAX,
  SHEET_MCP_BASE_BYTES,
  SHEET_MEMORY_BUDGET_BYTES,
  SHEET_ODS_INVENTORY_LIMITS,
  SHEET_ODS_READ_LIMITS,
  SHEET_RETAINED_VERSIONS,
  sheetJobReserveBytes
} from '../../src/store/sheet-limits';
import { VERSIONS_MAX } from '../../vendor/hebra/src/lib/documents/sync/checkpoint';
import { DEFAULT_ZIP_LIMITS } from '../../vendor/hebra/src/lib/portability/zip-read';
import { ODS_READ_LIMITS } from '../../vendor/hebra/src/lib/sheets/contracts/limits';
import { zipLimits } from '../../vendor/hebra/src/lib/sheets/ods/read-workbook';

const MIB = 1024 * 1024;

/** Un trabajo: `.ods` y XML en MiB, cgroup antes y picos de página y resumen (tres de cada). */
interface Measured {
  ods: number;
  xml: number;
  before: number;
  peaks: number[];
}

const ONE_JOB: Measured[] = [
  { ods: 0.01, xml: 0.05, before: 233.4, peaks: [345.9, 346.2, 345.9, 346.7, 345.9, 344.3] },
  { ods: 4, xml: 2, before: 241.4, peaks: [376.1, 379, 376.5, 377.4, 391.8, 377.5] },
  { ods: 4, xml: 4, before: 241.4, peaks: [391, 392.6, 391.1, 405, 393.3, 391.1] },
  { ods: 8, xml: 2, before: 249.3, peaks: [397.8, 395.4, 397.1, 394, 398.3, 411.2] },
  { ods: 8, xml: 4, before: 249.3, peaks: [407.7, 407, 408.7, 407.8, 410.3, 409.9] },
  { ods: 2, xml: 8, before: 237.4, peaks: [413.4, 412, 413.6, 412, 412.7, 411.8] },
  { ods: 4, xml: 8, before: 241.4, peaks: [422.8, 419.1, 418.9, 418, 419, 420] },
  { ods: 12, xml: 4, before: 257.7, peaks: [423.7, 423, 422, 424.1, 422.4, 424.3] },
  { ods: 25, xml: 2, before: 283.4, peaks: [460.4, 464] }
];

/** El mayor incremento sobre el cgroup de antes dentro de los topes (4 y 4 MiB, resumen). */
const WORST_DELTA_BYTES = (405 - 241.4) * MIB;

/** Dos trabajos a la vez en los topes: picos del cgroup de cinco corridas; la sexta acabó en OOM. */
const TWO_JOBS_PEAKS = [512, 501.2, 512, 484.7, 475.5];

const budgetMib = SHEET_MEMORY_BUDGET_BYTES / MIB;
const withinCaps = (row: Measured) =>
  row.ods * MIB <= SHEET_DOCUMENT_MAX_BYTES && row.xml * MIB <= SHEET_ODS_READ_LIMITS.maxTotalBytes;

/** Un reloj que no avanza: ni la espera de la compuerta ni su sondeo vencen solos. */
const stillClock: Clock = { now: () => 0, setTimer: () => () => undefined };

/**
 * Dos cuentas piden a la vez un trabajo de hojas del tope. Cada trabajo, al entrar, suma a la
 * memoria que lee la compuerta el peor incremento medido y lo quita al acabar.
 */
async function twoAccounts(reserve: (documentBytes: number) => number) {
  let used = SHEET_MCP_BASE_BYTES;
  let peak = used;
  let running = 0;
  let overlap = 0;
  const gate = new CapacityGate({
    readMemory: () => ({ usedBytes: used, limitBytes: SHEET_CONTAINER_BYTES }),
    highWater: DEFAULT_HIGH_WATER,
    waitMs: 20_000,
    clock: stillClock,
    reclaim: async () => undefined
  });
  const job = async (key: string) => {
    const ticket = await gate.admit(undefined, reserve(SHEET_DOCUMENT_MAX_BYTES), key);
    running += 1;
    overlap = Math.max(overlap, running);
    used += WORST_DELTA_BYTES;
    peak = Math.max(peak, used);
    await new Promise((resolve) => setTimeout(resolve, 0));
    used -= WORST_DELTA_BYTES;
    running -= 1;
    ticket.done();
  };
  await Promise.all([job('cuenta-a'), job('cuenta-b')]);
  gate.shutdown();
  return { peakMib: peak / MIB, overlap };
}

describe('topes de hojas del MCP (H-95)', () => {
  it('el presupuesto es el 80 % del contenedor, el mismo umbral de la compuerta', () => {
    expect(SHEET_CONTAINER_BYTES).toBe(512 * MIB);
    expect(DEFAULT_HIGH_WATER).toEqual({ ratio: 0.8 });
    expect(budgetMib).toBeCloseTo(409.6, 1);
  });

  it('cada medida dentro de los topes cabe en el presupuesto y en la reserva; fuera, alguna no', () => {
    const inside = ONE_JOB.filter(withinCaps);
    expect(inside.map((row) => [row.ods, row.xml])).toEqual([
      [0.01, 0.05],
      [4, 2],
      [4, 4]
    ]);
    for (const row of inside) {
      expect(Math.max(...row.peaks)).toBeLessThanOrEqual(budgetMib);
      expect((Math.max(...row.peaks) - row.before) * MIB).toBeLessThanOrEqual(SHEET_JOB_RESERVE_BYTES);
    }
    // Los topes son los mayores medidos que cumplen: lo de fuera pasa del presupuesto al menos una vez.
    for (const row of ONE_JOB.filter((row) => !withinCaps(row))) {
      expect(Math.max(...row.peaks)).toBeGreaterThan(budgetMib);
    }
  });

  it('con la base medida cabe un trabajo de hojas y no dos', () => {
    expect(SHEET_MCP_BASE_BYTES + SHEET_JOB_RESERVE_BYTES).toBeLessThanOrEqual(SHEET_MEMORY_BUDGET_BYTES);
    expect(SHEET_MCP_BASE_BYTES + 2 * SHEET_JOB_RESERVE_BYTES).toBeGreaterThan(SHEET_MEMORY_BUDGET_BYTES);
    expect(SHEET_JOBS_MAX).toBe(1);
    for (const peak of TWO_JOBS_PEAKS) expect(peak).toBeGreaterThan(budgetMib);
  });

  it('la reserva es la del tope y no hay reserva por encima de él', () => {
    expect(sheetJobReserveBytes(0)).toBe(SHEET_JOB_RESERVE_BYTES);
    expect(sheetJobReserveBytes(SHEET_DOCUMENT_MAX_BYTES)).toBe(SHEET_JOB_RESERVE_BYTES);
    expect(() => sheetJobReserveBytes(SHEET_DOCUMENT_MAX_BYTES + 1)).toThrow('sheet_document_too_large');
    expect(() => sheetJobReserveBytes(Number.NaN)).toThrow('sheet_document_too_large');
  });

  it('con la reserva, dos cuentas a la vez van de una en una y no pasan del presupuesto', async () => {
    const { peakMib, overlap } = await twoAccounts(sheetJobReserveBytes);
    expect(overlap).toBe(1);
    expect(peakMib).toBeLessThanOrEqual(budgetMib);
  });

  it('sin la reserva, las dos entran a la vez y el pico pasa del presupuesto', async () => {
    const { peakMib, overlap } = await twoAccounts(() => 0);
    expect(overlap).toBe(2);
    expect(peakMib).toBeGreaterThan(budgetMib);
  });

  it('contraste con S-F y C-02: ningún tope de lectura es mayor', () => {
    for (const key of Object.keys(ODS_READ_LIMITS) as (keyof typeof ODS_READ_LIMITS)[]) {
      expect(SHEET_ODS_READ_LIMITS[key]).toBeLessThanOrEqual(ODS_READ_LIMITS[key]);
    }
    const zip = zipLimits(SHEET_ODS_READ_LIMITS);
    for (const key of Object.keys(DEFAULT_ZIP_LIMITS) as (keyof typeof DEFAULT_ZIP_LIMITS)[]) {
      expect(zip[key]).toBeLessThanOrEqual(DEFAULT_ZIP_LIMITS[key]);
    }
    // S-F se queda 32 veces por encima de lo que cabe: 128 MiB por entrada frente a 4.
    expect(ODS_READ_LIMITS.maxEntryBytes / SHEET_ODS_READ_LIMITS.maxEntryBytes).toBe(32);
  });

  it('el inventario (todas las entradas) cabe en el XML más el documento, y tampoco pasa de S-F ni de C-02', () => {
    expect(SHEET_ODS_INVENTORY_LIMITS).toEqual({
      ...SHEET_ODS_READ_LIMITS,
      maxTotalBytes: SHEET_ODS_READ_LIMITS.maxTotalBytes + SHEET_DOCUMENT_MAX_BYTES
    });
    expect(SHEET_ODS_INVENTORY_LIMITS.maxTotalBytes).toBe(8 * MIB);
    const zip = zipLimits(SHEET_ODS_INVENTORY_LIMITS);
    for (const key of Object.keys(DEFAULT_ZIP_LIMITS) as (keyof typeof DEFAULT_ZIP_LIMITS)[]) {
      expect(zip[key]).toBeLessThanOrEqual(DEFAULT_ZIP_LIMITS[key]);
    }
    for (const key of Object.keys(ODS_READ_LIMITS) as (keyof typeof ODS_READ_LIMITS)[]) {
      expect(SHEET_ODS_INVENTORY_LIMITS[key]).toBeLessThanOrEqual(ODS_READ_LIMITS[key]);
    }
  });

  it('disco por documento con B-N21: las versiones retenidas de Hebra, la base y el punto actual', () => {
    expect(SHEET_RETAINED_VERSIONS).toBe(VERSIONS_MAX);
    // Medido: 130 puntos de un .ods de 4 MiB con acuse tras cada uno dejan 122 blobs y 484 MiB.
    expect(SHEET_DISK_PER_DOCUMENT_MAX_BYTES / SHEET_DOCUMENT_MAX_BYTES).toBe(122);
    expect(SHEET_DISK_PER_DOCUMENT_MAX_BYTES).toBeGreaterThanOrEqual(484 * MIB);
  });
});
