/**
 * Petición de vínculo y aprobación (SPEC.md §7.2-§7.3), con `device-link.ts` y
 * `device-link-transport.ts` de Hebra SIN cambios: el mismo camino que el lado N de
 * `LibrarySettingsSyncIdentity.svelte` (Ajustes > Sincronización), en una terminal.
 *
 * 1. `DeviceLinkRequester.start` con plataforma `agent` (L5, petición P3: un dispositivo
 *    sin pantalla que Hebra enseña como «Claude») y la etiqueta saneada por
 *    `sanitizeDeviceLabel`. La terminal enseña lo que David verá en Hebra: esa etiqueta y
 *    la plataforma.
 * 2. Sondeo cada `DEVICE_LINK_POLL_MS` (2 s). Un fallo pasajero (red, 429, 5xx) espera
 *    4, 8 y como mucho 16 s, como Hebra; cualquier otro cancela la solicitud.
 * 3. Al ver `granted`, el requester desenvuelve el código con SUS valores y
 *    `verifyGrantedAccess` comprueba (H1) que la clave abre un sobre REAL de la bóveda de
 *    quien aprobó, anterior a la solicitud, y devuelve hasta 3 títulos.
 * 4. Los títulos se imprimen en la TERMINAL (nunca en stderr ni en ningún log) y David
 *    confirma que son sus notas. Si no, se cancela y no se guarda nada.
 *
 * Devuelve el código de recuperación y el requester para que `./pair.ts` lo complete
 * (el relé borra el envoltorio) DESPUÉS de guardar los secretos.
 */
import {
  DEVICE_LINK_POLL_MS,
  DeviceLinkRequester,
  HttpDeviceLinkTransport,
  HttpLibraryTransport,
  deviceLinkResultOf,
  displayDeviceLabel,
  isTransientDeviceLinkFailure,
  verifyGrantedAccess,
  type DeviceLinkVaultPage,
  type GrantedAccessPreview,
  type LumbreConnection
} from '../hebra';
import { PairError } from './errors';
import type { Fetcher } from './lumbre';
import type { PairTerminal } from './terminal';

/** Plataforma que declara hebra-mcp (SPEC.md L5; plataforma propia, petición P3). */
export const LINK_PLATFORM = 'agent' as const;
const RETRY_MAX_MS = 16_000;

export interface GrantedAccess {
  recoveryCode: string;
  requester: DeviceLinkRequester;
}

export interface RequestAccessOptions {
  connection: LumbreConnection;
  /** Ya saneada con `sanitizeDeviceLabel(…, 'agent')`. */
  label: string;
  fetcher: Fetcher;
  terminal: PairTerminal;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Paso cerrado para stderr (sin contenido). */
  onStep?: (step: string, result: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function relayReader(connection: LumbreConnection, fetcher: Fetcher) {
  const transport = new HttpLibraryTransport(
    async () => ({
      apiOrigin: connection.apiOrigin,
      readToken: connection.readToken,
      writeToken: connection.writeToken
    }),
    fetcher
  );
  return async (syncVaultId: string, since: number, limit: number): Promise<DeviceLinkVaultPage> => {
    const page = await transport.getChanges(syncVaultId, since, limit);
    return { records: page.records, next: page.next, more: page.more };
  };
}

function printPreview(terminal: PairTerminal, preview: GrantedAccessPreview): void {
  terminal.print('');
  terminal.print('Hebra ha dado acceso. Comprueba que es TU biblioteca antes de vincular:');
  const titles = preview.titles.map((title) => displayDeviceLabel(title) ?? 'Sin título');
  for (const title of titles) terminal.print(`  · ${title}`);
  const records = preview.more ? `más de ${preview.recordsRead}` : String(preview.recordsRead);
  terminal.print(
    `  (biblioteca creada el ${preview.vaultCreatedAt}; ${records} registros leídos; ` +
      `${preview.vaultCount} biblioteca(s) en la cuenta)`
  );
}

async function cancelQuietly(requester: DeviceLinkRequester): Promise<void> {
  try {
    await requester.cancel();
  } catch {
    // Si no se puede cancelar, caduca sola en el relé a los 10 minutos.
  }
}

export async function requestLibraryAccess(options: RequestAccessOptions): Promise<GrantedAccess> {
  const { connection, terminal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? DEVICE_LINK_POLL_MS;
  const transport = new HttpDeviceLinkTransport({ get: async () => connection }, options.fetcher);

  let requester: DeviceLinkRequester;
  try {
    requester = await DeviceLinkRequester.start(transport, {
      label: options.label,
      platform: LINK_PLATFORM
    });
  } catch (error) {
    throw new PairError('link_failed', deviceLinkResultOf(error));
  }
  options.onStep?.('link.create', 'ok');

  const minutes = Math.max(1, Math.round(requester.initialRemainingMs / 60_000));
  terminal.print('');
  terminal.print('Abre Hebra en el Mac o el iPhone: Ajustes > Sincronización.');
  terminal.print('Verás una solicitud de acceso de este dispositivo:');
  terminal.print(`  «${requester.label}» · ${displayDeviceLabel(null, LINK_PLATFORM)}`);
  terminal.print(`Apruébala SOLO si ves exactamente ese nombre. Caduca en ${minutes} min.`);
  terminal.print('Esperando la aprobación…');

  const readChanges = relayReader(connection, options.fetcher);
  let retryDelay = 0;
  for (;;) {
    await sleep(retryDelay > 0 ? retryDelay : pollMs);
    let step = 'link.poll';
    try {
      const result = await requester.poll();
      retryDelay = 0;
      if (result.kind === 'waiting') continue;
      if (result.kind === 'expired') throw new PairError('link_expired');
      if (result.kind === 'denied') throw new PairError('link_denied');
      if (result.kind === 'cancelled') throw new PairError('link_cancelled');
      step = 'link.verify';
      const preview = await verifyGrantedAccess({
        recoveryCode: result.recoveryCode,
        apiOrigin: connection.apiOrigin,
        requestCreatedAt: requester.createdAt,
        approverSyncVaultId: result.approverSyncVaultId,
        approverVaultCreatedAt: result.approverVaultCreatedAt,
        vaultCount: result.vaultCount,
        readChanges
      });
      options.onStep?.('link.verify', 'ok');
      printPreview(terminal, preview);
      const mine = await terminal.confirm('¿Son tus notas? Escribe «si» para vincular');
      if (!mine) {
        options.onStep?.('link.confirm', 'not_confirmed');
        await cancelQuietly(requester);
        throw new PairError('not_confirmed');
      }
      return { recoveryCode: result.recoveryCode, requester };
    } catch (error) {
      if (error instanceof PairError) throw error;
      if (isTransientDeviceLinkFailure(error)) {
        retryDelay = Math.min(retryDelay === 0 ? pollMs * 2 : retryDelay * 2, RETRY_MAX_MS);
        options.onStep?.(step, deviceLinkResultOf(error));
        continue;
      }
      const code = deviceLinkResultOf(error);
      options.onStep?.(step, code);
      await cancelQuietly(requester);
      throw new PairError('link_failed', code);
    }
  }
}
