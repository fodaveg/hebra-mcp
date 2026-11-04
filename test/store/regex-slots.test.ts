import { describe, expect, it } from 'vitest';
import { acquireSlot, REGEX_WORKERS_MAX, regexWorkersInUse, releaseSlot } from '../../src/store/regex-worker';

/**
 * Los huecos de hilos de expresiones regulares se reparten por biblioteca con turno rotatorio
 * (D22): una cuenta que encola 100 trabajos no retrasa a otra que encola 1. Se prueba el ORDEN
 * de concesión, no el tiempo.
 */
describe('huecos de hilos de expresiones regulares', () => {
  it('una biblioteca con 100 trabajos en cola no hace esperar a otra con 1', async () => {
    const heavy = {};
    const light = {};
    for (let i = 0; i < REGEX_WORKERS_MAX; i += 1) await acquireSlot(heavy);
    const granted: string[] = [];
    const waiting: Array<Promise<void>> = [];
    for (let i = 0; i < 100; i += 1) waiting.push(acquireSlot(heavy).then(() => { granted.push('heavy'); }));
    waiting.push(acquireSlot(light).then(() => { granted.push('light'); }));
    // Cada hueco que se suelta pasa al siguiente turno; se vuelve a soltar al instante.
    for (let i = 0; i < 101; i += 1) {
      releaseSlot();
      await Promise.resolve();
    }
    await Promise.all(waiting);
    expect(granted.indexOf('light')).toBeLessThanOrEqual(1);
    expect(granted).toHaveLength(101);
    // Nadie se queda sin turno: tras soltar los que quedan, no hay huecos ocupados.
    for (let i = 0; i < REGEX_WORKERS_MAX; i += 1) releaseSlot();
    expect(regexWorkersInUse()).toBe(0);
  });

  it('sin clave se comporta como una cola por orden de llegada', async () => {
    for (let i = 0; i < REGEX_WORKERS_MAX; i += 1) await acquireSlot();
    const granted: number[] = [];
    const waiting = [0, 1, 2].map((n) => acquireSlot().then(() => { granted.push(n); }));
    for (let i = 0; i < 3; i += 1) {
      releaseSlot();
      await Promise.resolve();
    }
    await Promise.all(waiting);
    expect(granted).toEqual([0, 1, 2]);
    for (let i = 0; i < REGEX_WORKERS_MAX; i += 1) releaseSlot();
    expect(regexWorkersInUse()).toBe(0);
  });
});
