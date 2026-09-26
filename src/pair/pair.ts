/**
 * `hebra-mcp pair` (SPEC.md §7): vincula este proceso a la biblioteca de Hebra como un
 * dispositivo más.
 *
 * 1. **Credencial de Lumbre**: listener loopback (`./loopback.ts`), URL de emparejado con
 *    PKCE (`./lumbre.ts`), que se abre en el navegador o se imprime; David aprueba en
 *    Lumbre; el código vuelve al listener; canje contra el Lumbre CONFIGURADO y
 *    comprobación de cuenta. Nada se guarda todavía.
 * 2. **Vínculo**: si este equipo ya tenía identidad (código de recuperación y dispositivo
 *    en el llavero: una revocación, §6.2), solo se renueva la credencial. Si no, petición
 *    de acceso y aprobación en Hebra (`./device-link.ts`), con los títulos en la terminal.
 * 3. **Guardado y arranque**: los tres secretos al llavero (`src/secrets/`), el relé borra
 *    el envoltorio (`complete`), registro del dispositivo en la bóveda y la primera
 *    descarga completa con el `SyncRunner` de L3a, que hace él mismo `libraryConnect` en
 *    su primera ronda (`pull` de `sync-engine.ts`).
 *
 * stderr solo recibe eventos cerrados `pair.step` (`step`, `result`) y los `sync.*` del
 * runner (SPEC.md §6.4): nunca el código, el verifier, los tokens, el código de
 * recuperación ni los títulos. Lo que David tiene que leer va a `terminal`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeRecoveryCode, sanitizeDeviceLabel } from '../hebra';
import { logEvent } from '../log/logger';
import {
  readStoredIdentity,
  writeConnection,
  writePairedSecrets,
  type PairedSecrets,
  type SecretStore
} from '../secrets';
import { LibraryInstance, type OpenLibraryInstanceOptions } from '../sync/library-instance';
import { linkedSyncFrom, registerLinkedDevice } from '../sync/linked';
import type { SyncLogEventName, SyncLogFields } from '../sync/runner';
import { LINK_PLATFORM, requestLibraryAccess } from './device-link';
import { PairError } from './errors';
import { LoopbackError, openLoopbackListener } from './loopback';
import {
  DEFAULT_LUMBRE_ORIGIN,
  checkPairingAccount,
  exchangePairingCode,
  normalizeLumbreOrigin,
  pairingUrl,
  type Fetcher,
  type StoredVault
} from './lumbre';
import type { PairTerminal } from './terminal';

export const DEFAULT_PAIR_LABEL = 'Claude (hebra-mcp)';
/** Tope de espera de la primera descarga completa antes de dar el control a David. */
export const FIRST_SYNC_TIMEOUT_MS = 10 * 60_000;

/** Evento cerrado de un paso de `pair` para stderr. */
export interface PairStepEvent {
  event: 'pair.step';
  step: string;
  result: string;
}

export interface PairOptions {
  dataDir: string;
  secrets: SecretStore;
  terminal: PairTerminal;
  lumbreOrigin?: string;
  label?: string;
  fetcher?: Fetcher;
  /** Abre la URL de emparejado; `false` = no se pudo (se imprime igual). */
  openUrl?: (url: string) => Promise<boolean>;
  /** Eventos cerrados para stderr. Por defecto, `logEvent`. */
  log?: (entry: PairStepEvent | ({ event: SyncLogEventName } & SyncLogFields)) => void;
  /** Tests: listener, sondeo y la instancia (bloqueo). */
  listenerTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  instance?: Pick<OpenLibraryInstanceOptions, 'lock' | 'checkIntervalMs'>;
  firstSyncTimeoutMs?: number;
}

export interface PairResult {
  /** `linked`: vínculo nuevo; `credential_renewed`: identidad ya guardada, credencial nueva. */
  mode: 'linked' | 'credential_renewed';
  register: string;
  /** Resultado de la primera ronda (`ok`, `offline`…), o `null` si no terminó a tiempo. */
  firstSync: string | null;
  pulled: number | null;
}

/** El código y el listener: el código solo sale de aquí hacia el canje. */
async function receivePairingCode(
  options: PairOptions,
  lumbreOrigin: string,
  deviceId: string,
  label: string,
  step: (name: string, result: string) => void
): Promise<{ code: string; verifier: string }> {
  const listener = await openLoopbackListener({ timeoutMs: options.listenerTimeoutMs });
  try {
    const { url, verifier } = await pairingUrl({
      lumbreOrigin,
      deviceId,
      label,
      webOrigin: listener.webOrigin
    });
    const { terminal } = options;
    terminal.print('Paso 1 de 3: autoriza a hebra-mcp en Lumbre.');
    const opened = await (options.openUrl ?? (async () => false))(url);
    terminal.print(
      opened
        ? 'Se ha abierto Lumbre en el navegador. Si no la ves, abre esta URL:'
        : 'Abre esta URL en el navegador del Mac:'
    );
    terminal.print(`  ${url}`);
    terminal.print('Esperando la respuesta de Lumbre (5 min como mucho)…');
    const code = await listener.code;
    step('lumbre.callback', 'ok');
    return { code, verifier };
  } catch (error) {
    if (error instanceof LoopbackError) {
      step('lumbre.callback', error.code);
      throw new PairError('loopback_expired');
    }
    throw error;
  } finally {
    await listener.close();
  }
}

