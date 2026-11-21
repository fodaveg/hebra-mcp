import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ContextUnavailableError, type AdmissionTicket } from '../../src/accounts/capacity';
import {
  RENDER_IMAGE_HREF_PREFIX,
  RENDER_MODULES_ENV,
  RenderError,
  imageDimensions,
  renderReserveBytes,
  renderSvgToPng,
  type RenderImage,
  type RenderSvgInput
} from '../../src/render/render';

/**
 * `B-LR20` y `B-LR21`. El motor (`@napi-rs/canvas` 1.2.0) está en `dependencies`: se resuelve
 * desde el `node_modules` del repo, o desde `HEBRA_RENDER_MODULES` si se pone. Si el paquete
 * no se puede cargar (otra plataforma sin su binario), los tests que pintan de verdad se
 * saltan y el resto (cabeceras, saneado, plazo, abortos, reserva) corre igual.
 */
const MODULES = process.env[RENDER_MODULES_ENV] ?? process.cwd();
function engineAvailable(): boolean {
  try {
    createRequire(join(MODULES, 'x.js'))('@napi-rs/canvas');
    return true;
  } catch {
    return false;
  }
}
const withEngine = engineAvailable() ? it : it.skip;

const never = new AbortController().signal;

/** Compuerta de pruebas: apunta cada reserva y cuántas siguen sin soltar. */
function fakeGate(refuse = false) {
  const asked: number[] = [];
  let pending = 0;
  return {
    asked,
    get pending(): number {
      return pending;
    },
    admit: async (_signal?: AbortSignal, bytes?: number): Promise<AdmissionTicket> => {
      if (refuse) throw new ContextUnavailableError('capacity_wait_timeout', 1);
      asked.push(bytes ?? 0);
      pending += 1;
      let released = false;
      return {
        done: () => {
          if (released) return;
          released = true;
          pending -= 1;
        }
      } as AdmissionTicket;
    }
  };
}

/** La compuerta y la cuenta que exige `RenderSvgInput`. */
const held = (gate: ReturnType<typeof fakeGate> = fakeGate()): Pick<RenderSvgInput, 'gate' | 'key'> => ({ gate, key: 'a' });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** PNG real, vacío de datos útiles pero válido para el motor: lo crea el propio motor. */
async function realPng(width: number, height: number): Promise<RenderImage> {
  const canvas = createRequire(join(MODULES, 'x.js'))('@napi-rs/canvas');
  const surface = canvas.createCanvas(width, height);
  const context = surface.getContext('2d');
  context.fillStyle = '#d00000';
  context.fillRect(0, 0, width, height);
  return { id: 'rojo', mime: 'image/png', bytes: new Uint8Array(await surface.encode('png')) };
}

/** Cabecera PNG con las dimensiones dadas y sin datos: lo bastante para medirla. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return new Uint8Array(b);
}

const frame = (inner: string, w = 400, h = 300): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${inner}</svg>`;

/** Mira un píxel del PNG resultante con el propio motor. */
async function pixel(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const canvas = createRequire(join(MODULES, 'x.js'))('@napi-rs/canvas');
  const img = await canvas.loadImage(Buffer.from(png));
  const surface = canvas.createCanvas(img.width, img.height);
  const context = surface.getContext('2d');
  context.drawImage(img, 0, 0);
  return Array.from(context.getImageData(x, y, 1, 1).data as Uint8ClampedArray);
}

describe('cabeceras de imagen', () => {
  it('mide un PNG sin decodificarlo y rechaza lo desconocido', () => {
    expect(imageDimensions(pngHeader(6000, 5000))).toEqual({ format: 'image/png', width: 6000, height: 5000 });
    expect(imageDimensions(new Uint8Array(40))).toBeNull();
    expect(imageDimensions(new Uint8Array(3))).toBeNull();
  });
});

