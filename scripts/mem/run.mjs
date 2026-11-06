#!/usr/bin/env node
/**
 * Arnés de carga de memoria (`npm run mem:carga`). Mide cuánta memoria gasta `serve-http` con N
 * contextos (una biblioteca por cuenta) abiertos a la vez y con K peticiones simultáneas, dentro de
 * un contenedor con `--memory`, sobre la imagen base de `deploy/Dockerfile`. Sustituye a esperar a
 * que varias personas reales se conecten a la vez. Necesita Docker y tarda minutos: NO forma parte
 * de `npm run check`.
 *
 *   npm run mem:carga -- --memory 512m --notas 30000 --contextos 20 --concurrentes 1,5,20
 *
 * Opciones (todas con valor):
 *   --memory <m>        límite del contenedor, formato de docker (defecto 512m)
 *   --notas <n>         notas por biblioteca sintética (defecto 5000)
 *   --contextos <n>     contextos abiertos a la vez (defecto 5)
 *   --concurrentes <l>  lista de K peticiones a la vez, p. ej. 1,5,20 (defecto 1,2,5)
 *   --cache-dir <ruta>  caché de bibliotecas generadas (defecto .cache/mem; está ignorada por git)
 *   --salida <ruta>     carpeta de resultados (defecto <cache-dir>/out)
 *   --etiqueta <texto>  nombre de la corrida (defecto m<memory>-n<notas>-x<contextos>)
 *   --max-ctx-ocioso-mib, --max-pico-peticion-mib, --max-pico-concurrente-mib,
 *   --max-retenido-tras-cerrar-mib   umbrales opcionales: si uno se supera, sale con código 1
 * Sale con 1 si se supera un umbral, hay OOM o la corrida no termina, y con 2 si los argumentos
 * no valen. Las bibliotecas se generan una vez por número de notas y se reutilizan.
 *
 * Escribe <salida>/<etiqueta>.jsonl (una línea por fase), .log (stderr) y .summary.json, e imprime
 * la tabla. El volumen de Docker de la corrida se borra siempre al acabar.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KNOWN = new Set(['memory', 'notas', 'contextos', 'concurrentes', 'cache-dir', 'salida', 'etiqueta',
  'max-ctx-ocioso-mib', 'max-pico-peticion-mib', 'max-pico-concurrente-mib', 'max-retenido-tras-cerrar-mib']);

function fail(message, code = 2) {
  console.error(`mem:carga: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`argumento inesperado «${arg}»`);
    const name = arg.slice(2);
    if (!KNOWN.has(name)) fail(`opción desconocida «${arg}»`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`a «${arg}» le falta el valor`);
    out[name] = value;
    i += 1;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const memory = opts.memory ?? '512m';
if (!/^\d+[bkmg]?$/i.test(memory)) fail(`--memory «${memory}» no es un tamaño de docker (p. ej. 512m)`);
const notas = Number(opts.notas ?? 5000);
const contextos = Number(opts.contextos ?? 5);
if (!Number.isInteger(notas) || notas < 1) fail('--notas tiene que ser un entero positivo');
if (!Number.isInteger(contextos) || contextos < 1) fail('--contextos tiene que ser un entero positivo');
const concurrentes = (opts.concurrentes ?? '1,2,5').split(',').map(Number);
if (concurrentes.some((k) => !Number.isInteger(k) || k < 1)) fail('--concurrentes es una lista de enteros positivos');
const cacheDir = resolve(root, opts['cache-dir'] ?? '.cache/mem');
const outDir = resolve(root, opts.salida ?? join(cacheDir, 'out'));
const label = (opts.etiqueta ?? `m${memory}-n${notas}-x${contextos}`).replace(/[^A-Za-z0-9_.-]/g, '-');
const limits = {};
for (const [flag, key] of [['max-ctx-ocioso-mib', 'ctxOciosoMiB'], ['max-pico-peticion-mib', 'picoPeticionMiB'],
  ['max-pico-concurrente-mib', 'picoConcurrenteMiB'], ['max-retenido-tras-cerrar-mib', 'retenidoTrasCerrarMiB']]) {
  if (opts[flag] === undefined) continue;
  const n = Number(opts[flag]);
  if (!Number.isFinite(n) || n < 0) fail(`--${flag} tiene que ser un número >= 0`);
  limits[key] = n;
}

// La imagen es la base de producción: se lee de la línea FROM de deploy/Dockerfile.
const image = /^FROM\s+(\S+)/m.exec(readFileSync(join(root, 'deploy', 'Dockerfile'), 'utf8'))?.[1];
if (!image) fail('no encuentro la línea FROM en deploy/Dockerfile', 1);

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`no pude ejecutar ${cmd}: ${result.error.message}`, 1);
  return result.status ?? 1;
}

// 1. Empaquetar gen, measure y sampler. Dentro del repo (y no de la caché) para que Node resuelva
//    `node_modules` subiendo directorios, tanto en el anfitrión como en el contenedor.
const distDir = join(root, '.cache', 'mem-dist');
await build({
  entryPoints: ['gen', 'measure', 'sampler'].map((name) => join(root, 'scripts', 'mem', `${name}.ts`)),
  outdir: distDir, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm',
  target: 'node24', packages: 'external', tsconfig: join(root, 'tsconfig.json'), logLevel: 'warning'
});

// 2. Biblioteca sintética (una por número de notas), generada una vez.
const template = join(cacheDir, 'libs', `n${notas}`);
if (!existsSync(join(template, 'library.sqlite'))) {
  console.log(`mem:carga: generando ${notas} notas en ${template} (una vez)`);
  const partial = `${template}.parcial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(dirname(template), { recursive: true });
  if (run(process.execPath, [join(distDir, 'gen.mjs'), partial, String(notas), '0']) !== 0) fail('falló la generación', 1);
  renameSync(partial, template);
}

// 3. Medir dentro de Docker. La copia a un volumen se hace en otro contenedor sin límite: así la
//    caché de escritura de la copia no cuenta en el cgroup medido.
mkdirSync(outDir, { recursive: true });
const volume = `hebra-mem-${label}-${process.pid}`.toLowerCase();
const removeVolume = () => spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { removeVolume(); process.exit(130); });

const jsonlPath = join(outDir, `${label}.jsonl`);
const logPath = join(outDir, `${label}.log`);
let exitCode = 1;
try {
  if (run('docker', ['volume', 'create', volume], { stdio: 'ignore' }) !== 0) fail('docker no responde (¿está en marcha?)', 1);
  const copyScript = `i=0; while [ $i -lt ${contextos} ]; do cp -a /libs/n${notas} /work/ctx-$i; i=$((i+1)); done; sync`;
  const copied = run('docker', ['run', '--rm', '-v', `${join(cacheDir, 'libs')}:/libs:ro`, '-v', `${volume}:/work`,
    image, 'sh', '-c', copyScript]);
  if (copied !== 0) fail('falló la copia de las bibliotecas al volumen', 1);

  const out = openSync(jsonlPath, 'w');
  const err = openSync(logPath, 'w');
  try {
    exitCode = run('docker', ['run', '--rm', `--memory=${memory}`, `--memory-swap=${memory}`, '--cpus=2',
      '-v', `${distDir}:/m/dist:ro`, '-v', `${join(root, 'node_modules')}:/m/node_modules:ro`, '-v', `${volume}:/work`,
      '-w', '/m', image, 'node', '--expose-gc', '/m/dist/measure.mjs', '/work', String(contextos),
      '--label', label, '--concurrent', concurrentes.join(',')], { stdio: ['ignore', out, err] });
  } finally {
    closeSync(out);
    closeSync(err);
  }
} finally {
  removeVolume();
}

// 4. Resumen.
const rows = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.startsWith('{"label"')).map((l) => JSON.parse(l));
const phase = (name) => rows.find((r) => r.phase === name);
const base = phase('baseline');
const opened = phase('after_open');
const closed = phase('after_close');
const requests = rows.filter((r) => r.phase === 'request');
const concurrent = rows.filter((r) => r.phase === 'concurrent');
const oom = exitCode === 137;
const complete = Boolean(base && opened && closed) && requests.length > 0;
const round = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const requestPeak = (r) => r.peakOverBeforeRss + Math.max(0, (r.hwm ?? 0) - r.peakRss);

const metrics = {
  baseProcesoMiB: round(base?.cgroup?.anon),
  baseProcesoGateMiB: round(base?.gateUsed),
  ctxOciosoMiB: round(opened && base ? (opened.cgroup.anon - base.cgroup.anon) / opened.N : null),
  picoPeticionMiB: round(requests.length ? Math.max(...requests.map(requestPeak)) : null),
  picoConcurrenteMiB: round(concurrent.length ? Math.max(...concurrent.map((r) => r.peakOverBefore)) : null),
  retenidoTrasCerrarMiB: round(closed && base ? closed.cgroup.anon - base.cgroup.anon : null)
};

const problems = [];
if (oom) problems.push('OOM: el contenedor murió por superar --memory (código 137)');
else if (exitCode !== 0) problems.push(`la medición terminó con código ${exitCode} (ver ${logPath})`);
if (!complete && !oom && exitCode === 0) problems.push('la medición no llegó a todas las fases');
if (concurrent.some((r) => r.errors > 0)) problems.push('alguna petición concurrente devolvió error');
if (requests.some((r) => r.isError)) problems.push('alguna petición devolvió error');
for (const [key, max] of Object.entries(limits)) {
  const value = metrics[key];
  if (value === null || value > max) problems.push(`${key} = ${value} MiB supera el umbral de ${max} MiB`);
}

const summary = { label, image, memory, notas, contextos, concurrentes, metrics, limits,
  porHerramienta: requests.map((r) => ({ herramienta: r.tool, ms: r.ms, picoMiB: round(requestPeak(r)), respuestaChars: r.responseChars })),
  porConcurrencia: concurrent.map((r) => ({ k: r.K, ms: r.ms, picoMiB: round(r.peakOverBefore), errores: r.errors })),
  ok: problems.length === 0, problems };
writeFileSync(join(outDir, `${label}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);

const cell = (x) => (x === null || x === undefined ? '-' : String(x));
console.log(`\nmem:carga ${label}: ${memory}, ${notas} notas, ${contextos} contextos, imagen ${image.split('@')[0]}\n`);
console.log('| métrica | MiB | umbral |');
console.log('|---|---|---|');
console.log(`| base del proceso (anon del cgroup) | ${cell(metrics.baseProcesoMiB)} | |`);
console.log(`| base del proceso (uso que ve la puerta) | ${cell(metrics.baseProcesoGateMiB)} | |`);
for (const [key, name] of [['ctxOciosoMiB', 'coste por contexto ocioso'], ['picoPeticionMiB', 'pico por petición'],
  ['picoConcurrenteMiB', 'pico con peticiones a la vez'], ['retenidoTrasCerrarMiB', 'retenido tras cerrar (sobre la base)']]) {
  console.log(`| ${name} | ${cell(metrics[key])} | ${limits[key] ?? ''} |`);
}
console.log('\n| herramienta | ms | pico sobre antes (MiB) | respuesta (chars) |');
console.log('|---|---|---|---|');
for (const r of summary.porHerramienta) console.log(`| ${r.herramienta} | ${r.ms} | ${cell(r.picoMiB)} | ${r.respuestaChars} |`);
console.log('\n| peticiones a la vez | ms | pico sobre antes (MiB) | errores |');
console.log('|---|---|---|---|');
for (const r of summary.porConcurrencia) console.log(`| ${r.k} | ${r.ms} | ${cell(r.picoMiB)} | ${r.errores} |`);
console.log(`\nResumen: ${join(outDir, `${label}.summary.json`)}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`mem:carga: ${p}`);
  process.exit(1);
}
console.log('mem:carga: ok');
