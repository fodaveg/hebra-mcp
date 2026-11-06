// Hilo aparte: muestrea el RSS del proceso cada 2 ms (el hilo principal se bloquea en
// las llamadas síncronas de node:sqlite y no podría muestrear él mismo).
import { parentPort } from 'node:worker_threads';
let peak = 0;
let on = false;
const tick = () => { if (on) { const r = process.memoryUsage.rss(); if (r > peak) peak = r; } };
setInterval(tick, 2);
parentPort!.on('message', (m: string) => {
  if (m === 'start') { peak = process.memoryUsage.rss(); on = true; }
  else if (m === 'stop') { tick(); on = false; parentPort!.postMessage(peak); }
});
