/**
 * Proceso hijo de `test/workdir/apply-corte.node.test.ts` (AC5 de los ficheros de trabajo,
 * SPEC.md §13.8). Se empaqueta con esbuild desde las FUENTES y se lanza con `node`.
 *
 * `apply <dataDir> <cwd> <parar> <sabotaje>`: `hebra-mcp apply` sobre la carpeta de trabajo
 * de `<cwd>`, con la biblioteca de `<dataDir>` como escritor (sin secretos: nunca el
 * llavero). Si `<parar>` es un índice, tras ESCRIBIR esa nota y antes de poner al día sus
 * metadatos imprime `parado` y se queda colgado, para que el test lo mate con SIGKILL: es
 * el hueco «dentro de una nota» del `kill -9`. `<sabotaje>` = 1 se salta el paso «ya
 * estaba» (`skipAlreadyApplied`).
 *
 * Por stdout, las líneas de la orden y, al final, `salida <código>`.
 */
import { applyCommand } from '../../src/workdir/commands';
import { openWorkdirLibrary } from '../../src/workdir/library';

const [mode, dataDir, cwd, stopRaw, sabotageRaw] = process.argv.slice(2);
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  if (mode !== 'apply' || !dataDir || !cwd) throw new Error('uso: apply <dataDir> <cwd> <parar> <sabotaje>');
  const stopAt = Number(stopRaw);
  const code = await applyCommand(
    { cwd, out },
    () =>
      openWorkdirLibrary({
        dataDir,
        secrets: null,
        instance: { checkIntervalMs: null },
        hooks: { skipAlreadyApplied: sabotageRaw === '1' }
      }),
    { conflicto: 'copia', simular: false },
    {
      afterWrite: async (index) => {
        if (index !== stopAt) return;
        out('parado');
        // Colgado hasta el SIGKILL; con tope por si el test no llega a matarlo.
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        out('nadie me mató');
        process.exit(3);
      }
    }
  );
  out(`salida ${code}`);
  process.exit(code);
}

main().catch((error: unknown) => {
  out(`fatal ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}`);
  process.exit(1);
});
