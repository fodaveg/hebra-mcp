/**
 * Proceso hijo de `test/lock/server-lock.node.test.ts`: un `serve-http` reducido a sus
 * bloqueos. Toma `control/server.lock`, abre el `writer.lock` de una cuenta y se queda vivo
 * hasta que lo maten. Se empaqueta con esbuild desde las FUENTES y se lanza con `node`.
 *
 * `<dataDir> <controlDir> <accountDir>`. Por stdout: `ready <bootId>`, o `busy` si otro
 * proceso ya tiene `server.lock` (y entonces sale con 3).
 */
import { acquireServerLock } from '../../src/lock/server-lock';
import { WriterLock } from '../../src/lock/writer-lock';

const [dataDir, controlDir, accountDir] = process.argv.slice(2);
if (!dataDir || !controlDir || !accountDir) throw new Error('uso: <dataDir> <controlDir> <accountDir>');

const server = acquireServerLock(dataDir, controlDir);
if (!server) {
  process.stdout.write('busy\n');
  process.exit(3);
}
const writer = new WriterLock({ dataDir: accountDir, releaseOnExit: false });
if (!writer.tryAcquire()) process.exit(4);
process.stdout.write(`ready ${server.bootId}\n`);
setInterval(() => undefined, 1_000);