describe('renderSvgToPng: entradas', () => {
  it('rechaza un ancho fuera de rango, un SVG vacío y un DOCTYPE', async () => {
    await expect(renderSvgToPng({ svg: enc(frame('')), images: [], widthPx: 100, signal: never, ...held() })).rejects.toMatchObject({
      code: 'document_invalid'
    });
    await expect(renderSvgToPng({ svg: new Uint8Array(0), images: [], widthPx: 960, signal: never, ...held() })).rejects.toBeInstanceOf(
      RenderError
    );
    const hostile = '<!DOCTYPE svg [<!ENTITY a "b">]>' + frame('<text>&a;</text>');
    await expect(renderSvgToPng({ svg: enc(hostile), images: [], widthPx: 960, signal: never, ...held() })).rejects.toMatchObject({
      code: 'document_invalid'
    });
  });

  it('un error no repite contenido del SVG', async () => {
    const secreto = 'CONTENIDO-SECRETO-123';
    const error = (await renderSvgToPng({
      svg: enc(`<!DOCTYPE x>${secreto}`),
      images: [],
      widthPx: 960,
      signal: never,
      ...held()
    }).catch((e: unknown) => e)) as RenderError;
    expect(JSON.stringify({ code: error.code, message: error.message })).not.toContain(secreto);
  });
});

describe('renderSvgToPng: imágenes', () => {
  it('una cabecera de 30 MP se omite sin llegar al motor', async () => {
    // Con un motor inexistente, si la imagen llegara a decodificarse no habría forma de pintarla:
    // aquí solo importa que se declare omitida ANTES. El render sin imagen sigue su curso.
    const big: RenderImage = { id: 'enorme', mime: 'image/png', bytes: pngHeader(6000, 5000) };
    const svg = frame(`<image href="${RENDER_IMAGE_HREF_PREFIX}enorme" x="0" y="0" width="100" height="100"/>`);
    const result = await renderSvgToPng(
      { svg: enc(svg), images: [big], widthPx: 960, signal: never, ...held() },
      { jobSource: "require('node:worker_threads').parentPort.postMessage({ ok: true, png: new Uint8Array([1]) });" }
    );
    expect(result.imagesOmitted).toEqual([{ id: 'enorme', reason: 'too_many_pixels' }]);
  });

  it('16 MP exactos pasan; la suma por encima de 16 MP omite la que rebasa', async () => {
    const ok: RenderImage = { id: 'a', mime: 'image/png', bytes: pngHeader(4096, 4096) };
    const extra: RenderImage = { id: 'b', mime: 'image/png', bytes: pngHeader(10, 10) };
    const result = await renderSvgToPng(
      { svg: enc(frame('')), images: [ok, extra], widthPx: 960, signal: never, ...held() },
      { jobSource: "require('node:worker_threads').parentPort.postMessage({ ok: true, png: new Uint8Array([1]) });" }
    );
    expect(result.imagesOmitted).toEqual([{ id: 'b', reason: 'too_many_pixels' }]);
  });

  it('un tipo que no coincide con la cabecera es unsupported', async () => {
    const lie: RenderImage = { id: 'x', mime: 'image/jpeg', bytes: pngHeader(10, 10) };
    const result = await renderSvgToPng(
      { svg: enc(frame('')), images: [lie, { id: 'y', mime: 'image/gif', bytes: new Uint8Array(5) }], widthPx: 960, signal: never, ...held() },
      { jobSource: "require('node:worker_threads').parentPort.postMessage({ ok: true, png: new Uint8Array([1]) });" }
    );
    expect(result.imagesOmitted).toEqual([
      { id: 'x', reason: 'unsupported' },
      { id: 'y', reason: 'unsupported' }
    ]);
  });
});

