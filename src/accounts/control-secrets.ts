/**
 * Lo global no vive en los secretos de una persona (D22, SPEC.md §12.10): los bearers de
 * Lumbre de todas las cuentas, sus pendientes y la clave de refresh de Sumego pasan del
 * `secrets.json` de `legacy-root` a `control/secrets.json`, sin cambiar ningún valor.
 *
 * `migrateControlSecrets` corre al arrancar, antes de atender tráfico y con el bloqueo de
 * control tomado por `startServeHttp`. El orden es lo que la hace reanudable:
 *
 * 1. Copia atómica de los campos que falten, en una sola escritura.
 * 2. Comprobación releyendo el destino, y `fsync` de fichero y directorios.
 * 3. Retirada de los campos del origen, también en una sola escritura.
 * 4. Barrido de los temporales del origen que aún citen esos campos.
 *
 * Una caída en cualquier punto deja el valor en el origen, en los dos con el mismo valor,
 * o solo en el destino; el arranque siguiente sigue desde ahí. Mientras el servidor atiende
 * tráfico el origen no tiene estos campos, así que un valor distinto en los dos solo puede
 * salir de una mano ajena o de arrancar una imagen anterior sin `rollbackControlSecrets`.
 * Entonces no se elige fuente: el arranque se detiene sin tocar nada
 * (`control_secrets_conflict`). La excepción es la marca que deja la vuelta atrás, porque
 * con ella el origen es la fuente vigente y lo que escribió la imagen anterior gana.
 *
 * Un `control/secrets.json` corrupto también detiene el arranque: tratarlo como vacío, que
 * es lo que hace `FileSecretStore.get`, generaría una clave de refresh nueva y dejaría a
 * todas las personas sin concesión. Solo se migra el modo fichero: en el llavero del SO
 * (§6.1, nunca en ficheros) estos secretos siguen en su entrada y no hay fichero de nadie.
 *
 * Ni los errores ni los logs de este módulo llevan valores; como mucho, nombres de clave.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireServerLock } from '../lock';
import { logEvent } from '../log/logger';
import { CONTROL_ROLLBACK_MARK, CONTROL_SECRET_KEYS, FileSecretStore, fileSecretStorePath, openFileSecretStore, syncDirectory,
  type SecretFileState, type SecretStore, type StoredSecrets } from '../secrets';
import { accountControlDir } from './control-ipc';

export type ControlSecretsErrorCode =
  /** `control/secrets.json` existe y no se entiende. */
  | 'control_secrets_corrupt'
  /** `secrets.json` no se entiende y aún podía ser la única copia. */
  | 'control_secrets_source_corrupt'
  /** Los dos ficheros tienen un valor distinto para el mismo campo, sin marca de vuelta atrás. */
  | 'control_secrets_conflict'
  /** Lo releído no coincide con lo copiado: no se retira nada. */
  | 'control_secrets_verify_failed'
  /** Otro proceso tiene el bloqueo de control. */
  | 'control_secrets_busy';

/** Su `code` es lo que `main.ts` escribe en stderr; el mensaje no lleva valores. */
export class ControlSecretsError extends Error {
  constructor(readonly code: ControlSecretsErrorCode, message: string) {
    super(message);
    this.name = 'ControlSecretsError';
  }
}

export interface ControlSecretsMigration {
  /** Campos que había en `secrets.json` y ya no están. */
  retired: string[];
  /** Campos escritos en `control/secrets.json`. */
  copied: string[];
}

export interface ControlSecretsRollback {
  /** Campos escritos en `secrets.json`; `control/secrets.json` los conserva. */
  restored: string[];
}

function pick(values: StoredSecrets): StoredSecrets {
  const result: StoredSecrets = {};
  for (const key of CONTROL_SECRET_KEYS) {
    if (values[key] !== undefined) result[key] = values[key];
  }
  return result;
}

function controlValues(state: SecretFileState): StoredSecrets {
  if (state.status === 'corrupt') {
    throw new ControlSecretsError('control_secrets_corrupt', 'control/secrets.json no se puede interpretar.');
  }
  return state.status === 'present' ? state.values : {};
}

function conflict(key: string): ControlSecretsError {
  return new ControlSecretsError('control_secrets_conflict',
    `secrets.json y control/secrets.json discrepan en ${key}: no se elige fuente.`);
}

/** Comprueba releyendo que `expected` está escrito tal cual en `store`. */
async function assertHolds(store: FileSecretStore, expected: StoredSecrets): Promise<void> {
  const state = await store.inspect();
  const held = state.status === 'present' ? state.values : {};
  for (const [key, value] of Object.entries(expected)) {
    if (held[key as keyof StoredSecrets] !== value) {
      throw new ControlSecretsError('control_secrets_verify_failed', `No se pudo comprobar la copia de ${key}.`);
    }
  }
}

/** El almacén `control/secrets.json` de este directorio de datos. */
export function openControlSecretStore(dataDir: string): FileSecretStore {
  return openFileSecretStore(accountControlDir(dataDir));
}

/** Pasa los secretos globales de `source` (`secrets.json`) a `control`. Repetirla sin nada
 *  que mover no escribe. El llamante tiene el bloqueo de control. */