export async function runPair(options: PairOptions): Promise<PairResult> {
  const log = options.log ?? logEvent;
  const step = (name: string, result: string): void =>
    log({ event: 'pair.step', step: name, result });
  const { terminal, secrets } = options;
  const fetcher: Fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const lumbreOrigin = normalizeLumbreOrigin(options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN);
  const label = sanitizeDeviceLabel(options.label ?? DEFAULT_PAIR_LABEL, LINK_PLATFORM);

  // Identidad ya guardada: solo se renueva la credencial (SPEC.md §6.2), comprobando que
  // la cuenta nueva es la de ESA bóveda (`checkPairingAccount`).
  const stored = await readStoredIdentity(secrets);
  let vault: StoredVault | null = null;
  if (stored) {
    const recovered = await decodeRecoveryCode(stored.recoveryCode);
    vault = { relayOrigin: recovered.relayOrigin, syncVaultId: recovered.syncVaultId };
  }
  const deviceId = stored?.device.lumbreDeviceId ?? randomUUID();

  // 1. Credencial de Lumbre.
  const { code, verifier } = await receivePairingCode(options, lumbreOrigin, deviceId, label, step);
  let connection;
  try {
    connection = await exchangePairingCode({ apiOrigin: lumbreOrigin, code, deviceId, verifier, fetcher });
  } catch (error) {
    if (error instanceof PairError) step('lumbre.exchange', error.code);
    throw error;
  }
  step('lumbre.exchange', 'ok');
  try {
    await checkPairingAccount({ connection, vault, fetcher });
  } catch (error) {
    if (error instanceof PairError) step('lumbre.account', error.code);
    throw error;
  }
  step('lumbre.account', 'ok');

  // 2. Vínculo, o solo la credencial.
  let secretsToUse: PairedSecrets;
  let mode: PairResult['mode'];
  if (stored) {
    await writeConnection(secrets, connection);
    secretsToUse = { connection, ...stored };
    mode = 'credential_renewed';
    step('secrets.save', 'ok');
    terminal.print('Credencial de Lumbre renovada para la biblioteca ya vinculada.');
  } else {
    terminal.print('');
    terminal.print('Paso 2 de 3: aprueba el acceso desde Hebra.');
    const access = await requestLibraryAccess({
      connection,
      label,
      fetcher,
      terminal,
      pollMs: options.pollMs,
      sleep: options.sleep,
      onStep: step
    });
    secretsToUse = {
      connection,
      recoveryCode: access.recoveryCode,
      device: { opaqueDeviceId: randomBytes(16).toString('hex'), lumbreDeviceId: deviceId }
    };
    // 3. Guardado: los secretos primero; después el relé borra el envoltorio. Si
    // `complete` falla, el envoltorio caduca solo a los 10 minutos (como en Hebra).
    await writePairedSecrets(secrets, secretsToUse);
    step('secrets.save', 'ok');
    try {
      await access.requester.complete();
      step('link.complete', 'ok');
    } catch {
      step('link.complete', 'failed');
    }
    mode = 'linked';
  }

  terminal.print('');
  terminal.print('Paso 3 de 3: primera descarga de la biblioteca.');
  // La primera `sync.round` del runner: su resultado y cuántos registros bajó.
  let firstRound: { result: string; pulled: number | null } | null = null;
  const linked = await linkedSyncFrom(secretsToUse, {
    fetcher,
    emit: (event, fields) => {
      if (event === 'sync.round' && firstRound === null) {
        firstRound = {
          result: String(fields.result),
          pulled: typeof fields.pulled === 'number' ? fields.pulled : null
        };
      }
      log({ event, ...fields });
    },
    intervalMs: null
  });
  if (!linked) throw new PairError('account_mismatch', 'relay_origin');
  const register = await registerLinkedDevice(linked, fetcher);
  step('relay.register', register);
  if (register !== 'ok') throw new PairError('register_failed', register);

  const instance = await LibraryInstance.open({
    dataDir: options.dataDir,
    // La misma etiqueta de motor que `serve` (`src/server/serve.ts`).
    deviceLabel: 'Claude',
    sync: linked.config,
    checkIntervalMs: options.instance?.checkIntervalMs ?? null,
    lock: options.instance?.lock
  });
  try {
    if (instance.role !== 'this') {
      step('sync.first', 'other_instance');
      throw new PairError('other_instance_running');
    }
    await instance.whenReady(options.firstSyncTimeoutMs ?? FIRST_SYNC_TIMEOUT_MS);
  } finally {
    await instance.close();
  }
  const done = firstRound as { result: string; pulled: number | null } | null;
  step('sync.first', done?.result ?? 'timeout');
  if (done?.result === 'ok') {
    terminal.print(`Biblioteca descargada (${done.pulled ?? 0} registros).`);
  } else {
    terminal.print(
      `La primera descarga no terminó bien (${done?.result ?? 'sin respuesta a tiempo'}). ` +
        '«hebra-mcp serve» la reintenta cada 30 s.'
    );
  }
  terminal.print('');
  terminal.print('Listo. Para usarlo desde Claude Code:');
  terminal.print('  claude mcp add hebra -- hebra-mcp serve');
  return { mode, register, firstSync: done?.result ?? null, pulled: done?.pulled ?? null };
}