describe('renderSvgToPng: saneado (lo que recibe el motor)', () => {
  /** Hilo falso que devuelve el SVG recibido como "PNG", para inspeccionarlo. */
  const echo = "const { parentPort, workerData } = require('node:worker_threads'); parentPort.postMessage({ ok: true, png: new TextEncoder().encode(workerData.svg) });";

  it('href hostil: ni red, ni disco, ni SVG incrustado, ni url() externo', async () => {
    const hostile = frame(
      [
        '<image href="http://127.0.0.1:9/x.png" width="10" height="10"/>',
        '<image xlink:href="file:///etc/passwd" width="10" height="10"></image>',
        '<image href="data:image/svg+xml;base64,PHN2Zy8+" width="10" height="10"/>',
        '<image href="javascript:alert(1)" width="10" height="10"/>',
        `<image href="${RENDER_IMAGE_HREF_PREFIX}no-existe" width="10" height="10"/>`,
        '<use href="http://evil.test/a.svg#x"/>',
        '<a xlink:href="https://evil.test/"><rect width="5" height="5"/></a>',
        '<rect width="5" height="5" style="fill:url(http://evil.test/p)" fill="url(file:///x)"/>',
        '<script>alert(1)</script>',
        '<foreignObject><div>hola</div></foreignObject>',
        '<use href="#local"/>'
      ].join('')
    );
    const result = await renderSvgToPng({ svg: enc(hostile), images: [], widthPx: 960, signal: never, ...held() }, { jobSource: echo });
    // Los espacios de nombres de la raíz son identificadores, no direcciones que se abran.
    const seen = new TextDecoder().decode(result.png).replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
    expect(seen).not.toMatch(/http:|https:|file:|javascript:|data:image\/svg|<image|<script|foreignObject|evil/i);
    expect(seen).toContain('<use href="#local"');
  });

  it('una imagen propia se incrusta como data: y las demás no', async () => {
    const own: RenderImage = { id: 'mia', mime: 'image/png', bytes: pngHeader(10, 10) };
    const svg = frame(
      `<image href="${RENDER_IMAGE_HREF_PREFIX}mia" x="1" y="2" width="10" height="10"/><image href="https://x.test/a.png" width="1" height="1"/>`
    );
    const result = await renderSvgToPng({ svg: enc(svg), images: [own], widthPx: 960, signal: never, ...held() }, { jobSource: echo });
    const seen = new TextDecoder().decode(result.png);
    expect(seen.match(/<image/g)).toHaveLength(1);
    expect(seen).toContain('href="data:image/png;base64,');
    expect(seen).not.toContain('x.test');
  });

  it('el tamaño final respeta el lado largo de 1.568 px', async () => {
    const tall = await renderSvgToPng({ svg: enc(frame('', 100, 1000)), images: [], widthPx: 960, signal: never, ...held() }, { jobSource: echo });
    expect(tall.height).toBe(1568);
    expect(tall.width).toBe(157);
    const wide = await renderSvgToPng({ svg: enc(frame('', 800, 400)), images: [], widthPx: 960, signal: never, ...held() }, { jobSource: echo });
    expect([wide.width, wide.height]).toEqual([960, 480]);
  });
});