export async function migrateControlSecrets(source: FileSecretStore, control: FileSecretStore): Promise<ControlSecretsMigration> {
  const controlState = await control.inspect();
  const held = controlValues(controlState);
  const rolledBack = held[CONTROL_ROLLBACK_MARK] !== undefined;
  const sourceState = await source.inspect();
  if (sourceState.status === 'corrupt') {
    // Con una migración ya hecha, `secrets.json` solo guarda lo de una persona: que no se
    // entienda es asunto suyo y no impide atender a las demás. Antes de migrar, o tras una
    // vuelta atrás, podía ser la única copia.
    if (controlState.status === 'absent' || rolledBack) {
      throw new ControlSecretsError('control_secrets_source_corrupt', 'secrets.json no se puede interpretar.');
    }
    return { retired: [], copied: [] };
  }
  const found = sourceState.status === 'present' ? pick(sourceState.values) : {};
  const copies: StoredSecrets = {};
  for (const [name, value] of Object.entries(found)) {
    const key = name as keyof StoredSecrets;
    if (held[key] === undefined || (rolledBack && held[key] !== value)) copies[key] = value;
    else if (held[key] !== value) throw conflict(key);
  }
  const copied = Object.keys(copies);
  if (copied.length > 0 || rolledBack) {
    await mkdir(dirname(control.path), { recursive: true, mode: 0o700 });
    await control.update({ set: copies, remove: [CONTROL_ROLLBACK_MARK] });
  }
  const retired = Object.keys(found);
  if (retired.length > 0) {
    await assertHolds(control, found);
    // Antes de retirar: si no, un corte de luz podría conservar la retirada y perder la copia.
    await control.flush();
    await syncDirectory(dirname(dirname(control.path)));
    await source.update({ remove: CONTROL_SECRET_KEYS });
    await source.flush();
  }
  await source.deleteTemporaryFilesHolding(CONTROL_SECRET_KEYS);
  await control.deleteTemporaryFilesHolding(CONTROL_SECRET_KEYS);
  if (retired.length > 0) logEvent({ event: 'control_secrets.migrated', keys: retired.length });
  return { retired, copied };
}

/**
 * El almacén de los secretos globales para `serve-http`. Con `legacy` en fichero, migra y
 * devuelve `control/secrets.json`; con otro almacén (llavero, tests), devuelve el mismo.
 */
export async function openControlSecrets(dataDir: string, legacy: SecretStore): Promise<SecretStore> {
  if (!(legacy instanceof FileSecretStore)) return legacy;
  const control = openControlSecretStore(dataDir);
  await migrateControlSecrets(legacy, control);
  return control;
}

/**
 * Vuelta atrás a una imagen que espera estos campos en `secrets.json`. Copia de vuelta sin
 * borrar `control/secrets.json`. Primero deja la marca: desde ese instante lo que escriba la
 * imagen anterior es lo vigente, y al volver hacia delante gana sobre la copia de control.
 * Repetirla tras una caída o con la imagen anterior ya en marcha no pisa nada de lo suyo.
 */
export async function restoreControlSecrets(source: FileSecretStore, control: FileSecretStore): Promise<ControlSecretsRollback> {
  const controlState = await control.inspect();
  const held = controlValues(controlState);
  if (controlState.status === 'absent') return { restored: [] };
  const sourceState = await source.inspect();
  if (sourceState.status === 'corrupt') {
    throw new ControlSecretsError('control_secrets_source_corrupt', 'secrets.json no se puede interpretar.');
  }
  const current = sourceState.status === 'present' ? sourceState.values : {};
  const rolledBack = held[CONTROL_ROLLBACK_MARK] !== undefined;
  const wanted = pick(held);
  const copies: StoredSecrets = {};
  for (const [name, value] of Object.entries(wanted)) {
    const key = name as keyof StoredSecrets;
    if (current[key] === undefined) copies[key] = value;
    else if (current[key] !== value && !rolledBack) throw conflict(key);
  }
  if (!rolledBack) {
    await control.update({ set: { [CONTROL_ROLLBACK_MARK]: '1' } });
    await control.flush();
  }
  const restored = Object.keys(copies);
  if (restored.length > 0) {
    await source.update({ set: copies });
    await assertHolds(source, copies);
    await source.flush();
  }
  logEvent({ event: 'control_secrets.rollback', keys: restored.length });
  return { restored };
}

/**
 * `hebra-mcp control-secrets-rollback`: con el servicio parado, bajo su mismo bloqueo. El que
 * toma `serve-http` es `control/server.lock` (`acquireServerLock`, que lo ve cualquier proceso
 * que abra el fichero, también el de otro contenedor sobre el volumen); un `WriterLock` sobre
 * `control/` no lo vería nunca.
 */
export async function rollbackControlSecrets(dataDir: string): Promise<ControlSecretsRollback> {
  const directory = accountControlDir(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = acquireServerLock(dataDir, directory);
  if (!lock) {
    throw new ControlSecretsError('control_secrets_busy', 'Otro proceso de hebra-mcp tiene el bloqueo de control.');
  }
  try {
    return await restoreControlSecrets(new FileSecretStore(fileSecretStorePath(dataDir)), openControlSecretStore(dataDir));
  } finally {
    lock.release();
  }
}
