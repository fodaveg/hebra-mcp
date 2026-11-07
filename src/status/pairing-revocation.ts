/**
 * Credencial de emparejado revocada (SPEC.md §12.9, decisión de la sesión de Lumbre del 21 oct
 * 2026). Cerrar sesión en todas partes en Sumego revoca la credencial de emparejado de
 * hebra-mcp; el proceso sigue sano (`/healthz` 200), pero ya no puede sincronizar ni conseguir
 * concesiones nuevas. Se sabe por dos caminos:
 *
 * - El relé rechaza la credencial (401/403): el runner de sync ya lo deja en `revoked: true`
 *   y emite `pairing.revoked` una vez (`src/sync/runner.ts`). Es también lo que pasa al
 *   desactivar el agente en Ajustes de Hebra, y la misma credencial vuelve a valer al
 *   reactivarlo: el runner reintenta solo y lo recupera sin reiniciar (D24). Motivo:
 *   `AGENT_REVOKED_REASON`.
 * - Lumbre responde `410 {"error":"pairing_revoked"}` en `/requests` o en `sumego/exchange`:
 *   el OAuth llama a `markRevoked`, que emite `pairing.revoked` una vez si el relé no lo
 *   había dicho ya. Motivos: `PAIRING_REVOKED_REASON` y `PAIRING_REVOKED_REMOTE_REASON`, que
 *   piden renovar la conexión.
 *
 * Un 400 de Lumbre NO es una revocación (cuerpo mal formado): sigue siendo «no disponible».
 * La marca va atada a la credencial con la que se vio, y por tanto a una sola cuenta (D22):
 * si después hay otro emparejado (`hebra-mcp pair` en modo `credential_renewed`), la
 * credencial nueva no está marcada. No depende de que el contexto de la cuenta esté abierto.
 */
import { logEvent } from '../log/logger';
import type { HebraStatus, StatusSource } from './status-source';

/**
 * El motivo cuando el relé (o Lumbre al registrar la clave de agente) rechaza la credencial
 * (D24): agente revocado o desactivado desde Hebra, que no se distinguen. Igual en stdio y en
 * remoto, porque no pide nada a quien lo lee salvo reactivar el agente.
 */
export const AGENT_REVOKED_REASON =
  'Hebra no acepta ahora la conexión de este agente porque está revocado o desactivado desde Hebra. ' +
  'hebra-mcp lo vuelve a intentar solo y recupera el acceso en cuanto lo reactives en Ajustes de Hebra, ' +
  'sin reiniciar ni volver a emparejar. Mientras tanto, la biblioteca personal responde con lo que ya tenía ' +
  'descargado y los espacios compartidos no están disponibles.';

/** El motivo del `410 pairing_revoked` de Lumbre (cierre de sesión en todas partes) en `hebra_status`
 *  y en la página de `/authorize`, donde se puede lanzar `hebra-mcp pair`. */
export const PAIRING_REVOKED_REASON =
  'La conexión con la biblioteca se cortó al cerrar sesión en todas partes (o al revocarla en Lumbre). ' +
  'Hay que reemparejar con `hebra-mcp pair` en modo `credential_renewed`, que conserva la identidad y la clave de la biblioteca.';

/** El mismo `410` en el conector remoto, donde nadie puede lanzar `hebra-mcp pair` (D22). */
export const PAIRING_REVOKED_REMOTE_REASON =
  'La conexión con la biblioteca se cortó al cerrar sesión en todas partes (o al revocarla en Lumbre). ' +
  'Vuelve a conectar Hebra desde tu aplicación: al iniciar sesión podrás renovarla, sin perder tus notas.';

