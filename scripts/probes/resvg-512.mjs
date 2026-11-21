#!/usr/bin/env node
// Sonda B-LR03: ¿cabe un motor de render de imagen junto al MCP en 512 MiB?
//
// Compara `@resvg/resvg-wasm` y `@napi-rs/canvas` en la misma imagen que corre
// el servicio (`node:24-alpine`, `mem_limit: 512m` de `deploy/compose.yml`).
// NO toca `package.json` ni el lock: los dos paquetes se instalan fuera del
// repo, en una carpeta temporal, y la sonda los resuelve con `--modules`.
//
// Uso (ver la cabecera de `prep` y `run` mas abajo):
//
//   node resvg-512.mjs prep --out <dir> --modules <dir con node_modules>
//   node resvg-512.mjs run --engine resvg|canvas --fixtures <dir> \
//        --modules <dir> [--ballast-mib 220] [--cap-px 16777216] [--renders 100]
//
// `prep` escribe las imagenes de prueba (semilla fija, mismos bytes siempre).
// `run` hace un motor por proceso, para que el RSS maximo sea suyo, y escribe
// una linea JSON con las cifras. Sale con 0 solo si pasan todas las
// comprobaciones propias (incluida la imagen sobre el tope, que se omite).
//
// El lastre (`--ballast-mib`) simula al MCP vivo: la medicion de D22 dio
// 219,5 MiB con dos cuentas, asi que al motor le quedan unos 292 MiB.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIB = 1024 * 1024;
const FORMATOS = ['png', 'jpeg', 'gif', 'webp'];
// Tope de la sonda: 16 MP exactos pasan, lo que lo supere se omite sin decodificar.
const TOPE_PX_DEFECTO = 4096 * 4096;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function cargaPaquete(modules, nombre) {
  const req = createRequire(join(modules, 'x.js'));
  return req.resolve(nombre);
}

// ---------- cabeceras: dimensiones sin decodificar ----------

