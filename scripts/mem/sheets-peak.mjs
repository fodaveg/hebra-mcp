#!/usr/bin/env node
/**
 * Pico de memoria de leer, pintar, editar y guardar una hoja en el contenedor del MCP (H-95c, la
 * sonda de H-95 y H-95b hecha repetible). Necesita Docker y `npm run build`; NO forma parte de
 * `npm run check`.
 *
 *   node scripts/mem/sheets-peak.mjs --prod <carpeta con node_modules de producción>
 *        [--imagen <imagen>] [--memoria 512m] [--casos foto,limite8,pintar,libro39,libro39-leer] [--repite 3]
 *
 * `--prod` es una carpeta con `package.json` y `package-lock.json` de este repo y su `node_modules`
 * de `npm ci --omit=dev` hecho DENTRO de la imagen (los binarios nativos son los de Linux musl,
 * no los del Mac). La imagen es la de producción (Node de `deploy/Dockerfile`, ya en local).
 * Por corrida: un volumen nuevo, una biblioteca sembrada en un contenedor sin límite y otro con
 * `--memory=512m --memory-swap=512m` como `deploy/compose.yml`, `node --liftoff-only` como su
 * `CMD` y 220 MiB de lastre tocado, que lee el `memory.peak` del cgroup. Imprime una línea JSON
 * por corrida (`scripts/mem/sheets-probe.ts` explica los campos).
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const o = {};
for (let i = 2; i < process.argv.length; i += 2) o[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!o.prod) {
  console.error('sheets-peak: falta --prod <carpeta>');
  process.exit(2);
}
const prod = resolve(o.prod);
const image = o.imagen ?? 'c63a5d0fed43';
const memory = o.memoria ?? '512m';
const repite = Number(o.repite ?? 3);
// caso de la sonda -> fichero de /fx y operación
const CASOS = {
  foto: { fx: 'foto', op: 'edit' },
  limite8: { fx: 'limite8', op: 'edit' },
  pintar: { fx: 'pintar', op: 'render' },
  libro39: { fx: 'libro39', op: 'edit' },
  'libro39-leer': { fx: 'libro39', op: 'read' },
  // Descomposición del pintado: el mismo rango en un libro pequeño y un rango pequeño en el del tope.
  'pintar-libro-corto': { fx: 'pintar200', op: 'render' },
  'pintar-rango-corto': { fx: 'pintar', op: 'render', rango: 'A1:H10' }
};
const casos = (o.casos ?? 'foto,limite8,pintar,libro39,libro39-leer').split(',');

const work = join(root, '.cache', 'sheets-peak');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'fx'), { recursive: true });
const shared = { bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', tsconfig: join(root, 'tsconfig.json'), logLevel: 'error' };

// 1. El empaquetado de producción (dist/) y la sonda DENTRO de él, para que las URL relativas valgan.
const built = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'ignore' });
if (built.status !== 0) {
  console.error('sheets-peak: falló npm run build');
  process.exit(1);
}
await build({ ...shared, entryPoints: [join(root, 'scripts', 'mem', 'sheets-probe.ts')], outfile: join(root, 'dist', 'sheets-probe.mjs') });
await build({ ...shared, entryPoints: [join(root, 'scripts', 'mem', 'sheets-fixtures.ts')], outfile: join(work, 'fixtures.mjs') });
spawnSync(process.execPath, [join(work, 'fixtures.mjs'), join(work, 'fx')], { cwd: root, stdio: 'inherit' });

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', ...options });
const mounts = [
  '-v', `${join(root, 'dist')}:/app/dist:ro`,
  '-v', `${join(prod, 'node_modules')}:/app/node_modules:ro`,
  '-v', `${join(work, 'fx')}:/fx:ro`
];

for (const name of casos) {
  const caso = CASOS[name];
  if (!caso) throw new Error(`caso desconocido «${name}»`);
  for (let rep = 1; rep <= repite; rep += 1) {
    const volume = `hebra-sheets-peak-${name}-${rep}-${process.pid}`.toLowerCase();
    try {
      docker(['volume', 'create', volume]);
      // Siembra sin límite de memoria: la caché de escritura no cuenta en el cgroup medido.
      // Como root (el volumen nuevo es suyo) y se lo deja al usuario `node`, con el que corre el MCP.
      const prep = docker(['run', '--rm', '--user', 'root', '--security-opt', 'label=disable', '--entrypoint', 'sh', ...mounts, '-v', `${volume}:/work`,
        '-w', '/app', image, '-c', `node /app/dist/sheets-probe.mjs prep ${caso.fx} /work && chown -R node:node /work`]);
      if (prep.status !== 0) {
        console.log(JSON.stringify({ caso: name, rep, error: 'prep', stderr: prep.stderr.slice(0, 400) }));
        continue;
      }
      const run = docker(['run', '--rm', `--memory=${memory}`, `--memory-swap=${memory}`, '--security-opt', 'label=disable', '--entrypoint', 'node', '-e', `RANGO=${caso.rango ?? 'A1:BH200'}`,
        ...mounts, '-v', `${volume}:/work`, '-w', '/app', image, '--liftoff-only', '/app/dist/sheets-probe.mjs', 'run', caso.op === 'edit' ? name : caso.op, '/work']);
      const line = run.stdout.trim().split('\n').pop() ?? '';
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        row = { error: `codigo ${run.status}${run.status === 137 ? ' (OOM)' : ''}`, stderr: run.stderr.slice(0, 400) };
      }
      console.log(JSON.stringify({ ...row, caso: name, rep, codigo: run.status }));
    } finally {
      docker(['volume', 'rm', '-f', volume]);
    }
  }
}