export class PairingRevocation {
  /** Credenciales que Lumbre dio por revocadas (D22: por cuenta, la credencial es de una sola persona). */
  private readonly revokedCredentials = new Set<string>();
  /** Credenciales que el relé rechazó y ya no tienen un runner abierto que lo diga. */
  private readonly relayLatched = new Set<string>();
  /** Runners abiertos por credencial; se sueltan al cerrar el contexto (`attachRelay`). */
  private readonly relayLive = new Map<string, () => boolean>();
  /** Por credencial: el runner abierto y cuántas rondas correctas lleva. */
  private readonly relayRounds = new Map<string, { id: number; okRounds: () => number }>();
  /**
   * Por credencial marcada: en qué punto estaba la cuenta cuando se marcó (el runner abierto y sus
   * rondas correctas hasta ese momento). Solo una ronda correcta POSTERIOR levanta la marca; sin
   * reloj, con contadores.
   */
  private readonly marks = new Map<string, { attachId: number | null; okRounds: number }>();
  /** Por credencial: que el runner abierto reintente ya, si está revocado (D24). */
  private readonly relayRetry = new Map<string, () => void>();
  private attachSeq = 0;

  /** `relayRevoked`: el `revoked` global del runner de sync en modo de una sola cuenta, si lo hay. */
  constructor(private readonly relayRevoked: () => boolean = () => false) {}

  /**
   * Registra el `revoked` del runner abierto de una credencial. El estado vive aquí, por
   * credencial; al cerrar el contexto, el valor se fija y la función (y la instancia que
   * captura) se suelta, así que cerrar no da un estado falso ni retiene la instancia.
   * Devuelve la función que desacopla.
   */
  attachRelay(
    credentialId: string,
    revoked: () => boolean,
    okRounds: () => number = () => 0,
    /** Que el runner abierto reintente ya (`SyncRunner.retryNow`, D24); lo usa `credentialWorks`. */
    retryNow: () => void = () => undefined
  ): () => void {
    // No se toca `relayLatched`: una cuenta revocada que se cerró por inactividad y se reabre
    // tiene un runner nuevo que aún no ha hablado con el relé, y no por eso deja de estar
    // revocada. La levantan la renovación (`clear`), una credencial con otro id o una prueba de
    // que ya funciona: una ronda correcta de ese runner POSTERIOR a la marca o un GET de lectura
    // correcto al hacer login (agente desactivado y reactivado en Hebra, sin reconectar).
    this.attachSeq += 1;
    this.relayLive.set(credentialId, revoked);
    this.relayRounds.set(credentialId, { id: this.attachSeq, okRounds });
    this.relayRetry.set(credentialId, retryNow);
    return () => {
      if (this.relayLive.get(credentialId) !== revoked) return;
      this.relayRetry.delete(credentialId);
      let value = false;
      let ok = false;
      try { value = revoked(); } catch { /* instancia ya cerrada: sin dato nuevo */ }
      try { ok = this.recoveredSince(credentialId); } catch { /* idem */ }
      this.relayLive.delete(credentialId);
      this.relayRounds.delete(credentialId);
      if (ok && !value) this.clear(credentialId);
      else if (value) {
        this.relayLatched.add(credentialId);
        this.marks.set(credentialId, { attachId: null, okRounds: 0 });
      }
    };
  }

  /** ¿El runner abierto tuvo una ronda correcta después de la marca de esta credencial? */
  private recoveredSince(credentialId: string): boolean {
    const attached = this.relayRounds.get(credentialId);
    if (!attached) return false;
    const mark = this.marks.get(credentialId);
    const base = mark && mark.attachId === attached.id ? mark.okRounds : 0;
    return attached.okRounds() > base;
  }

  /** Anota dónde estaba el runner abierto al marcar, para que solo cuente lo posterior. */
  private markNow(credentialId: string): void {
    const attached = this.relayRounds.get(credentialId);
    let okRounds = 0;
    try { okRounds = attached?.okRounds() ?? 0; } catch { /* instancia ya cerrada */ }
    this.marks.set(credentialId, { attachId: attached?.id ?? null, okRounds });
  }

  /**
   * ¿Está revocado el emparejado? Con `currentCredentialId`, solo cuenta lo de esa credencial:
   * la revocación de otra cuenta no la toca. Sin credencial solo responde el `revoked` global
   * del relé (modo de una sola cuenta).
   */
  isRevoked(currentCredentialId?: string | null): boolean {
    if (this.relayRevoked()) return true;
    if (currentCredentialId == null) return false;
    if (this.revokedCredentials.has(currentCredentialId) || this.relayLatched.has(currentCredentialId)) {
      // Una ronda correcta del runner abierto prueba que el relé vuelve a aceptar la credencial.
      if (!this.recoveredSince(currentCredentialId)) return true;
      this.clear(currentCredentialId);
    }
    return this.relayLive.get(currentCredentialId)?.() ?? false;
  }