/** Lee ancho y alto del encabezado. Devuelve null si no reconoce el formato. */
export function dimensiones(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { formato: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') {
    return { formato: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const t = b.toString('latin1', 12, 16);
    if (t === 'VP8X') return { formato: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (t === 'VP8 ') return { formato: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (t === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { formato: 'webp', w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { formato: 'jpeg', h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
      }
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  return null;
}

// ---------- prep: imagenes de prueba ----------

function prng(semilla) {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function prep(o) {
  const { createCanvas } = await import(pathToFileURL(cargaPaquete(o.modules, '@napi-rs/canvas')).href);
  mkdirSync(o.out, { recursive: true });
  const dibuja = (w, h, semilla) => {
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    const r = prng(semilla);
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#2a6fdb');
    grad.addColorStop(1, '#f0a030');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${(r() * 255) | 0},${(r() * 255) | 0},${(r() * 255) | 0},0.5)`;
      g.fillRect(r() * w, r() * h, r() * w * 0.2, r() * h * 0.2);
    }
    return c;
  };
  const q = { png: undefined, jpeg: 85, gif: undefined, webp: 80 };
  const salida = [];
  const casos = [
    ...FORMATOS.map((f) => [`pequena.${f}`, f, 512, 512, 1]),
    ...FORMATOS.map((f) => [`16mp.${f}`, f, 4096, 4096, 2]),
    ['sobre-tope.png', 'png', 5000, 4000, 3],
  ];
  for (const [nombre, f, w, h, sem] of casos) {
    const c = dibuja(w, h, sem);
    const buf = q[f] === undefined ? await c.encode(f) : await c.encode(f, q[f]);
    writeFileSync(join(o.out, nombre), buf);
    salida.push({ nombre, bytes: buf.length, ...dimensiones(buf) });
  }
  console.log(JSON.stringify(salida, null, 1));
}

// ---------- motores ----------

function svgConImagen(buf, mime, w, h) {
  const imagen = buf
    ? `<image href="data:${mime};base64,${buf.toString('base64')}" x="0" y="0" width="${w}" height="${h}" opacity="0.8"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#fff"/>` +
    `<circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#3a7" stroke="#123" stroke-width="6"/>` +
    imagen +
    `<path d="M0 0 L${w} ${h}" stroke="#c00" stroke-width="4"/></svg>`
  );
}

async function motorResvg(modules) {
  const mod = await import(pathToFileURL(join(modules, 'node_modules', '@resvg', 'resvg-wasm', 'index.mjs')).href);
  const wasm = join(modules, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
  await mod.initWasm(readFileSync(wasm));
  return {
    version: JSON.parse(readFileSync(join(modules, 'node_modules', '@resvg', 'resvg-wasm', 'package.json'), 'utf8')).version,
    async render(buf, formato) {
      const mime = `image/${formato}`;
      const r = new mod.Resvg(svgConImagen(buf, mime, 1600, 1200), { fitTo: { mode: 'width', value: 1600 } });
      const img = r.render();
      const png = img.asPng();
      const n = png.length;
      img.free();
      r.free();
      return n;
    },
  };
}

async function motorCanvas(modules) {
  const mod = await import(pathToFileURL(cargaPaquete(modules, '@napi-rs/canvas')).href);
  return {
    version: JSON.parse(readFileSync(join(modules, 'node_modules', '@napi-rs', 'canvas', 'package.json'), 'utf8')).version,
    async render(buf) {
      const img = buf ? await mod.loadImage(buf) : null;
      const c = mod.createCanvas(1600, 1200);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 1600, 1200);
      g.fillStyle = '#3a7';
      g.beginPath();
      g.arc(800, 600, 400, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.8;
      if (img) g.drawImage(img, 0, 0, 1600, 1200);
      return (await c.encode('png')).length;
    },
  };
}

// ---------- run ----------

function cgroup(nombre) {
  for (const p of [`/sys/fs/cgroup/${nombre}`]) {
    try { return readFileSync(p, 'utf8').trim(); } catch { /* sin cgroup v2 visible */ }
  }
  return null;
}

async function run(o) {
  const tope = Number(o['cap-px'] ?? TOPE_PX_DEFECTO);
  const renders = Number(o.renders ?? 100);
  const lastreMib = Number(o['ballast-mib'] ?? 0);
  const lastre = Buffer.alloc(lastreMib * MIB, 1); // tocado: cuenta como RSS
  const motor = o.engine === 'canvas' ? await motorCanvas(o.modules) : await motorResvg(o.modules);
  const lee = (n) => readFileSync(join(o.fixtures, n));
  const rss = () => Math.round(process.memoryUsage().rss / MIB);
  const r = { engine: o.engine, version: motor.version, node: process.version, lastreMib, topePx: tope, rssInicialMiB: rss() };
  const fallos = [];

  // 0. Sin imagen: tamano del PNG de referencia. Si con imagen no crece, el
  // motor la ignoro en silencio (resvg lo hace con formatos que no decodifica).
  r.pngBytesSinImagen = await motor.render(null, 'png');

  // 1. 100 renders con imagenes pequenas de los cuatro formatos, en rotacion.
  const pequenas = FORMATOS.map((f) => [f, lee(`pequena.${f}`)]);
  r.sinPintar = {};
  const t0 = performance.now();
  try {
    for (let i = 0; i < renders; i++) {
      const [f, buf] = pequenas[i % 4];
      const n = await motor.render(buf, f);
      if (n <= r.pngBytesSinImagen * 1.5) r.sinPintar[f] = (r.sinPintar[f] ?? 0) + 1;
    }
    r.rendersOk = renders;
    if (Object.keys(r.sinPintar).length) fallos.push(`renders sin pintar la imagen: ${JSON.stringify(r.sinPintar)}`);
  } catch (e) {
    fallos.push(`render ${r.rendersOk ?? 0}: ${e.message}`);
  }
  r.rendersMs = Math.round(performance.now() - t0);
  r.rssTras100MiB = rss();

  // 2. Una imagen de 16 MP por formato (en el tope exacto: se renderiza).
  r.mp16 = {};
  for (const f of FORMATOS) {
    const buf = lee(`16mp.${f}`);
    const d = dimensiones(buf);
    const t = performance.now();
    try {
      if (d.w * d.h > tope) throw new Error('omitida por tope');
      const n = await motor.render(buf, f);
      const pintada = n > r.pngBytesSinImagen * 1.5;
      r.mp16[f] = { ok: pintada, ms: Math.round(performance.now() - t), rssMiB: rss(), pngBytes: n, pintada };
      if (!pintada) fallos.push(`16mp ${f}: el motor no pinto la imagen`);
    } catch (e) {
      r.mp16[f] = { ok: false, error: e.message };
      fallos.push(`16mp ${f}: ${e.message}`);
    }
  }

  // 3. Imagen sobre el tope: debe omitirse sin decodificarla.
  const sobre = lee('sobre-tope.png');
  const ds = dimensiones(sobre);
  const rssAntes = rss();
  if (ds.w * ds.h > tope) {
    r.sobreTope = { omitida: true, px: ds.w * ds.h, rssDeltaMiB: rss() - rssAntes };
  } else {
    await motor.render(sobre, 'png');
    r.sobreTope = { omitida: false, px: ds.w * ds.h };
    fallos.push('la imagen sobre el tope no se omitio');
  }

  // 4. Cifras finales.
  r.maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  const pico = cgroup('memory.peak');
  const max = cgroup('memory.max');
  r.cgroupPicoMiB = pico ? Math.round(Number(pico) / MIB) : null;
  r.cgroupMaxMiB = max && max !== 'max' ? Math.round(Number(max) / MIB) : null;
  r.fallos = fallos;
  r.pasa = fallos.length === 0;
  void lastre.length;
  console.log(JSON.stringify(r));
  process.exit(r.pasa ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'prep') await prep(o);
  else if (cmd === 'run') await run(o);
  else {
    console.error('uso: resvg-512.mjs prep|run ... (ver la cabecera)');
    process.exit(2);
  }
}
