/**
 * Render genérico de SVG a PNG (`B-LR20`), sin tipos de ningún formato: lo usan
 * `hebra_render_sheet` y `hebra_render_slide`.
 *
 * Qué hace aquí, en el hilo principal, antes de tocar el motor:
 *  - Mide el lado largo (1.568 px como mucho) y exige un `widthPx` dentro de rango.
 *  - Lee la CABECERA de cada imagen (sin decodificar) y omite las que pasan del tope de
 *    16 MP decodificados, contados en total por render. Una cabecera de 30 MP no llega
 *    nunca al motor.
 *  - Sanea el SVG: sin DOCTYPE ni entidades, sin `script` ni `foreignObject`, sin `url()`
 *    ni `href` que no sean internos (`#id`). La única imagen que se carga es `<image>` con
 *    `href="hebra-image:<id>"`, donde `<id>` es el de un `RenderImage` de la llamada; se
 *    sustituye por su `data:` y no hay red ni disco en ningún caso.
 *
 * El motor corre en un hilo (`./resvg-job.ts`) con plazo: al agotarse, o al abortar la
 * señal, `Worker.terminate()` lo corta en seco. Un render a la vez por proceso.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DOCUMENT_QUEUE_WAIT_MS,
  DOCUMENT_READ_TIMEOUT_MS,
  RENDER_LONG_SIDE_MAX_PX,
  RENDER_WIDTH_MAX_PX,
  RENDER_WIDTH_MIN_PX
} from '../store/document-limits';
import type { DocumentErrorCode } from '../store/document-types';
import { RENDER_JOB_SOURCE, RENDER_WORKER_HEAP_MB, type RenderJobIn, type RenderJobOut } from './resvg-job';

/** Megapíxeles decodificados por render (suma de todas las imágenes). */
export const RENDER_DECODED_MAX_PIXELS = 16 * 1024 * 1024;
/** Tamaño máximo del SVG de entrada. */
export const RENDER_SVG_MAX_BYTES = 8 * 1024 * 1024;
/** Prefijo del `href` con el que un SVG pide una imagen propia. */
export const RENDER_IMAGE_HREF_PREFIX = 'hebra-image:';
/** Variable de entorno con el directorio donde está `node_modules/@napi-rs/canvas` (hasta `B-LR21`). */
export const RENDER_MODULES_ENV = 'HEBRA_RENDER_MODULES';

export type RenderImage = {
  id: string;
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Uint8Array;
};

export type RenderImageOmitted = { id: string; reason: 'too_many_pixels' | 'unsupported' };

export type RenderSvgInput = {
  svg: Uint8Array;
  images: readonly RenderImage[];
  widthPx: number;
  signal: AbortSignal;
};

export type RenderSvgResult = {
  png: Uint8Array;
  width: number;
  height: number;
  imagesOmitted: RenderImageOmitted[];
  renderer: string;
};

/** Ajustes internos; los tests los usan para acortar el plazo o sustituir el hilo. */
export type RenderOptions = { timeoutMs?: number; queueWaitMs?: number; modulesDir?: string; jobSource?: string };

/** Fallo del render. Su `code` es de `DocumentErrorCode` y nunca lleva contenido del SVG. */
export class RenderError extends Error {
  constructor(readonly code: Extract<DocumentErrorCode, 'document_invalid' | 'document_too_complex' | 'document_busy' | 'file_unavailable'>) {
    super(code);
    this.name = 'RenderError';
  }
}

export const RENDERER_NAME = '@napi-rs/canvas 1.2.0';

// ---------- cabeceras: dimensiones sin decodificar ----------

type Dimensions = { format: RenderImage['mime']; width: number; height: number };