  /**
   * Olvida lo que se sabía de esta credencial: la marca de Lumbre y la del relé ya cerrado. Lo
   * llama la renovación (`commitRenewal`): una credencial renovada con la misma bóveda puede
   * conservar su id, y sin esto seguiría revocada hasta reiniciar. El runner abierto, si lo
   * hay, sigue diciendo lo suyo. También lo llama el login cuando un GET de lectura sale bien.
   */
  clear(credentialId: string): void {
    this.revokedCredentials.delete(credentialId);
    this.relayLatched.delete(credentialId);
    this.marks.delete(credentialId);
  }

  /**
   * Un GET de lectura con esta credencial acaba de salir bien (el login, `remote-pairing.ts`): se
   * olvida la marca y, si la cuenta tiene el contexto abierto con el runner revocado, este
   * reintenta ya en vez de esperar su plazo (D24). Es la única señal de reactivación que llega a
   * hebra-mcp: Lumbre no avisa por ningún otro canal.
   */
  credentialWorks(credentialId: string): void {
    this.clear(credentialId);
    try { this.relayRetry.get(credentialId)?.(); } catch { /* instancia ya cerrada */ }
  }

  /**
   * ¿La revocación que sigue vigente para esta credencial es el `410 pairing_revoked` de Lumbre
   * (cierre de sesión en todas partes), y no solo un rechazo del relé? Decide el motivo: el de
   * Lumbre pide renovar la conexión, el del relé no (D24).
   */
  revokedByLumbre(credentialId: string | null | undefined): boolean {
    if (credentialId == null || !this.revokedCredentials.has(credentialId)) return false;
    return !this.recoveredSince(credentialId);
  }

  /** Lumbre dijo `pairing_revoked` para esta credencial. El evento sale una sola vez. */
  markRevoked(credentialId: string): void {
    const already = this.isRevoked(credentialId);
    this.revokedCredentials.add(credentialId);
    this.markNow(credentialId);
    if (!already) logEvent({ event: 'pairing.revoked', source: 'lumbre' });
  }
}

/**
 * Pone motivo a un estado revocado que aún no lo trae. Sin marca de Lumbre, la revocación es la
 * del relé (el runner): `AGENT_REVOKED_REASON` (D24).
 */
export function withRevokedReason(status: HebraStatus, reason = AGENT_REVOKED_REASON): HebraStatus {
  return status.revoked === true && status.revokedReason === undefined
    ? { ...status, revokedReason: reason } : status;
}

/** Un `StatusSource` de `serve-http`: si dice revocado sin motivo, el del relé. */
export class RemoteStatusSource implements StatusSource {
  constructor(private readonly inner: StatusSource) {}
  async getStatus(): Promise<HebraStatus> { return withRevokedReason(await this.inner.getStatus()); }
}

/**
 * `hebra_status` con la marca de Lumbre sumada al `revoked` del relé, para la credencial de su
 * cuenta. Con el `410 pairing_revoked` de Lumbre vigente, su motivo remoto (renovar desde el
 * conector); si no, el del relé (reintenta solo, D24).
 */
export class PairingStatusSource implements StatusSource {
  constructor(
    private readonly inner: StatusSource,
    private readonly pairing: PairingRevocation,
    private readonly credentialId: () => string | null | Promise<string | null> = () => null
  ) {}

  async getStatus(): Promise<HebraStatus> {
    const status = await this.inner.getStatus();
    const credentialId = await this.credentialId();
    const revoked = this.pairing.isRevoked(credentialId) ? { ...status, revoked: true } : status;
    return withRevokedReason(revoked,
      this.pairing.revokedByLumbre(credentialId) ? PAIRING_REVOKED_REMOTE_REASON : AGENT_REVOKED_REASON);
  }
}
