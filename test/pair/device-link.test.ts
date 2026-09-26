/**
 * `requestLibraryAccess` (`../../src/pair/device-link.ts`) con la plataforma propia de
 * hebra-mcp (L5, 26 sep 2026): `LINK_PLATFORM = 'agent'`. Aquí, sin el OAuth/loopback de
 * `pair.ts` (eso lo prueba `pair-flow.test.ts` de punta a punta): la solicitud llega al
 * relé con `platform: 'agent'` y el vínculo cierra con el código nuevo (`PLATFORM_CODE.
 * agent = 5` en Hebra, `035db7e6`) contra `MemoryDeviceLinkRelay`, el mismo doble del
 * relé que usan los tests de `device-link` de Hebra.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeRecoveryCode,
  grantDeviceLink,
  HttpDeviceLinkTransport,
  sanitizeDeviceLabel,
  type LumbreConnection
} from '../../src/hebra';
import { LINK_PLATFORM, requestLibraryAccess } from '../../src/pair/device-link';
import type { PairTerminal } from '../../src/pair/terminal';
import { IDENTITY, VAULT_KEY, appCreate, appDevice } from '../sync/devices';
import { FakeLumbre, LUMBRE } from './fake-lumbre';

function scriptedTerminal(): { terminal: PairTerminal; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    terminal: {
      print: (line) => void lines.push(line),
      confirm: async () => true
    }
  };
}

/** La misma espera que `approveWhenAsked` de `pair-flow.test.ts`, pero sobre la
 *  credencial del requester en vez de sobre el código de recuperación devuelto. */
async function firstPendingRequest(transport: HttpDeviceLinkTransport) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { requests } = await transport.list();
    if (requests.length > 0) return requests[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('la solicitud no llegó al relé');
}

describe('requestLibraryAccess: plataforma agent contra MemoryDeviceLinkRelay', () => {
  let fake: FakeLumbre;
  let requester: LumbreConnection;
  let approver: LumbreConnection;
  let recoveryCode: string;

  beforeEach(async () => {
    fake = await FakeLumbre.start();
    fake.addLibraryVault('david', IDENTITY.syncVaultId);
    approver = fake.addLinkedApprover('david', IDENTITY.syncVaultId, 'cred-mac');
    const app = await appDevice(fake.relay);
    await appCreate(app, '# Lista de la compra\n\nTexto.');
    expect((await app.sync.runRound()).result).toBe('ok');
    // `addLinkedApprover` da de alta la credencial en `deviceLinks` Y registra sus tokens
    // de lectura/escritura en `fake.tokens` (los que autentican `/library/v1/…`, que
    // `verifyGrantedAccess` necesita para leer la bóveda): lo mismo que deja `/exchange`
    // real tras el emparejado, sin repetir aquí el OAuth completo.
    requester = fake.addLinkedApprover('david', IDENTITY.syncVaultId, 'cred-mcp-1');
    recoveryCode = await encodeRecoveryCode({
      relayOrigin: LUMBRE,
      syncVaultId: IDENTITY.syncVaultId,
      keyEpoch: 1,
      vaultKey: VAULT_KEY
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  /** El lado que aprueba (A, «el Mac»): ve la solicitud, comprueba la plataforma y el
   *  código de Hebra (`PLATFORM_CODE.agent = 5`), y da acceso con el código real. */
  async function grantWhenAsked(): Promise<void> {
    const transport = new HttpDeviceLinkTransport({ get: async () => approver }, fake.fetcher);
    const request = await firstPendingRequest(transport);
    expect(request.platform).toBe('agent');
    expect(request.label).toBe('Claude');
    await grantDeviceLink(transport, request, recoveryCode);
  }

  it("la solicitud declara platform 'agent' y el vínculo cierra con el código nuevo", async () => {
    const { terminal, lines } = scriptedTerminal();
    const label = sanitizeDeviceLabel('', LINK_PLATFORM);
    expect(label).toBe('Claude');

    const granted = grantWhenAsked();
    const access = await requestLibraryAccess({
      connection: requester,
      label,
      fetcher: fake.fetcher,
      terminal,
      pollMs: 5,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))
    });
    await granted;

    expect(access.recoveryCode).toBe(recoveryCode);
    expect(lines).toContain(`  «${label}» · Claude`);
  });
});
