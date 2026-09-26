/**
 * `hebra-mcp unpair` (SPEC.md §6.2 «En local»): borra los tres secretos del llavero y el
 * directorio de datos (SQLite, adjuntos, `config.json`, bloqueo), tras confirmarlo en la
 * terminal.
 *
 * Antes de borrar toma el bloqueo de escritor (`src/lock/`): si otra instancia viva lo
 * tiene (una sesión de Claude con `serve` en marcha), no toca nada. Borrar la base debajo
 * de un escritor vivo la dejaría a medias.
 *
 * No revoca la credencial en Lumbre (eso se hace en Lumbre > Integraciones > Hebra) ni
 * rota la clave de la biblioteca (R1): lo recuerda al terminar.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { WriterLock, type WriterLockOptions } from '../lock/writer-lock';
import { logEvent } from '../log/logger';
import { clearPairedSecrets, type SecretStore } from '../secrets';
import { PairError } from './errors';
import type { PairTerminal } from './terminal';

export interface UnpairOptions {
  dataDir: string;
  secrets: SecretStore;
  terminal: PairTerminal;
  /** Tests: `pid`, `isAlive`, `releaseOnExit` del bloqueo. */
  lock?: Omit<WriterLockOptions, 'dataDir'>;
  log?: (entry: { event: 'unpair.step'; step: string; result: string }) => void;
}

export interface UnpairResult {
  confirmed: boolean;
  deletedSecrets: number;
  removedDataDir: boolean;
}

export async function runUnpair(options: UnpairOptions): Promise<UnpairResult> {
  const { terminal, dataDir } = options;
  const log = options.log ?? logEvent;
  terminal.print('Esto borra de este equipo:');
  terminal.print('  · la credencial de Lumbre, el código de recuperación y la identidad del');
  terminal.print('    dispositivo (llavero del sistema, servicio «hebra-mcp»);');
  terminal.print(`  · el directorio de datos: ${dataDir}`);
  const confirmed = await terminal.confirm('¿Seguro? Escribe «si» para borrar');
  if (!confirmed) {
    terminal.print('No se ha borrado nada.');
    log({ event: 'unpair.step', step: 'confirm', result: 'declined' });
    return { confirmed: false, deletedSecrets: 0, removedDataDir: false };
  }

  const hasDataDir = existsSync(dataDir);
  const lock = hasDataDir ? new WriterLock({ dataDir, ...options.lock }) : null;
  if (lock && !lock.tryAcquire()) {
    log({ event: 'unpair.step', step: 'lock', result: 'other_instance' });
    throw new PairError('other_instance_running');
  }
  try {
    const deletedSecrets = await clearPairedSecrets(options.secrets);
    log({ event: 'unpair.step', step: 'secrets', result: 'ok' });
    if (hasDataDir) await rm(dataDir, { recursive: true, force: true });
    log({ event: 'unpair.step', step: 'data_dir', result: hasDataDir ? 'ok' : 'absent' });
    terminal.print('Hecho. Para cortar también el acceso en el servidor, revoca la conexión');
    terminal.print('de hebra-mcp en Lumbre > Integraciones > Hebra.');
    return { confirmed: true, deletedSecrets, removedDataDir: hasDataDir };
  } finally {
    // El fichero de bloqueo se fue con el directorio; `release` no falla si ya no está.
    lock?.release();
  }
}
