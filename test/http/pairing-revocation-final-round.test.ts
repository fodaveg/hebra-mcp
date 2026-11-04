import { describe, expect, it } from 'vitest';
import { bindPairingRevocation } from '../../src/http/serve-http';
import type { ServeContext } from '../../src/server/serve';
import { PairingRevocation } from '../../src/status/pairing-revocation';

/**
 * La ronda final de un cierre (D22, §12.10) corre dentro de `close` y puede recibir el 401 del
 * relé: la marca de la credencial tiene que recogerlo, aunque la instancia ya haya soltado su
 * runner y aunque el cierre falle.
 */

const CREDENTIAL = 'mikel-credential';

/** Como `LibraryInstance.close`: la ronda final revoca al runner y luego se suelta. */
function closingContext(options: { revokeInFinalRound: boolean; closeFails?: boolean }) {
  const runner = { revoked: false };
  const instance = { beginShutdown() {}, syncRunner: runner as { revoked: boolean } | null };
  const context = {
    ctx: { status: { getStatus: () => ({}) } },
    instance,
    linked: true,
    close: async () => {
      if (options.revokeInFinalRound) runner.revoked = true;
      instance.syncRunner = null;
      if (options.closeFails) throw new Error('cierre fallido');
    }
  } as unknown as ServeContext;
  return context;
}

describe('bindPairingRevocation: ronda final', () => {
  it('un 401 de la ronda final queda en la marca de la credencial', async () => {
    const pairing = new PairingRevocation();
    const bound = bindPairingRevocation(closingContext({ revokeInFinalRound: true }), pairing, CREDENTIAL);
    expect(pairing.isRevoked(CREDENTIAL)).toBe(false);
    await bound.close();
    expect(pairing.isRevoked(CREDENTIAL)).toBe(true);
  });

  it('tambien si el cierre falla, y el error original sale', async () => {
    const pairing = new PairingRevocation();
    const bound = bindPairingRevocation(
      closingContext({ revokeInFinalRound: true, closeFails: true }),
      pairing,
      CREDENTIAL
    );
    await expect(bound.close()).rejects.toThrow('cierre fallido');
    expect(pairing.isRevoked(CREDENTIAL)).toBe(true);
  });

  it('una credencial vigente no se marca al cerrar', async () => {
    const pairing = new PairingRevocation();
    const bound = bindPairingRevocation(closingContext({ revokeInFinalRound: false }), pairing, CREDENTIAL);
    await bound.close();
    expect(pairing.isRevoked(CREDENTIAL)).toBe(false);
  });
});
