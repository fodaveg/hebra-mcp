/**
 * Proceso hijo de `test/sync/robustez-procesos.node.test.ts` (E2 y E3 del audit de
 * robustez del escritor, 10 oct 2026). Se empaqueta con esbuild desde las FUENTES (no usa
 * `dist/`, que es lo que se despliega) y se lanza con `node`.
 *
 * `hang <dataDir> <relayOrigin>`: escritor con sync por el transporte HTTP real contra un
 * relé que acepta TCP y nunca responde (la ronda se queda colgada), con `writer.sock` y el
 * apagado de `serve` (`src/server/main.ts`): su propio oyente de SIGTERM, que cierra la
 * instancia y sale con 0, y `deferSignalRelease` para que la señal no suelte el bloqueo.
 *
 * Líneas por stdout:
 * - `ready <id>`: la nota de prueba está creada y el socket escucha.
 * - `sigterm lock=<0|1>`: al recibir SIGTERM, si `writer.lock` seguía en su sitio en ese
 *   momento (M1: con el arreglo, el bloqueo se suelta al terminar de vaciar, no antes).
 * - `closed`: `instance.close()` terminó.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WRITER_LOCK_FILE } from '../../src/lock/writer-lock';
import { writerSocketHandlers } from '../../src/server/forward';
import { localWriteContext } from '../../src/server/serve';
import { LibraryInstance } from '../../src/sync/library-instance';

const OPEN = { privateFolders: [] as string[][], privateTags: [] as string[] };
const [mode, dataDir, relayOrigin] = process.argv.slice(2);
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  if (mode !== 'hang' || !dataDir || !relayOrigin) throw new Error('uso: hang <dataDir> <relayOrigin>');
  const connection = async () => ({ apiOrigin: relayOrigin, readToken: 'r', writeToken: 'w' });
  const instance = await LibraryInstance.open({
    dataDir,
    checkIntervalMs: null,
    sync: {
      identity: { relayOrigin, syncVaultId: 'bb'.repeat(16) },
      vaultKey: new Uint8Array(32).fill(7),
      keyEpoch: 1,
      connection,
      intervalMs: 30_000
    },
    writerSocket: (opened) => writerSocketHandlers(localWriteContext(opened), opened)
  });
  const { id } = await instance.createNote({ body: '# Colgado\n', folderId: null, privacy: OPEN });
  process.once('SIGTERM', () => {
    out(`sigterm lock=${existsSync(join(dataDir, WRITER_LOCK_FILE)) ? 1 : 0}`);
    void instance.close().then(() => {
      out('closed');
      process.exit(0);
    });
  });
  // Como `serve` (`main.ts`): el bloqueo lo suelta `close()`, no la señal.
  instance.deferSignalRelease();
  out(`ready ${id}`);
  // Lo que mantiene vivo el proceso en `serve` es el transporte MCP.
  setInterval(() => undefined, 1_000);
}

main().catch((error: unknown) => {
  out(`fatal ${error instanceof Error ? error.name : 'unknown'}`);
  process.exit(1);
});
