/**
 * El trabajo de render, en un hilo aparte que se puede matar (mismo diseño que
 * `../store/replace-worker.ts`). El nombre es el de la ficha (`B-LR20`, pensada para resvg);
 * el motor es `@napi-rs/canvas` 1.2.0 (sonda `B-LR03`: resvg-wasm no pinta GIF ni WebP).
 *
 * El hilo recibe un SVG ya saneado por `./render.ts` (sin red, con las imágenes propias
 * incrustadas como `data:`) y devuelve el PNG. Skia no abre `file:` ni `http:`, pero eso no
 * se da por bueno aquí: el saneado lo hace el hilo principal antes de que el SVG llegue.
 *
 * El paquete nativo (`@napi-rs/canvas`, en `dependencies` desde `B-LR21`) se resuelve desde
 * `modulesDir`, que por defecto es la carpeta de este módulo (en `dist/` sube a `node_modules`
 * de la imagen). Es el ÚNICO camino de pintado: es código fuente en cadena, como en
 * `replace-worker`, para que el hilo no dependa de cómo se empaquete el resto del servidor.
 */
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
