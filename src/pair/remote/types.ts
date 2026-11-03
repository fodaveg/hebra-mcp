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
}

export interface VerifiedOwnership {
  sub: string;
  grant: ActiveGrant;
}

export interface PairingPreview {
  titles: string[];
  vaultCreatedAt: string;
  recordsRead: number;
  more: boolean;
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
  ) {
    super(code);
    this.name = 'RemotePairingError';
  }
}