describe('renderSvgToPng: plazo, aborto y cola', () => {
  it('un hilo que no acaba termina con terminate() y document_too_complex', async () => {
    const started = Date.now();
    await expect(
      renderSvgToPng({ svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held() }, { timeoutMs: 300, jobSource: 'for (;;) {}' })
    ).rejects.toMatchObject({ code: 'document_too_complex' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('abortar la señal corta el hilo', async () => {
    const controller = new AbortController();
    const pending = renderSvgToPng(
      { svg: enc(frame('')), images: [], widthPx: 960, signal: controller.signal, ...held() },
      { timeoutMs: 20_000, jobSource: 'for (;;) {}' }
    );
    setTimeout(() => controller.abort(new Error('cancelado')), 100);
    await expect(pending).rejects.toThrow('cancelado');
  });

  it('un segundo render que no consigue turno responde document_busy', async () => {
    const first = renderSvgToPng(
      { svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held() },
      { timeoutMs: 800, jobSource: 'for (;;) {}' }
    ).catch((e: unknown) => e);
    const second = renderSvgToPng(
      { svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held() },
      { queueWaitMs: 100, jobSource: 'for (;;) {}' }
    );
    await expect(second).rejects.toMatchObject({ code: 'document_busy' });
    expect(await first).toMatchObject({ code: 'document_too_complex' });
  });

  it('sin el paquete del motor responde file_unavailable', async () => {
    await expect(
      renderSvgToPng({ svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held() }, { modulesDir: join(tmpdir(), 'no-existe-render') })
    ).rejects.toMatchObject({ code: 'file_unavailable' });
  });
});

describe('renderSvgToPng: reserva en la compuerta (B-LR21)', () => {
  const okJob = "require('node:worker_threads').parentPort.postMessage({ ok: true, png: new Uint8Array([1]) });";

  it('aparta antes de pintar, según los píxeles, y suelta al acabar', async () => {
    const gate = fakeGate();
    const own: RenderImage = { id: 'i', mime: 'image/png', bytes: pngHeader(1000, 1000) };
    const result = await renderSvgToPng(
      { svg: enc(frame('')), images: [own], widthPx: 960, signal: never, ...held(gate) },
      { jobSource: okJob }
    );
    expect(gate.asked).toEqual([renderReserveBytes(1000 * 1000, result.width, result.height)]);
    expect(gate.pending).toBe(0);
    expect(renderReserveBytes(16 * 1024 * 1024, 1568, 882)).toBeGreaterThan(renderReserveBytes(0, 1568, 882));
  });

  it('suelta la reserva por plazo, por aborto y cuando el hilo falla', async () => {
    const gate = fakeGate();
    await expect(
      renderSvgToPng({ svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held(gate) }, { timeoutMs: 200, jobSource: 'for (;;) {}' })
    ).rejects.toMatchObject({ code: 'document_too_complex' });
    expect(gate.pending).toBe(0);
    const controller = new AbortController();
    const waiting = renderSvgToPng(
      { svg: enc(frame('')), images: [], widthPx: 960, signal: controller.signal, ...held(gate) },
      { timeoutMs: 20_000, jobSource: 'for (;;) {}' }
    );
    setTimeout(() => controller.abort(new Error('cancelado')), 100);
    await expect(waiting).rejects.toThrow('cancelado');
    expect(gate.pending).toBe(0);
    await expect(
      renderSvgToPng(
        { svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held(gate) },
        { jobSource: "require('node:worker_threads').parentPort.postMessage({ ok: false, reason: 'failed' });" }
      )
    ).rejects.toMatchObject({ code: 'document_invalid' });
    expect(gate.pending).toBe(0);
    expect(gate.asked).toHaveLength(3);
  });

  it('sin hueco en la compuerta responde document_busy y no arranca el hilo', async () => {
    const gate = fakeGate(true);
    await expect(
      renderSvgToPng(
        { svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held(gate) },
        { jobSource: "throw new Error('no debe arrancar');" }
      )
    ).rejects.toMatchObject({ code: 'document_busy' });
    expect(gate.pending).toBe(0);
  });
});

describe('renderSvgToPng: con el motor real', () => {
  withEngine('pinta una imagen propia y dibujos, y sigue sirviendo tras un href hostil y un hilo muerto', async () => {
    const own = await realPng(40, 40);
    const svg = frame(
      `<image href="${RENDER_IMAGE_HREF_PREFIX}rojo" x="0" y="0" width="100" height="100"/><image href="http://127.0.0.1:9/x.png" x="200" y="0" width="100" height="100"/><rect x="300" y="200" width="50" height="50" fill="#0000ff"/>`
    );
    // Un render muerto por plazo antes: el siguiente debe salir bien.
    await expect(
      renderSvgToPng({ svg: enc(frame('')), images: [], widthPx: 960, signal: never, ...held() }, { timeoutMs: 200, jobSource: 'for (;;) {}' })
    ).rejects.toMatchObject({ code: 'document_too_complex' });

    const result = await renderSvgToPng({ svg: enc(svg), images: [own], widthPx: 800, signal: never, ...held() }, { modulesDir: MODULES });
    expect(result).toMatchObject({ width: 800, height: 600, imagesOmitted: [], renderer: '@napi-rs/canvas 1.2.0' });
    expect(Buffer.from(result.png).subarray(1, 4).toString('latin1')).toBe('PNG');
    const red = await pixel(result.png, 100, 100);
    expect(red.slice(0, 3)).toEqual([208, 0, 0]);
    const white = await pixel(result.png, 500, 100);
    expect(white.slice(0, 3)).toEqual([255, 255, 255]);
    const blue = await pixel(result.png, 650, 450);
    expect(blue.slice(0, 3)).toEqual([0, 0, 255]);
  });

  withEngine('pinta GIF y WebP que resvg no pintaba', async () => {
    const canvas = createRequire(join(MODULES, 'x.js'))('@napi-rs/canvas');
    for (const [mime, format] of [['image/gif', 'gif'], ['image/webp', 'webp']] as const) {
      const surface = canvas.createCanvas(20, 20);
      const context = surface.getContext('2d');
      context.fillStyle = '#00a000';
      context.fillRect(0, 0, 20, 20);
      const bytes = new Uint8Array(await surface.encode(format));
      const svg = frame(`<image href="${RENDER_IMAGE_HREF_PREFIX}i" x="0" y="0" width="100" height="100"/>`);
      const result = await renderSvgToPng(
        { svg: enc(svg), images: [{ id: 'i', mime, bytes }], widthPx: 400, signal: never, ...held() },
        { modulesDir: MODULES }
      );
      expect(result.imagesOmitted).toEqual([]);
      const px = await pixel(result.png, 50, 50);
      expect(px[1]).toBeGreaterThan(100);
      expect(px[0]).toBeLessThan(60);
    }
  });
});
