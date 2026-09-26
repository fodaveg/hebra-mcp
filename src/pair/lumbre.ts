/**
 * Credencial de Lumbre para hebra-mcp (SPEC.md §7.1): URL de emparejado con PKCE, canje
 * del código y comprobación de cuenta.
 *
 * - `pairingUrl` hace lo mismo que `LumbreClient.pairingUrl` de Hebra
 *   (`src/lib/lumbre/client.ts:426`): `/integrations/hebra?deviceId&label&webOrigin&
 *   code_challenge&code_challenge_method=S256`, con un verifier NUEVO por flujo de
 *   `createPkceVerifier` (32 bytes aleatorios en base64url; obligación 4) y su
 *   `pkceChallengeS256`, las dos de `lumbre/pkce.ts` de Hebra. `LumbreClient` no se usa
 *   entero porque va atado a IndexedDB (verifier en `sessionStorage`, `deviceId` en su
 *   almacén); aquí el verifier vive en la memoria de `pair` y muere con él.
 * - `exchangePairingCode`: `POST /api/integrations/hebra/exchange` con
 *   `{code, deviceId, code_verifier}` y SIN cabecera `Origin` (obligación 6: con
 *   `Origin`, Lumbre responde 403). El `fetch` de Node no la pone; aquí solo se manda
 *   `Content-Type`. Siempre contra el Lumbre CONFIGURADO, nunca el `apiOrigin` que llegue
 *   por el callback (obligación 1).
 * - `checkPairingAccount`: la guarda de `lumbre-pairing.ts` de Hebra con sus tres ramas.
 *   Sin identidad guardada no hay biblioteca atada a ninguna cuenta y se acepta. Con
 *   identidad, un relé distinto se rechaza sin preguntar, y si no se lee la bóveda con la
 *   credencial nueva: 200 se acepta, 404 es OTRA cuenta y se rechaza, y cualquier otro
 *   fallo también rechaza (cerrado ante la duda). Se llama ANTES de guardar nada.
 */
import { createPkceVerifier, pkceChallengeS256 } from '$lib/lumbre/pkce';
import {
  HttpLibraryTransport,
  LibraryTransportError,
  libraryTransportHttpStatusOf,
  type LumbreConnection
} from '../hebra';
import { PairError } from './errors';

export const DEFAULT_LUMBRE_ORIGIN = 'https://app.lumbre.pro';
export const PAIRING_PAGE_PATH = '/integrations/hebra';
export const EXCHANGE_PATH = '/api/integrations/hebra/exchange';
/** Lo mismo que recorta `LumbreClient.pairingUrl`. */
const LABEL_MAX = 120;

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `https://host[:puerto]` sin ruta, query ni credenciales. Lanza `invalid_lumbre_origin`. */
export function normalizeLumbreOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PairError('invalid_lumbre_origin');
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '';
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !bare) {
    throw new PairError('invalid_lumbre_origin');
  }
  return url.origin;
}

/** URL de la página de Lumbre y el verifier de ESTE flujo (no sale de memoria). */
export async function pairingUrl(input: {
  lumbreOrigin: string;
  deviceId: string;
  label: string;
  webOrigin: string;
}): Promise<{ url: string; verifier: string }> {
  const url = new URL(PAIRING_PAGE_PATH, input.lumbreOrigin);
  url.searchParams.set('deviceId', input.deviceId);
  // slice-seguro: la etiqueta ya viene saneada (`sanitizeDeviceLabel`, 64 puntos de
  // código), así que nunca llega a 120 unidades; es el mismo tope que pone Hebra.
  url.searchParams.set('label', input.label.slice(0, LABEL_MAX));
  url.searchParams.set('webOrigin', new URL(input.webOrigin).origin);
  const verifier = createPkceVerifier();
  url.searchParams.set('code_challenge', await pkceChallengeS256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), verifier };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Canje del código. `apiOrigin` es el Lumbre configurado, no el del callback. */
export async function exchangePairingCode(input: {
  apiOrigin: string;
  code: string;
  deviceId: string;
  verifier: string;
  fetcher: Fetcher;
  now?: () => number;
}): Promise<LumbreConnection> {
  let response: Response;
  try {
    response = await input.fetcher(new URL(EXCHANGE_PATH, input.apiOrigin), {
      method: 'POST',
      // Solo `Content-Type`. Ni `Origin` (Lumbre respondería 403) ni nada más.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: input.code,
        deviceId: input.deviceId,
        code_verifier: input.verifier
      }),
      redirect: 'error'
    });
  } catch {
    throw new PairError('exchange_failed', 'offline');
  }
  if ([400, 401, 404, 410].includes(response.status)) {
    await response.body?.cancel();
    throw new PairError('exchange_rejected', response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PairError('exchange_failed', response.status);
  }
  let issued: Record<string, unknown>;
  try {
    issued = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new PairError('exchange_failed', 'invalid_body');
  }
  if (
    !issued ||
    !isNonEmpty(issued.credentialId) ||
    !isNonEmpty(issued.readToken) ||
    !isNonEmpty(issued.writeToken)
  ) {
    throw new PairError('exchange_failed', 'invalid_body');
  }
  return {
    credentialId: issued.credentialId,
    readToken: issued.readToken,
    writeToken: issued.writeToken,
    apiOrigin: input.apiOrigin,
    connectedAt: new Date((input.now ?? Date.now)()).toISOString()
  };
}

/** La bóveda ya vinculada en este equipo, si la hay. */
export interface StoredVault {
  relayOrigin: string;
  syncVaultId: string;
}

/** La guarda de cuenta de `lumbre-pairing.ts` de Hebra (ver la cabecera). */
export async function checkPairingAccount(input: {
  connection: LumbreConnection;
  vault: StoredVault | null;
  fetcher: Fetcher;
}): Promise<void> {
  const { connection, vault } = input;
  if (vault === null) return;
  if (new URL(connection.apiOrigin).origin !== vault.relayOrigin) {
    throw new PairError('account_mismatch', 'relay_origin');
  }
  const transport = new HttpLibraryTransport(
    async () => ({
      apiOrigin: connection.apiOrigin,
      readToken: connection.readToken,
      writeToken: connection.writeToken
    }),
    input.fetcher
  );
  try {
    await transport.getChanges(vault.syncVaultId, 0, 1);
  } catch (error) {
    if (error instanceof LibraryTransportError && libraryTransportHttpStatusOf(error) === 404) {
      throw new PairError('account_mismatch', 404);
    }
    throw new PairError(
      'account_unverified',
      error instanceof LibraryTransportError ? error.code : 'unknown'
    );
  }
}
