/**
 * Credencial de emparejado revocada (SPEC.md §12.9, decisión de la sesión de Lumbre del 21 oct
 * 2026). Cerrar sesión en todas partes en Sumego revoca la credencial de emparejado de
 * hebra-mcp; el proceso sigue sano (`/healthz` 200), pero ya no puede sincronizar ni conseguir
 * concesiones nuevas. Se sabe por dos caminos:
 *
 * - El relé rechaza la credencial (401/403): el runner de sync ya lo deja en `revoked: true`
 *   y emite `pairing.revoked` una vez (`src/sync/runner.ts`).
 * - Lumbre responde `410 {"error":"pairing_revoked"}` en `/requests` o en `sumego/exchange`:
 *   el OAuth llama a `markRevoked`, que emite `pairing.revoked` una vez si el relé no lo
 *   había dicho ya.
 *
 * Un 400 de Lumbre NO es una revocación (cuerpo mal formado): sigue siendo «no disponible».
 * La marca de Lumbre va atada a la credencial con la que se vio: si después hay otro
 * emparejado (`hebra-mcp pair` en modo `credential_renewed`), deja de valer.
 */
import { logEvent } from '../log/logger';
import type { HebraStatus, StatusSource } from './status-source';

/** El motivo que dan `hebra_status` y la página de `/authorize`. */
export const PAIRING_REVOKED_REASON =
  'La conexión con la biblioteca se cortó al cerrar sesión en todas partes (o al revocarla en Lumbre). ' +
  'Hay que reemparejar con `hebra-mcp pair` en modo `credential_renewed`, que conserva la identidad y la clave de la biblioteca.';

export class PairingRevocation {
  /** Credencial que Lumbre dio por revocada; `null` si Lumbre no ha dicho nada. */
  private revokedCredential: string | null = null;

  /** `relayRevoked`: el `revoked` del runner de sync, si lo hay. */
  constructor(private readonly relayRevoked: () => boolean = () => false) {}

  /**
   * ¿Está revocado el emparejado? Con `currentCredentialId`, una marca de Lumbre sobre otra
   * credencial (ya reemparejado) se olvida.
   */
  isRevoked(currentCredentialId?: string | null): boolean {
    if (this.relayRevoked()) return true;
    if (this.revokedCredential === null) return false;
    if (currentCredentialId != null && currentCredentialId !== this.revokedCredential) {
      this.revokedCredential = null;
      return false;
    }
    return true;
  }

  /** Lumbre dijo `pairing_revoked` para esta credencial. El evento sale una sola vez. */
  markRevoked(credentialId: string): void {
    const already = this.isRevoked(credentialId);
    this.revokedCredential = credentialId;
    if (!already) logEvent({ event: 'pairing.revoked', source: 'lumbre' });
  }
}

/** `hebra_status` con la marca de Lumbre sumada al `revoked` del relé. */
export class PairingStatusSource implements StatusSource {
  constructor(
    private readonly inner: StatusSource,
    private readonly pairing: PairingRevocation
  ) {}

  async getStatus(): Promise<HebraStatus> {
    const status = await this.inner.getStatus();
    return this.pairing.isRevoked() ? { ...status, revoked: true } : status;
  }
}
