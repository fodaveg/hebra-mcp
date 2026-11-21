#!/usr/bin/env node
// Medicion C-07: pico de memoria de `readSafeZip` y `decodeXml` con un Office de 25 MiB, dentro de
// un contenedor de 512 MiB, con 1 y con 2 conversiones a la vez.
//
// NO toca `package.json` ni el lock. El fixture lo genera este script (escritor ZIP minimo sobre
// `zlib`, sin versionar el binario) y `fflate` se resuelve desde una carpeta temporal con la
// version del lockfile de Hebra (0.8.3), igual que la sonda `scripts/probes/resvg-512.mjs`.
//
//   node office-25mib.mjs prep   --tmp <dir> --fflate <ruta a node_modules/fflate> [--mib 25]
//   node office-25mib.mjs comprobar-limites --tmp <dir> --fflate <ruta>   (sin Docker)
//   node office-25mib.mjs run    --tmp <dir> --conversiones 0|1|2 [--lastre-mib 220]   (dentro del contenedor)
//   node office-25mib.mjs medir  --tmp <dir> --fflate <ruta> [--imagen <imagen>] [--lastre-mib 220]
//                                [--mib 25] [--expandido-mib N] [--lista 0,1,2] [--repite 1]
//
// `medir` hace prep y lanza un contenedor cada vez (`docker run --rm --memory=512m
// --memory-swap=512m`, codigo en solo lectura) con 0, 1 y 2 conversiones, y lee el pico real de
// `memory.peak` del cgroup, como B-LR20. El 0 es la linea base (Node, el bundle y el fixture leido).
// El lastre simula al MCP vivo (D22 midio 219,5 MiB con dos cuentas).

import { spawnSync } from 'node:child_process';
import { crc32, deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIB = 1024 * 1024;
/** La imagen de produccion (Node 24.21.0), ya en local: no se construye ni se baja. */
const IMAGEN_MCP = 'git.dualhand.com/fodaveg/hebra-mcp:c1c4082cd3bc7cf774c3dbaa8f0131d737ad2895';
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

// ---------- escritor ZIP minimo ----------

/** PRNG determinista (mulberry32): los mismos bytes en cada corrida. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Escribe un ZIP con `zlib`. Cada entrada es `{ path, data, store? }`; `store` la guarda sin
 * comprimir (como una imagen ya comprimida). Sin ZIP64: vale hasta 4 GiB.
 */
export function writeZip(entries) {
  const partes = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nombre = Buffer.from(e.path, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const metodo = e.store ? 0 : 8;
    const datos = e.store ? e.data : deflateRawSync(e.data, { level: 6 });
    const cab = Buffer.alloc(30);
    cab.writeUInt32LE(0x04034b50, 0);
    cab.writeUInt16LE(20, 4);
    cab.writeUInt16LE(0x0800, 6); // nombre UTF-8
    cab.writeUInt16LE(metodo, 8);
    cab.writeUInt32LE(crc, 14);
    cab.writeUInt32LE(datos.length, 18);
    cab.writeUInt32LE(e.data.length, 22);
    cab.writeUInt16LE(nombre.length, 26);
    partes.push(cab, nombre, datos);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(metodo, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(datos.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(nombre.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nombre);
    offset += cab.length + nombre.length + datos.length;
  }
  const dirBytes = central.reduce((n, b) => n + b.length, 0);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entries.length, 8);
  fin.writeUInt16LE(entries.length, 10);
  fin.writeUInt32LE(dirBytes, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, ...central, fin]);
}

/** Bytes incompresibles pero deterministas, para que el fixture sea el mismo en cada corrida. */
function bytesAleatorios(n, rnd) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 4) b.writeUInt32LE(Math.floor(rnd() * 4294967296) >>> 0, Math.min(i, n - 4));
  return b;
}

/** Una hoja con filas de texto y numeros: se comprime como un .xlsx real (unas 3 veces). */
function hojaXml(bytes, rnd) {
  const filas = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>'];
  let n = 0;
  let r = 1;
  while (n < bytes) {
    const celdas = [];
    for (let c = 0; c < 8; c++) {
      const v = Math.floor(rnd() * 1e9).toString(36) + Math.floor(rnd() * 1e6);
      celdas.push(`<c r="${String.fromCharCode(65 + c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`);
    }
    const fila = `<row r="${r}">${celdas.join('')}</row>`;
    filas.push(fila);
    n += fila.length;
    r += 1;
  }
  filas.push('</sheetData></worksheet>');
  return Buffer.from(filas.join(''), 'utf8');
}

