/**
 * El trabajo de render, en un hilo aparte que se puede matar (mismo diseño que
 * `../store/replace-worker.ts`). El nombre es el de la ficha (`B-LR20`, pensada para resvg);
 * el motor es `@napi-rs/canvas` 1.2.0 (sonda `B-LR03`: resvg-wasm no pinta GIF ni WebP).
 *
 * El hilo recibe un SVG ya saneado por `./render.ts` (sin red, con las imágenes propias
 * incrustadas como `data:`) y devuelve el PNG. Skia no abre `file:` ni `http:`, pero eso no
 * se da por bueno aquí: el saneado lo hace el hilo principal antes de que el SVG llegue.
 *
 * El paquete nativo se resuelve desde un directorio aparte (`modulesDir`) hasta que `B-LR21`
 * lo meta en `dependencies`. Es código fuente en cadena, como en `replace-worker`, para
 * que el hilo no dependa de cómo se empaquete el resto del servidor.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DOCUMENT_WORKER_HEAP_MAX_BYTES } from '../store/document-limits';

/** Memoria del hilo para el montón de JS (la nativa de Skia no cuenta aquí). */
export const RENDER_WORKER_HEAP_MB = DOCUMENT_WORKER_HEAP_MAX_BYTES / (1024 * 1024);

/** Lo que recibe el hilo. */
export type RenderJobIn = { svg: string; width: number; height: number; modulesDir: string };

/** Lo que devuelve el hilo: el PNG o un fallo sin texto del documento. */
export type RenderJobOut = { ok: true; png: Uint8Array } | { ok: false; reason: 'unavailable' | 'failed' };

export const RENDER_JOB_SOURCE = `'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { join } = require('node:path');
(async () => {
  let canvas;
  try {
    canvas = createRequire(join(workerData.modulesDir, 'x.js'))('@napi-rs/canvas');
  } catch {
    parentPort.postMessage({ ok: false, reason: 'unavailable' });
    return;
  }
  try {
    const image = await canvas.loadImage(Buffer.from(workerData.svg, 'utf8'));
    const surface = canvas.createCanvas(workerData.width, workerData.height);
    const context = surface.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, workerData.width, workerData.height);
    context.drawImage(image, 0, 0, workerData.width, workerData.height);
    const png = await surface.encode('png');
    const copy = new Uint8Array(png.length);
    copy.set(png);
    parentPort.postMessage({ ok: true, png: copy }, [copy.buffer]);
  } catch {
    parentPort.postMessage({ ok: false, reason: 'failed' });
  }
})();
`;

/**
 * Entrada para `src/document-worker.ts` (`kind: 'render'`): pinta dentro del hilo que ya
 * lanzó `runDocumentJob`, que es quien lo mata. Mismo trabajo que `RENDER_JOB_SOURCE`.
 * Rechaza con un `Error` sin texto del documento.
 */
export async function run(input: RenderJobIn): Promise<Uint8Array> {
  let canvas: any;
  try {
    canvas = createRequire(join(input.modulesDir, 'x.js'))('@napi-rs/canvas');
  } catch {
    throw new Error('render_unavailable');
  }
  const image = await canvas.loadImage(Buffer.from(input.svg, 'utf8'));
  const surface = canvas.createCanvas(input.width, input.height);
  const context = surface.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, input.width, input.height);
  context.drawImage(image, 0, 0, input.width, input.height);
  return new Uint8Array(await surface.encode('png'));
}
