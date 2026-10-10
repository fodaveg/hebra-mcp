/**
 * Proceso hijo de `test/replace/apply-corte.node.test.ts` (AC5 de `hebra_replace_in_notes`,
 * D14). Se empaqueta con esbuild desde las FUENTES y se lanza con `node`.
 *
 * `apply <dataDir> <planId> <operationId> <parar>`: abre la biblioteca de `<dataDir>` como
 * escritor (sin secretos ni sync: nunca el llavero) y aplica el plan. Tras ESCRIBIR la nota
 * de la posición `<parar>` y ANTES de anotarlo en el plan, imprime `parado` y se queda
 * colgado para que el test lo mate con SIGKILL: el hueco «dentro de una nota» del `kill -9`.
 *
 * Por stdout, `parado` y, si llega al final, `salida <notas del informe>`.
 */
import { LibraryInstance } from '../../src/sync/library-instance';

const [mode, dataDir, planId, operationId, stopRaw] = process.argv.slice(2);
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  if (mode !== 'apply' || !dataDir || !planId || !operationId) {
    throw new Error('uso: apply <dataDir> <planId> <operationId> <parar>');
  }
  const stopAt = Number(stopRaw);
  const instance = await LibraryInstance.open({ dataDir, checkIntervalMs: null, lock: { releaseOnExit: false } });
  const { result } = await instance.replaceInNotesLocal(
    { mode: 'apply', planId, operationId, privacy: { privateFolders: [], privateTags: [] } },
    {
      afterWrite: async (position) => {
        if (position !== stopAt) return;
        out('parado');
        // Colgado hasta el SIGKILL; con tope por si el test no llega a matarlo.
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        out('nadie me mató');
        process.exit(3);
      }
    }
  );
  out(`salida ${result.notes.length}`);
  await instance.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  out(`fatal ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`);
  process.exit(1);
});
