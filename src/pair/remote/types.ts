import type { ActiveGrant, Binding } from '../../oauth/backchannel';
import type { LumbreConnection } from '../../hebra';
import type { PairedSecrets } from '../../secrets';
import type { PreparedAgentDevice } from '../../spaces/device';

export type RemotePairingPhase =
  | 'credential'
  | 'exchange-pending'
  | 'approval'
  | 'owner-check'
  | 'confirmation'
  | 'committing'
  | 'cleanup-pending'
  | 'finished'
  | 'cancelled';

/** La cuenta que renueva esta alta (§12.10, "Reconectar tras una revocación"). */
export interface RemotePairingRenewal {
  /** `id` del registro de cuentas, no el `accountId` de Lumbre. */
  id: string;
  generation: number;
  accountId: string;
  syncVaultId: string;
  /** Se conserva con la misma bóveda; sin identidad legible, la renovación estrena una. */
  opaqueDeviceId?: string;
}

export interface RenewalTarget extends RemotePairingRenewal {
  lumbreDeviceId?: string;
}

/** Estado durable mínimo. Los títulos nunca se escriben aquí. */
export interface RemotePairingJournal {
  version: 1;
  id: string;
  oauthRequestId: string;
  sub: string;
  cookieHash: string;
  csrfHash: string;
  phase: RemotePairingPhase;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  identityExpiresAt: string;
  deviceId: string;
  verifier: string;
  pairingCode?: string;
  connection?: LumbreConnection;
  preparedAgent?: PreparedAgentDevice;
  paired?: PairedSecrets;
  ownership?: VerifiedOwnership;
  cleanupRequired: boolean;
  committedAccountId?: string;
  renewal?: RemotePairingRenewal;
  /** La aprobación trajo otra bóveda: confirmar retira antes la cuenta de `renewal`. */
  replacesAccount?: boolean;
}

export interface VerifiedOwnership {
  sub: string;
  grant: ActiveGrant;
}

/** El conector que inició el alta: su nombre y el host de su callback, solo para mostrarlos. */
export interface ClientLabel {
  name: string;
  callbackHost: string;
}

export interface PairingPreview {
  titles: string[];
  vaultCreatedAt: string;
  recordsRead: number;
  more: boolean;
  /** Es otra biblioteca que la conectada: la página avisa de lo que hará confirmar. */
  replacesLibrary?: boolean;
  /**
   * Otra biblioteca: escrituras de la cuenta anterior que aún no subieron y se perderían al
   * confirmar (SQLite personal y de espacios). `null`: no se pudieron leer. Ausente: no aplica.
   */
  pendingWrites?: number | null;
  /** Quién pidió la conexión: lo mismo que enseña el consentimiento normal. */
  client?: ClientLabel;
}

export interface RemotePairingSession {
  id: string;
  oauthRequestId: string;
  sub: string;
  expiresAt: string;
}

export interface RemotePairingFormAuthorization {
  cookie: string;
  formToken: string;
}

export interface CommittedAccount {
  id: string;
  generation: number;
}

export interface PublishPairingInput {
  ownership: VerifiedOwnership;
  paired: PairedSecrets;
  preparedDir: string;
  journalId: string;
}

export interface RemotePairingPublisher {
  publish(input: PublishPairingInput): Promise<CommittedAccount>;
  /** Recuperación de la caída entre publicar la cuenta y sellar el diario. */
  findCommitted(journal: RemotePairingJournal): Promise<CommittedAccount | null>;
  /** Retira `accounts/<journalId>` si el rename ocurrió pero el registro no se publicó. */
  cleanupOrphan(journal: RemotePairingJournal): Promise<void>;
}

export interface PublishRenewalInput {
  renewal: RemotePairingRenewal;
  journalId: string;
  ownership: VerifiedOwnership;
  paired: PairedSecrets;
  /** Ausente si Lumbre respondió 404 al registrar la clave: los espacios la registran al usarse. */
  preparedAgent?: PreparedAgentDevice;
}

/** Renovar una cuenta activa. Sin esta pieza, una revocación no se puede resolver aquí. */
export interface RemotePairingRenewals {
  /** La cuenta de este `sub` que se puede renovar, o `null` si no tiene ninguna. */
  target(sub: string): Promise<RenewalTarget | null>;
  /** La clave de agente guardada: una credencial que sobrevive exige la misma pública. */
  agentKey(renewal: RemotePairingRenewal): Promise<JsonWebKey | undefined>;
  /**
   * El canje rota los tokens de la credencial que sobrevive. Si luego Lumbre rechaza (401) el
   * registro de la clave de agente (agente desactivado o credencial revocada: no se distinguen),
   * los tokens guardados ya no valen. Guarda los nuevos de esa misma credencial, sin tocar nada
   * más, para que al reactivar el agente la cuenta vuelva sin otro login. `false` si la
   * credencial canjeada tiene otro id que la guardada: no hay nada que conservar.
   */
  keepRotatedTokens(renewal: RemotePairingRenewal, connection: LumbreConnection): Promise<boolean>;
  /** Misma bóveda: conserva raíz e identidad y publica vínculo y generación nueva a la vez. */
  publish(input: PublishRenewalInput): Promise<CommittedAccount>;
  /**
   * Cuántas escrituras sin subir tiene la cuenta anterior (cuenta exacta de sus SQLite, no la
   * lista de subidas pendientes), o `null` si no se pueden leer. Sin ella, se trata como `null`.
   */
  pendingWrites?(renewal: RemotePairingRenewal): Promise<number | null>;
  /** Otra bóveda: retira la cuenta anterior por el camino normal. */
  retire(renewal: RemotePairingRenewal): Promise<void>;
  /** Suelta la publicación a medias de este diario, si la había. Idempotente. */
  abort(journal: RemotePairingJournal): Promise<void>;
}

export interface OwnershipVerifier {
  verify(input: { sub: string; binding: Binding; oauthRequestId: string }): Promise<VerifiedOwnership>;
}

export type RemotePairingStatus =
  | { kind: 'waiting'; remainingMs: number }
  | { kind: 'reauthenticate' }
  | { kind: 'preview'; preview: PairingPreview };

export class RemotePairingError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'expired'
      | 'invalid_session'
      | 'invalid_form'
      | 'wrong_account'
      | 'replayed'
      | 'not_ready'
      | 'denied'
      | 'unavailable'
      /** Lumbre no reconoce el código: sin efecto remoto y la transacción sigue viva. */
      | 'code_rejected'
      /** Lumbre limita los canjes por IP (429): no se procesó nada y la transacción sigue viva. */
      | 'rate_limited'
      /** Demasiados códigos rechazados en esta transacción o por esta persona: la transacción termina. */
      | 'too_many_codes'
      /** Otra biblioteca con escrituras sin subir (o sin poder contarlas): falta la confirmación aparte. */
      | 'loss_unconfirmed'
      /** La sesión de Lumbre de este navegador es de otra cuenta; aún no hay aprobación. */
      | 'wrong_lumbre_account'
      /**
       * Lumbre rechazó (401) el registro de la clave de agente: agente desactivado o credencial
       * revocada, indistinguibles. Nada se borra; una renovación conserva los tokens nuevos.
       */
      | 'agent_rejected',
    /** Motivo cerrado para el log (nunca mensajes, tokens, sub ni email). */
    readonly reason?: string,
    /** Segundos de espera para `rate_limited`. */
    readonly retryAfterSeconds?: number
  ) {
    super(code);
    this.name = 'RemotePairingError';
  }
}
