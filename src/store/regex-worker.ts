/**
 * Las expresiones regulares de `hebra_grep` (D13), en un hilo aparte (`worker_threads`)
 * que se puede matar.
 *
 * Por qué un hilo y no restringir la sintaxis (riesgo del audit `2026-10-10-sqlite-o-
 * markdown.md` de Hebra: «una expresión regular que cuelga el servidor»): el motor de V8
 * es de retroceso, y una expresión corta y de aspecto inocente (`(a+)+$`, `(\w+\s?)+$`,
 * `(a|a)*b`) tarda un tiempo exponencial en la línea equivocada. Decidir de antemano qué
 * expresiones son seguras no tiene una regla que no deje pasar alguna (ni que no rechace
 * expresiones normales), y el motor lineal de V8 sigue siendo experimental y por bandera
 * del proceso. En un hilo, la expresión corre fuera del bucle de eventos del servidor (que
 * sigue atendiendo mientras tanto) y `Worker.terminate()` la corta en seco al agotarse el
 * tiempo, sea cual sea: medido, en un milisegundo con `(a+)+$` sobre 40 `a` y un `!`.
 *
 * El hilo recorre las líneas con `scanBody` (`./grep.ts`), con su propio código fuente
 * (`scanBody.toString()`), así que casa exactamente igual que un literal en el hilo
 * principal. Un hilo por llamada de `hebra_grep` con expresión regular (arrancarlo cuesta
 * unos 12 ms medidos), que se cierra al terminar: entre llamadas no queda nada vivo.
 */
import { Worker } from 'node:worker_threads';
import { scanBody } from './grep';

/** Memoria del hilo: los cuerpos de un lote y sus resultados caben de sobra. */
const WORKER_HEAP_MB = 256;

/** Una nota que recorrer: su cuerpo y la línea (1-based) por la que empezar. */
export interface ScanNote {
  body: string;
  fromLine: number;
}

/** Lo que `scanBody` devuelve de una nota. */
export interface ScanResult {
  hits: number[];
  next: number;
}

/** `onNote` decide si seguir (`true`) o parar (`false`: página llena o respuesta llena). */
export type OnNote = (index: number, result: ScanResult) => boolean;

/** `done`: recorrió todas; `stopped`: `onNote` pidió parar; `time`: se agotó el plazo y
 *  `next` es la primera nota sin recorrer (las de antes ya pasaron por `onNote`). */
export type ScanOutcome =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'time'; next: number };

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const scanBody = ${scanBody.toString()};
const re = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (batch) => {
  let left = batch.maxHits;
  for (let index = 0; index < batch.notes.length && left > 0; index += 1) {
    const note = batch.notes[index];
    const result = scanBody(note.body, re, note.fromLine, left, false);
    left -= result.hits.length / 2;
    parentPort.postMessage({ batch: batch.id, index, hits: result.hits, next: result.next });
  }
  parentPort.postMessage({ batch: batch.id, done: true });
});
`;

/** El fallo del hilo (una excepción de la expresión, como un desbordamiento de pila de
 *  V8, o quedarse sin memoria): quien llama lo trata como una expresión demasiado cara. */
export class RegexWorkerFailed extends Error {
  constructor() {
    super('regex_worker_failed');
    this.name = 'RegexWorkerFailed';
  }
}

export class RegexScanWorker {
  private readonly worker: Worker;
  private batchId = 0;
  private closed = false;
  private failure: ((error: Error) => void) | null = null;

  constructor(re: RegExp) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: re.source, flags: re.flags },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      stdout: true,
      stderr: true
    });
    this.worker.unref();
    // Sin oyente, un `error` del hilo tumbaría el proceso; se reenvía al lote en curso.
    this.worker.on('error', () => this.failure?.(new RegexWorkerFailed()));
    this.worker.on('exit', () => this.failure?.(new RegexWorkerFailed()));
  }

  /**
   * Recorre `notes` en el hilo, en orden, como mucho `maxHits` líneas con coincidencia en
   * total, y llama a `onNote` con cada nota terminada. Al llegar `deadline` (epoch ms),
   * si `mayCut()` dice que esta llamada ya avanzó, mata el hilo y responde `time`; si no,
   * también lo mata, pero rechaza con `RegexWorkerFailed` (ni una nota en todo el plazo:
   * la expresión es demasiado cara, y cortar sin avanzar dejaría un cursor que nunca
   * avanza). Tras un `time` o un fallo, el hilo ya no sirve.
   */
  scan(
    notes: readonly ScanNote[],
    maxHits: number,
    deadline: number,
    mayCut: () => boolean,
    onNote: OnNote
  ): Promise<ScanOutcome> {
    if (this.closed) return Promise.reject(new RegexWorkerFailed());
    this.batchId += 1;
    const id = this.batchId;
    return new Promise<ScanOutcome>((resolve, reject) => {
      let settled = false;
      let completed = 0;
      const finish = (outcome: ScanOutcome | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        this.failure = null;
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      const onMessage = (message: {
        batch: number;
        index?: number;
        hits?: number[];
        next?: number;
        done?: boolean;
      }): void => {
        if (message.batch !== id) return;
        if (message.done) {
          finish({ status: 'done' });
          return;
        }
        completed = message.index! + 1;
        if (!onNote(message.index!, { hits: message.hits!, next: message.next! })) {
          finish({ status: 'stopped' });
        }
      };
      const timer = setTimeout(
        () => {
          const progressed = mayCut();
          void this.close();
          finish(progressed ? { status: 'time', next: completed } : new RegexWorkerFailed());
        },
        Math.max(0, deadline - Date.now())
      );
      this.failure = (error) => {
        void this.close();
        finish(error);
      };
      this.worker.on('message', onMessage);
      this.worker.postMessage({ id, notes, maxHits });
    });
  }

  /** Mata el hilo (también si está en mitad de una expresión). Idempotente. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failure = null;
    await this.worker.terminate();
  }
}