/**
 * Genera un .xlsx sintetico cuyo ZIP mide `mib` MiB: dos hojas XML grandes y una imagen
 * incompresible guardada sin comprimir hasta completar el tamano. Determinista.
 */
export function generaFixture(mib = 25, expandidoMib) {
  if (expandidoMib !== undefined) return generaComprimible(mib, expandidoMib);
  const objetivo = mib * MIB;
  const rnd = prng(0xc07);
  const base = [
    { path: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { path: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
    { path: 'xl/worksheets/sheet1.xml', data: hojaXml(Math.floor(objetivo * 0.9), rnd) },
    { path: 'xl/worksheets/sheet2.xml', data: hojaXml(Math.floor(objetivo * 0.9), rnd) }
  ];
  const sinImagen = writeZip(base).length;
  const imagen = Math.max(0, objetivo - sinImagen - 200);
  const zip = writeZip([...base, { path: 'xl/media/image1.png', data: bytesAleatorios(imagen, rnd), store: true }]);
  return zip;
}

/**
 * Fixture muy comprimible: UNA hoja XML de `expandidoMib` MiB que repite un bloque de filas (se
 * comprime cientos de veces), mas una imagen incompresible guardada sin comprimir hasta que el
 * ZIP mida `mib` MiB. Es el peor caso de memoria para un tamano de archivo dado: poco archivo,
 * mucho XML expandido. Determinista.
 */
export function generaComprimible(mib, expandidoMib) {
  const rnd = prng(0xc07c);
  const objetivo = mib * MIB;
  const total = expandidoMib * MIB - 8; // 8 bytes: el `<Types/>` de [Content_Types].xml; el XML total es `expandidoMib` exacto
  const cabecera = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>';
  const pie = '</sheetData></worksheet>';
  const bloque = hojaXml(16 * 1024, rnd).toString('utf8').slice(cabecera.length, -pie.length);
  const hoja = Buffer.alloc(total);
  let n = hoja.write(cabecera, 0);
  const b = Buffer.from(bloque);
  while (n + b.length + pie.length <= total) n += b.copy(hoja, n);
  hoja.fill(' ', n, total - pie.length); // relleno de espacios dentro de sheetData
  hoja.write(pie, total - pie.length);
  const base = [
    { path: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { path: 'xl/worksheets/sheet1.xml', data: hoja }
  ];
  const sinImagen = writeZip(base).length;
  const imagen = Math.max(0, objetivo - sinImagen - 200);
  return writeZip([...base, { path: 'xl/media/image1.png', data: bytesAleatorios(imagen, rnd), store: true }]);
}

// ---------- prep: fixture y bundle ----------

const ENTRADA = `
import { readSafeZip, DEFAULT_ZIP_LIMITS } from '${resolve(root, 'vendor/hebra/src/lib/portability/zip-read.ts').replaceAll('\\', '/')}';
import { decodeXml } from '${resolve(root, 'vendor/hebra/src/lib/office-import/xml/decode.ts').replaceAll('\\', '/')}';
import { OFFICE_ZIP_LIMITS } from '${resolve(root, 'src/server/tools/office-limits.ts').replaceAll('\\', '/')}';
export { DEFAULT_ZIP_LIMITS, OFFICE_ZIP_LIMITS };
// Como lo hara C-27: solo las partes XML se descomprimen (\`select\`), con los topes de Office.
export async function convierte(archivo, limites = OFFICE_ZIP_LIMITS) {
  const entradas = await readSafeZip(archivo, limites, { select: (ruta) => ruta.endsWith('.xml') });
  let chars = 0;
  for (const e of entradas) chars += decodeXml(e.bytes).length;
  return { entradas: entradas.length, chars };
}
`;

async function prep(o) {
  const tmp = resolve(o.tmp);
  const mib = Number(o.mib ?? 25);
  mkdirSync(join(tmp, 'modules', 'node_modules'), { recursive: true });
  cpSync(resolve(o.fflate), join(tmp, 'modules', 'node_modules', 'fflate'), { recursive: true });
  const { build } = await import('esbuild');
  const entrada = join(tmp, 'entrada.ts');
  writeFileSync(entrada, ENTRADA);
  mkdirSync(join(tmp, 'out'), { recursive: true });
  await build({
    entryPoints: [entrada],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: join(tmp, 'out', 'convierte.mjs'),
    nodePaths: [join(tmp, 'modules', 'node_modules')],
    logLevel: 'error'
  });
  const zip = generaFixture(mib, o['expandido-mib'] === undefined ? undefined : Number(o['expandido-mib']));
  writeFileSync(join(tmp, 'out', 'fixture.xlsx'), zip);
  const sha = createHash('sha256').update(zip).digest('hex').slice(0, 16);
  return { bytes: zip.length, sha };
}

// ---------- comprobar-limites: en el host, sin Docker ----------

/** Los topes de Office frente a los del lector y el rechazo antes de expandir (prueba negativa con los de defecto). */
async function comprobarLimites(o) {
  const tmp = resolve(o.tmp);
  await prep({ ...o, mib: 2, 'expandido-mib': 40 });
  const { convierte, DEFAULT_ZIP_LIMITS, OFFICE_ZIP_LIMITS } = await import(pathToFileURL(join(tmp, 'out', 'convierte.mjs')).href);
  const archivo = readFileSync(join(tmp, 'out', 'fixture.xlsx'));
  const campos = Object.keys(DEFAULT_ZIP_LIMITS);
  const r = {
    derivados: campos.every((k) => OFFICE_ZIP_LIMITS[k] <= DEFAULT_ZIP_LIMITS[k]),
    // 40 MiB de XML declarados en un ZIP de 2 MiB: pasa los topes de defecto y no los de Office.
    conOffice: await convierte(archivo).then(() => 'acepta', (e) => e.message),
    conDefecto: await convierte(archivo, DEFAULT_ZIP_LIMITS).then(() => 'acepta', (e) => e.message),
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024)
  };
  console.log(JSON.stringify(r));
}

// ---------- run: dentro del contenedor ----------

function cgroup(nombre) {
  try {
    return readFileSync(`/sys/fs/cgroup/${nombre}`, 'utf8').trim();
  } catch {
    return null;
  }
}

async function run(o) {
  const dir = join(resolve(o.tmp), 'out');
  const n = Number(o.conversiones ?? 1);
  const lastre = Buffer.alloc(Number(o['lastre-mib'] ?? 0) * MIB, 1); // tocado: cuenta como RSS
  const { convierte } = await import(pathToFileURL(join(dir, 'convierte.mjs')).href);
  // Cada conversion lee el fichero ella misma, como lo hara el hilo: su copia no se comparte.
  const una = async () => convierte(readFileSync(join(dir, 'fixture.xlsx')));
  const t = performance.now();
  const res = await Promise.all(Array.from({ length: n }, una));
  const pico = cgroup('memory.peak');
  const max = cgroup('memory.max');
  console.log(
    JSON.stringify({
      node: process.version,
      conversiones: n,
      lastreMiB: lastre.length / MIB,
      ms: Math.round(performance.now() - t),
      resultado: res[0] ?? null,
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      cgroupPicoMiB: pico ? Math.round((Number(pico) / MIB) * 10) / 10 : null,
      cgroupMaxMiB: max && max !== 'max' ? Math.round(Number(max) / MIB) : null
    })
  );
}

// ---------- medir: orquesta los contenedores ----------

function medir(o) {
  const tmp = resolve(o.tmp);
  const imagen = o.imagen ?? IMAGEN_MCP;
  const lastre = o['lastre-mib'] ?? '220';
  const filas = [];
  const lista = (o.lista ?? '0,1,2').split(',').map(Number);
  const repite = Number(o.repite ?? 1);
  for (const n of lista.flatMap((x) => Array(repite).fill(x))) {
    const r = spawnSync(
      'docker',
      ['run', '--rm', '--memory=512m', '--memory-swap=512m', '--security-opt', 'label=disable', '--entrypoint', 'node', '-v', `${tmp}:/t:ro`, '-v', `${join(root, 'scripts/mem')}:/s:ro`,
        imagen, '/s/office-25mib.mjs', 'run', '--tmp', '/t', '--conversiones', String(n), '--lastre-mib', lastre],
      { encoding: 'utf8' }
    );
    const linea = r.stdout.trim().split('\n').pop();
    let datos;
    try { datos = JSON.parse(linea); } catch { datos = { conversiones: n, error: `codigo ${r.status}`, stderr: r.stderr.slice(0, 300) }; }
    filas.push({ ...datos, codigo: r.status });
  }
  return filas;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'prep') console.log(JSON.stringify(await prep(o)));
  else if (cmd === 'run') await run(o);
  else if (cmd === 'comprobar-limites') await comprobarLimites(o);
  else if (cmd === 'medir') {
    console.log(JSON.stringify(await prep(o)));
    for (const f of medir(o)) console.log(JSON.stringify(f));
  } else {
    console.error('uso: office-25mib.mjs prep|run|medir ... (ver la cabecera)');
    process.exit(2);
  }
  void rmSync;
}
