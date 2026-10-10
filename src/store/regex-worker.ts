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

/** `done`: recorrió todas; `stopped`: `onNote` pidió parar; `time`: se agotó el plazo ENTRE
 *  dos notas y `next` es la primera sin recorrer; `interrupted`: el hilo se mató (plazo) o
 *  falló A MITAD de la nota `next`, que queda sin terminar. En los dos últimos, las de antes
 *  de `next` ya pasaron por `onNote`. */
export type ScanOutcome =
  | { status: 'done' }
  | { status: 'stopped' }
  | { status: 'time'; next: number }
  | { status: 'interrupted'; next: number };

const WORKER_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const scanBody = ${scanBody.toString()};
const re = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (batch) => {
  let left = batch.maxHits;
  for (let index = 0; index < batch.notes.length && left > 0; index += 1) {
    const note = batch.notes[index];
    let result;
    try {
      result = scanBody(note.body, re, note.fromLine, left, false);
    } catch {
      parentPort.postMessage({ batch: batch.id, failed: index });
      return;
    }
    left -= result.hits.length / 2;
    parentPort.postMessage({ batch: batch.id, index, hits: result.hits, next: result.next });
  }
  parentPort.postMessage({ batch: batch.id, done: true });
});
`;

/** Hilos de expresiones regulares vivos a la vez, como mucho, en todo el proceso: cada uno
 *  puede ocupar un núcleo y hasta `WORKER_HEAP_MB`. Una llamada más espera su turno, y esa
 *  espera no cuenta para su plazo (que empieza al tener el hilo). */
export const REGEX_WORKERS_MAX = 3;

let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (slotsInUse < REGEX_WORKERS_MAX) {
    slotsInUse += 1;
    return Promise.resolve();
  }
  // El que suelta un hueco se lo pasa directamente al primero que espera.
  return new Promise<void>((resolve) => slotWaiters.push(resolve));
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) next();
  else slotsInUse -= 1;
}

/** Huecos ocupados (hilos arrancados y aún sin terminar de cerrar). Para los tests. */
export function regexWorkersInUse(): number {
  return slotsInUse;
}

export class RegexScanWorker {
  private readonly worker: Worker;
  private batchId = 0;
  private closed = false;
  /** El cierre en curso o hecho: cerrar dos veces espera al mismo, y el hueco se suelta una vez. */
  private closing: Promise<void> | null = null;
  private failure: (() => void) | null = null;

  /** Espera un hueco (`REGEX_WORKERS_MAX`) y arranca el hilo; `close` lo devuelve. */
  static async start(re: RegExp): Promise<RegexScanWorker> {
    await acquireSlot();
    try {
      return new RegexScanWorker(re);
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }

  private constructor(re: RegExp) {
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source: re.source, flags: re.flags },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      stdout: true,
      stderr: true
    });
    this.worker.unref();
    // Sin oyente, un `error` del hilo (sin memoria, por ejemplo) tumbaría el proceso; se
    // reenvía al lote en curso, igual que una salida inesperada.
    this.worker.on('error', () => this.failure?.());
    this.worker.on('exit', () => this.failure?.());
  }

  /**
   * Recorre `notes` en el hilo, en orden, como mucho `maxHits` líneas con coincidencia en
   * total, y llama a `onNote` con cada nota terminada. Nunca rechaza: si llega `deadline`
   * (epoch ms) o el hilo falla (una excepción de la expresión, como un desbordamiento de
   * pila de V8, o quedarse sin memoria), mata el hilo y responde `interrupted` con la nota
   * que estaba recorriendo; lo ya entregado por `onNote` vale. Quien llama decide qué hacer
   * con esa nota (cortar en ella o saltarla, `runGrep`). Tras un `interrupted`, el hilo ya
   * no sirve.
   */
  scan(
    notes: readonly ScanNote[],
    maxHits: number,
    deadline: number,
    onNote: OnNote
  ): Promise<ScanOutcome> {
    if (this.closed) return Promise.resolve({ status: 'interrupted', next: 0 });
    this.batchId += 1;
    const id = this.batchId;
    return new Promise<ScanOutcome>((resolve) => {
      let settled = false;
      let completed = 0;
      const finish = (outcome: ScanOutcome): void => {
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
        hits?: number[];
        next?: number;
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
        if (!onNote(message.index!, { hits: message.hits!, next: message.next! })) {
          finish({ status: 'stopped' });
        }
      };
      const timer = setTimeout(() => interrupt(completed), Math.max(0, deadline - Date.now()));
      this.failure = () => interrupt(completed);
      this.worker.on('message', onMessage);
      this.worker.postMessage({ id, notes, maxHits });
    });
  }

  /** Mata el hilo (también si está en mitad de una expresión) y suelta su hueco.
   *  Idempotente: todas las llamadas esperan al mismo cierre. */
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