/** Lee ancho y alto del encabezado. `null` si no es un formato admitido o está truncado. */
export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { format: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') {
    return { format: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') {
      return { format: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
    if (kind === 'VP8 ') {
      return { format: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { format: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) {
        p += 1;
        continue;
      }
      const marker = b[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'image/jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      }
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  return null;
}

// ---------- saneado del SVG ----------

/** Cuerpo de una etiqueta: respeta `>` dentro de comillas. */
const TAG_BODY = `(?:"[^"]*"|'[^']*'|[^>"'])*`;
const HREF_ATTR = /\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function attrValue(tag: string, name: RegExp): string | null {
  const match = name.exec(tag);
  return match ? (match[1] ?? match[2] ?? '') : null;
}

/** Quita `script`, `foreignObject`, `url()` externos y todo `href` que no sea `#id`. */
function stripExternal(svg: string): string {
  let out = svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(?:script|foreignObject)\b[^>]*\/>/gi, '');
  out = out.replace(/url\(\s*(?!['"]?\s*#)[^)]*\)/gi, 'none');
  out = out.replace(new RegExp(`<([a-zA-Z][\\w:.-]*)(${TAG_BODY})>`, 'g'), (whole, name: string, body: string) => {
    if (name.toLowerCase() === 'image') return whole;
    const cleaned = body.replace(HREF_ATTR, (attr, dq: string | undefined, sq: string | undefined) =>
      (dq ?? sq ?? '').trimStart().startsWith('#') ? attr : ''
    );
    return cleaned === body ? whole : `<${name}${cleaned}>`;
  });
  return out;
}

/** Sustituye cada `<image>` por la propia incrustada o la elimina. */
function embedImages(svg: string, data: ReadonlyMap<string, string>): string {
  const pattern = new RegExp(`<image\\b(${TAG_BODY}?)(?:/>|>\\s*(?:</image\\s*>)?)`, 'gi');
  return svg.replace(pattern, (_whole, body: string) => {
    const href = attrValue(body, new RegExp(HREF_ATTR.source, 'i'));
    if (href === null || !href.startsWith(RENDER_IMAGE_HREF_PREFIX)) return '';
    const uri = data.get(href.slice(RENDER_IMAGE_HREF_PREFIX.length));
    if (uri === undefined) return '';
    const rest = body.replace(HREF_ATTR, '').replace(/\/\s*$/, '');
    return `<image${rest} href="${uri}"/>`;
  });
}

type RootInfo = { start: number; end: number; tag: string; width: number; height: number };

function lengthPx(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

function readRoot(svg: string): RootInfo {
  const match = new RegExp(`<svg\\b(${TAG_BODY})>`, 'i').exec(svg);
  if (!match) throw new RenderError('document_invalid');
  const tag = match[0];
  let width = lengthPx(attrValue(tag, /\swidth\s*=\s*(?:"([^"]*)"|'([^']*)')/i));
  let height = lengthPx(attrValue(tag, /\sheight\s*=\s*(?:"([^"]*)"|'([^']*)')/i));
  if (width === null || height === null) {
    const box = attrValue(tag, /\sviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const parts = box?.trim().split(/[\s,]+/).map(Number);
    if (!parts || parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new RenderError('document_invalid');
    width = parts[2];
    height = parts[3];
  }
  if (!(width > 0) || !(height > 0)) throw new RenderError('document_invalid');
  return { start: match.index, end: match.index + tag.length, tag, width, height };
}

/** Fija `width`, `height` y `viewBox` de la raíz al tamaño final del PNG. */
function resizeRoot(svg: string, root: RootInfo, width: number, height: number): string {
  const hasBox = /\sviewBox\s*=/i.test(root.tag);
  let tag = root.tag
    .replace(/\swidth\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\sheight\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s*\/?>$/, '');
  tag += ` width="${width}" height="${height}"`;
  if (!hasBox) tag += ` viewBox="0 0 ${root.width} ${root.height}"`;
  tag += '>';
  return svg.slice(0, root.start) + tag + svg.slice(root.end);
}

// ---------- un render a la vez ----------

let tail: Promise<void> = Promise.resolve();
let waiting = 0;

/** Cola de uno. Si el turno no llega en `waitMs`, `document_busy`. */
async function inTurn<T>(waitMs: number, signal: AbortSignal, job: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => (release = resolve));
  waiting += 1;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderError('document_busy')), waitMs);
        onAbort = () => reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } catch (error) {
    // No llegó su turno: el siguiente espera al anterior, no a este.
    void previous.then(release);
    throw error;
  } finally {
    waiting -= 1;
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  try {
    return await job();
  } finally {
    release();
  }
}

/** Trabajos esperando turno ahora mismo (para los tests). */
export function renderQueueLength(): number {
  return waiting;
}

function runJob(input: RenderJobIn, timeoutMs: number, signal: AbortSignal, source: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const worker = new Worker(source, {
      eval: true,
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: RENDER_WORKER_HEAP_MB },
      stdout: true,
      stderr: true
    });
    worker.unref();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new RenderError('document_too_complex'))), timeoutMs);
    const onAbort = (): void => finish(() => reject(signal.reason ?? new Error('aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (out: RenderJobOut) =>
      finish(() => {
        if (out.ok) resolve(out.png);
        else reject(new RenderError(out.reason === 'unavailable' ? 'file_unavailable' : 'document_invalid'));
      })
    );
    // Un fallo del hilo (memoria agotada incluida) no se confunde con un plazo.
    worker.on('error', () => finish(() => reject(new RenderError('document_too_complex'))));
    worker.on('exit', () => finish(() => reject(new RenderError('document_too_complex'))));
  });
}

/**
 * Pinta un SVG como PNG. `widthPx` va de 320 a 1.568; si el SVG es más alto que ancho, el
 * lado largo manda y el ancho final puede ser menor. Rechaza con `RenderError` (sin texto
 * del documento) o con `signal.reason` si se aborta.
 */
export async function renderSvgToPng(input: RenderSvgInput, options: RenderOptions = {}): Promise<RenderSvgResult> {
  const { svg: svgBytes, images, widthPx, signal } = input;
  if (!Number.isInteger(widthPx) || widthPx < RENDER_WIDTH_MIN_PX || widthPx > RENDER_WIDTH_MAX_PX) {
    throw new RenderError('document_invalid');
  }
  if (svgBytes.byteLength === 0 || svgBytes.byteLength > RENDER_SVG_MAX_BYTES) throw new RenderError('document_invalid');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(svgBytes);
  } catch {
    throw new RenderError('document_invalid');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new RenderError('document_invalid');

  // Imágenes: cabecera primero, y solo las que caben se incrustan.
  const imagesOmitted: RenderImageOmitted[] = [];
  const data = new Map<string, string>();
  let decodedPixels = 0;
  for (const image of images) {
    if (data.has(image.id)) continue;
    const dims = imageDimensions(image.bytes);
    if (!dims || dims.format !== image.mime || dims.width === 0 || dims.height === 0) {
      imagesOmitted.push({ id: image.id, reason: 'unsupported' });
      continue;
    }
    const pixels = dims.width * dims.height;
    if (decodedPixels + pixels > RENDER_DECODED_MAX_PIXELS) {
      imagesOmitted.push({ id: image.id, reason: 'too_many_pixels' });
      continue;
    }
    decodedPixels += pixels;
    data.set(image.id, `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`);
  }

  const root = readRoot(text);
  const scale = Math.min(widthPx / root.width, RENDER_LONG_SIDE_MAX_PX / Math.max(root.width, root.height));
  const width = Math.max(1, Math.round(root.width * scale));
  const height = Math.max(1, Math.round(root.height * scale));

  const clean = embedImages(stripExternal(resizeRoot(text, root, width, height)), data);
  const job: RenderJobIn = {
    svg: clean,
    width,
    height,
    modulesDir: options.modulesDir ?? process.env[RENDER_MODULES_ENV] ?? join(tmpdir(), 'hebra-render-modules')
  };
  const png = await inTurn(options.queueWaitMs ?? DOCUMENT_QUEUE_WAIT_MS, signal, () =>
    runJob(job, options.timeoutMs ?? DOCUMENT_READ_TIMEOUT_MS, signal, options.jobSource ?? RENDER_JOB_SOURCE)
  );
  return { png, width, height, imagesOmitted, renderer: RENDERER_NAME };
}
