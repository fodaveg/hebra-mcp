import type { ActiveGrant, Binding } from '../oauth/backchannel';

export type AccountStorage = 'legacy-root' | 'account-dir';
export type AccountState = 'active' | 'removing' | 'removed';

export interface AccountRef {
  id: string;
  generation: number;
}

export interface AccountRecord extends AccountRef {
  sub: string;
  accountId: string;
  binding: Binding;
  storage: AccountStorage;
  state: AccountState;
  removalPhase?: 'blocked' | 'remote-revoked' | 'data-erased';
  /** Diario que está publicando una renovación: mientras tanto la cuenta no autoriza a nadie. */
  renewing?: string;
  /** Diario que publicó la generación vigente; la recuperación lo usa para no revocarla. */
  renewedBy?: string;
}

export interface AuthorizedAccount extends AccountRef {
  binding: Binding;
  storage: AccountStorage;
}

/** Propiedad demostrada por una concesión de Lumbre, nunca por datos del navegador. */
export interface VerifiedOwnership {
  sub: string;
  grant: ActiveGrant;
}

