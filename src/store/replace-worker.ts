/**
 * Las expresiones regulares de `hebra_replace_in_notes` (D14), en un hilo aparte que se
 * puede matar: el mismo diseño que `./regex-worker.ts` (`hebra_grep`, D13), y el MISMO
 * semáforo (`acquireSlot`/`releaseSlot`: como mucho `REGEX_WORKERS_MAX` hilos de
 * expresiones vivos en todo el proceso, sean del grep o del lote).
 *
 * Riesgo que cubre (audit `2026-10-10-sqlite-o-markdown.md` de Hebra): una expresión que
 * cuelga el servidor. La sustitución corre fuera del bucle de eventos (el servidor sigue
 * atendiendo) y `Worker.terminate()` la corta en seco al agotarse el plazo. El hilo
 * sustituye con `replaceBodyLines` (`./replace.ts`), con su propio código fuente, así que
 * hace exactamente lo mismo que un literal en el hilo principal.
 *
 * Solo lo usa la SIMULACIÓN: aplicar no ejecuta ninguna expresión (escribe el cuerpo
 * resultante que la simulación guardó).
 */
import { Worker } from 'node:worker_threads';
import { acquireSlot, releaseSlot } from './regex-worker';
import { replaceBodyLines, type ReplaceLinesResult, type ReplacementPart } from './replace';

/** Memoria del hilo: un lote de cuerpos y sus resultados caben de sobra. */
const WORKER_HEAP_MB = 256;

/** `onNote` decide si seguir (`true`) o parar (`false`). */
export type OnReplaced = (index: number, result: ReplaceLinesResult) => boolean;

/** Como `ScanOutcome` de `./regex-worker.ts`: `done`, `stopped` (lo pidió `onNote`) o
 *  `interrupted` (plazo o fallo A MITAD de la nota `next`; las de antes ya pasaron por
 *  `onNote`). */
export type ReplaceOutcome =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'interrupted'; next: number };

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const replaceBodyLines = ${replaceBodyLines.toString()};
const re = new RegExp(workerData.source, workerData.flags);
const parts = workerData.parts;
parentPort.on('message', (batch) => {
  for (let index = 0; index < batch.bodies.length; index += 1) {
    let result;
    try {
      result = replaceBodyLines(batch.bodies[index], re, parts, batch.maxChanges);
    } catch {
      parentPort.postMessage({ batch: batch.id, failed: index });
      return;
    }
    parentPort.postMessage({ batch: batch.id, index, result });
  }
  parentPort.postMessage({ batch: batch.id, done: true });
});
`;

export class RegexReplaceWorker {
  private readonly worker: Worker;
  private batchId = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private failure: (() => void) | null = null;

  /** Espera un hueco del semáforo compartido y arranca el hilo; `close` lo devuelve. */
  static async start(re: RegExp, parts: readonly ReplacementPart[]): Promise<RegexReplaceWorker> {
    await acquireSlot();
    try {
      return new RegexReplaceWorker(re, parts);
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  private constructor(re: RegExp, parts: readonly ReplacementPart[]) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: re.source, flags: re.flags, parts },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      stdout: true,
      stderr: true
    });
    this.worker.unref();
    this.worker.on('error', () => this.failure?.());
    this.worker.on('exit', () => this.failure?.());
  }

  /**
   * Sustituye en `bodies`, en orden, y llama a `onNote` con cada una terminada. Nunca
   * rechaza: al llegar `deadline` (epoch ms) o si el hilo falla, lo mata y responde
   * `interrupted` con la nota que estaba sustituyendo. Tras eso, el hilo ya no sirve.
   */
  replace(
    bodies: readonly string[],
    maxChanges: number,
    deadline: number,
    onNote: OnReplaced
  ): Promise<ReplaceOutcome> {
    if (this.closed) return Promise.resolve({ status: 'interrupted', next: 0 });
    this.batchId += 1;
    const id = this.batchId;
    return new Promise<ReplaceOutcome>((resolve) => {
      let settled = false;
      let completed = 0;
      const finish = (outcome: ReplaceOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        this.failure = null;
        resolve(outcome);
      };
      const interrupt = (next: number): void => {
        void this.close();
        finish({ status: 'interrupted', next });
      };
      const onMessage = (message: {
        batch: number;
        index?: number;
        result?: ReplaceLinesResult;
        done?: boolean;
        failed?: number;
      }): void => {
        if (message.batch !== id || settled) return;
        if (message.done) {
          finish({ status: 'done' });
          return;
        }
        if (message.failed !== undefined) {
          interrupt(message.failed);
          return;
        }
        completed = message.index! + 1;
        if (!onNote(message.index!, message.result!)) finish({ status: 'stopped' });
      };
      const timer = setTimeout(() => interrupt(completed), Math.max(0, deadline - Date.now()));
      this.failure = () => interrupt(completed);
      this.worker.on('message', onMessage);
      this.worker.postMessage({ id, bodies, maxChanges });
    });
  }

  /** Mata el hilo y suelta su hueco. Idempotente. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.failure = null;
      try {
        await this.worker.terminate();
      } finally {
        releaseSlot();
      }
    })();
    return this.closing;
  }
}
