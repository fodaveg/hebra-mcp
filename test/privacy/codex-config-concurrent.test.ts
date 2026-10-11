import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({
  path: null as string | null,
  entered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...args: unknown[]) => {
      if (args[0] === gate.path) {
        gate.entered?.();
        await gate.wait;
      }
      // Siempre lee el fichero REAL. Solo se controla la duración de ese I/O.
      return Reflect.apply(real.readFile, real, args);
    }
  };
});

import { PrivacyConfigSource } from '../../src/privacy/config-source';
import { auditHarness, NOT_FOUND } from './audit-harness';

it('dos llamadas simultáneas aplican la configuración nueva aunque la primera aún la está leyendo', async () => {
  const h = await auditHarness(async () => ({}));
  const path = join(h.dataDir, 'config.json');
  let resume: (() => void) | undefined;
  let first: ReturnType<typeof h.call> | undefined;
  try {
    writeFileSync(path, JSON.stringify({ privateFolders: [], privateTags: [] }));
    h.serverContext.privacyConfigSource = await PrivacyConfigSource.open(h.dataDir);
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).isError).toBe(false);
    writeFileSync(path, JSON.stringify({ privateFolders: ['Diario'], privateTags: ['secreto'] }));
    gate.path = path;
    const entered = new Promise<void>((resolve) => { gate.entered = resolve; });
    gate.wait = new Promise<void>((resolve) => { resume = resolve; });
    first = h.call('hebra_status');
    await entered;
    // current() de la primera ya actualizó stamp, pero config sigue siendo la vieja.
    // Ajuste (Claude, 11 oct 2026): con el arreglo, la segunda ESPERA la recarga en vuelo de la
    // primera, que sigue parada hasta `resume()`; esperarla antes de `resume()` la dejaba
    // colgada. Se lanza, se le da tiempo de sobra para responder con la configuración vieja
    // si no esperara (el fallo de antes), y después se suelta la lectura.
    const secondCall = h.call('hebra_read_note', { id: h.library.privateFolderNoteId });
    await new Promise((resolve) => setTimeout(resolve, 200));
    resume?.();
    const second = await secondCall;
    await first;
    expect((await h.call('hebra_read_note', { id: h.library.privateFolderNoteId })).json).toEqual(NOT_FOUND);
    expect(second.json, `La segunda llamada devuelve contenido privado usando la configuración vieja: ${second.raw}`)
      .toEqual(NOT_FOUND);
  } finally {
    resume?.();
    gate.path = null;
    await first;
    await h.close();
  }
});
