import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { decodeRecoveryCode, sanitizeDeviceLabel } from '../../hebra';
import { sameBinding, type Binding } from '../../oauth/backchannel';
import { openFileSecretStore, writePairedSecrets, type PairedSecrets } from '../../secrets';
import { linkedSyncFrom, registerLinkedDevice } from '../../sync/linked';
import {
  AgentKeyNotFoundError,
  AgentKeyUnauthorizedError,
  prepareAgentDevice,
  savePreparedAgentDevice
} from '../../spaces/device';
import { logEvent } from '../../log/logger';
import { PairError } from '../errors';
import { DEFAULT_PAIR_LABEL } from '../pair';
import {
  DEFAULT_LUMBRE_ORIGIN,
  exchangePairingCode,
  pairingUrl,
  type Fetcher
} from '../lumbre';
import { hebraAccountIdOf } from './account-id';
import { RemotePairingJournalStore } from './journal';
import { startRemoteLink, type RemoteLinkRequest } from './link';
import { revokeRemoteCredential, RevokeError } from './revoke';
import {
  RemotePairingError,
  type OwnershipVerifier,
  type ClientLabel,
  type PairingPreview,
  type RemotePairingJournal,
  type RemotePairingFormAuthorization,
  type RemotePairingPublisher,
  type RemotePairingRenewals,
  type RemotePairingSession,
  type RemotePairingStatus,
  type VerifiedOwnership
} from './types';

export const REMOTE_PAIRING_ORIGIN = 'https://mcp.hebra.pro';
export const REMOTE_PAIRING_TTL_MS = 10 * 60_000;

type GrantedPoll = Extract<Awaited<ReturnType<RemoteLinkRequest['poll']>>, { kind: 'granted' }>;

interface RuntimePairing {
  cookie: string;
  csrf: string;
  /** Solo en memoria: el aviso previo nombra la cuenta; no entra en el diario, URLs ni logs. */
  email: string | null;
  authorizationUrl: string;
  client?: ClientLabel;
  link?: RemoteLinkRequest;
  granted?: GrantedPoll;
  preview?: PairingPreview;
  ownership?: VerifiedOwnership;
  /** Códigos que Lumbre rechazó en esta transacción. */
  rejectedCodes?: number;
}

/** Lo que enseña el aviso previo, antes de salir hacia Lumbre. */
/** La espera creciente por diario que lleva quien llama a `recover` de forma repetida. */
export interface RecoverRetry {
  ready(journalId: string): boolean;
  failed(journalId: string): void;
  succeeded(journalId: string): void;
}

export interface RemotePairingNotice {
  client?: ClientLabel;
  email: string | null;
  renewal: boolean;
  authorizationUrl: string;
  formToken: string;
}

export interface RemotePairingServiceOptions {
  journals: RemotePairingJournalStore;
  ownership: OwnershipVerifier;
  publisher: RemotePairingPublisher;
  renewals?: RemotePairingRenewals;
  publicOrigin?: string;
  lumbreOrigin?: string;
  fetcher?: Fetcher;
  /** Fetcher de la cuenta de ese `sub` (identidad ante Lumbre, P14); sin él, `fetcher`. */
  fetcherFor?: (sub: string) => Fetcher;
  now?: () => number;
  exchangeCode?: typeof exchangePairingCode;
  prepareAgent?: typeof prepareAgentDevice;
  startLink?: typeof startRemoteLink;
  revoke?: typeof revokeRemoteCredential;
  registerDevice?: (paired: PairedSecrets, fetcher: Fetcher) => Promise<string>;
}

export interface StartRemotePairingInput {
  oauthRequestId: string;
  sub: string;
  identityExpiresAt: string;
  label?: string;
  /** Presentación en el aviso previo; nunca decide nada. */
  email?: string | null;
  /** La credencial de esta persona está revocada o rechazada: renovar en vez de dar de alta. */
  renew?: boolean;
  /** El conector que inició el alta (nombre registrado y callback); solo se muestra. */
  client?: { name: string; redirectUri: string };
}

export interface StartedRemotePairing {
  id: string;
  cookie: string;
  formToken: string;
  authorizationUrl: string;
}

/** Nombre y host del callback como los muestra el consentimiento normal (el nombre ya viene acotado). */
function clientLabel(client: { name: string; redirectUri: string }): ClientLabel {
  let callbackHost = '';
  try { callbackHost = new URL(client.redirectUri).host; } catch { /* sin host que mostrar */ }
  return { name: client.name.slice(0, 120), callbackHost };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalDigest(expected: string, value: string): boolean {
  const actual = digest(value);
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function validFuture(value: string, now: number): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now;
}

/** Detalle cerrado de un fallo remoto: clase y estado/código del relé, nunca el mensaje. */
function errorDetail(error: unknown): string {
  if (error instanceof PairError) return `${error.code}${error.detail === undefined ? '' : `:${error.detail}`}`;
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * ¿Prueba esta respuesta de `/exchange` que no queda ninguna credencial viva de este intento?
 * El canje con PKCE deja un recibo y repetirlo devuelve la misma credencial mientras siga activa
 * (`exchangeHebraPairingCodeWithRecovery` de Lumbre), así que su 401 significa código basura,
 * caducado o credencial ya revocada, y su 400 un cuerpo que nunca llegó a la transacción. Cualquier
 * otro estado (404, 410, 5xx, red) sigue siendo ambiguo y conserva la intención para resolverla.
 */
/** 429 de `/exchange`: el limitador de Lumbre corta antes de mirar el código, sin efecto alguno. */
function exchangeRateLimited(error: unknown): error is PairError {
  return error instanceof PairError && error.code === 'exchange_failed' && error.detail === 429;
}

/** Códigos que Lumbre puede rechazar antes de cortar la transacción y la ventana por persona. */
export const MAX_REJECTED_CODES_PER_TRANSACTION = 5;
export const MAX_REJECTED_CODES_PER_SUB = 10;
export const REJECTED_CODES_WINDOW_MS = 60 * 60_000;
/** Espera que se pide si Lumbre no da `Retry-After`. */
const DEFAULT_EXCHANGE_RETRY_SECONDS = 60;

function exchangeLeftNoEffect(error: unknown): boolean {
  return error instanceof PairError && error.code === 'exchange_rejected' &&
    (error.detail === 400 || error.detail === 401);
}

/** Orquesta el emparejado sin confiar nunca en identidad ni sesión recibidas del formulario. */
export class RemotePairingService {
  private readonly runtime = new Map<string, RuntimePairing>();
  /** Instantes de los códigos rechazados por persona. Gasta el límite de canjes por IP de Lumbre. */
  private readonly rejectedBySub = new Map<string, number[]>();
  private readonly locks = new Map<string, Promise<void>>();
  /** Diarios que están publicando: retirar la cuenta anterior no puede limpiarse a sí mismo. */
  private readonly publishing = new Set<string>();
  private readonly fetcher: Fetcher;
  private readonly fetcherFor: (sub: string) => Fetcher;
  private readonly now: () => number;
  private readonly publicOrigin: string;
  private readonly exchangeCode: typeof exchangePairingCode;
  private readonly prepareAgent: typeof prepareAgentDevice;
  private readonly startLink: typeof startRemoteLink;
  private readonly revoke: typeof revokeRemoteCredential;
  private readonly registerDevice: (paired: PairedSecrets, fetcher: Fetcher) => Promise<string>;

  constructor(private readonly options: RemotePairingServiceOptions) {
    this.publicOrigin = options.publicOrigin ?? REMOTE_PAIRING_ORIGIN;
    if (this.publicOrigin !== REMOTE_PAIRING_ORIGIN) throw new Error('invalid_remote_pairing_origin');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.fetcherFor = options.fetcherFor ?? (() => this.fetcher);
    this.now = options.now ?? Date.now;
    this.exchangeCode = options.exchangeCode ?? exchangePairingCode;
    this.prepareAgent = options.prepareAgent ?? prepareAgentDevice;
    this.startLink = options.startLink ?? startRemoteLink;
    this.revoke = options.revoke ?? revokeRemoteCredential;
    this.registerDevice = options.registerDevice ?? (async (paired, fetcher) => {
      const linked = await linkedSyncFrom(paired, { fetcher });
      return linked ? registerLinkedDevice(linked, fetcher) : 'account_mismatch';
    });
  }

  async start(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    return this.exclusive(`sub:${input.sub}`, () => this.startUnlocked(input));
  }

  private async startUnlocked(input: StartRemotePairingInput): Promise<StartedRemotePairing> {
    if (!input.oauthRequestId || !input.sub || !validFuture(input.identityExpiresAt, this.now())) {
      throw new RemotePairingError('invalid_session');
    }
    for (const candidate of await this.options.journals.list()) {
      if (candidate.sub !== input.sub || ['finished', 'cancelled'].includes(candidate.phase)) continue;
      await this.exclusive(candidate.id, async () => {
        const existing = await this.options.journals.read(candidate.id);
        if (!existing || ['finished', 'cancelled'].includes(existing.phase)) return;
        // Un login nuevo y válido del mismo `sub` sustituye al intento anterior sin terminar,
        // caducado o no: el usuario legítimo ya probó su identidad con un ID token nuevo y el
        // intento previo queda inutilizado (runtime borrado). `cleanup` solo retira el intento
        // tras resolver sus efectos remotos (revoca la credencial, nunca una cuenta publicada).
        // Lo que no se pueda resolver ahora no detiene a esta persona (D22, "Alta sin atascos"):
        // su diario sigue en disco, sin sesión, y lo reintentan `recover` y el barrido.
        try { await this.cleanup(existing); }
        catch (error) {
          logEvent({ event: 'remote_pairing.superseded', result: 'cleanup_pending',
            reason: error instanceof RemotePairingError ? error.reason ?? error.code : errorDetail(error) });
        }
      });
    }
    const target = input.renew ? await this.options.renewals?.target(input.sub) ?? null : null;
    const id = randomUUID();
    const cookie = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const deviceId = target?.lumbreDeviceId ?? randomUUID();
    const label = sanitizeDeviceLabel(input.label ?? DEFAULT_PAIR_LABEL, 'agent');
    const createdAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + REMOTE_PAIRING_TTL_MS).toISOString();
    const { url, verifier } = await pairingUrl({
      lumbreOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
      deviceId,
      label,
      webOrigin: this.publicOrigin
    });
    const journal: RemotePairingJournal = {
      version: 1,
      id,
      oauthRequestId: input.oauthRequestId,
      sub: input.sub,
      cookieHash: digest(cookie),
      csrfHash: digest(csrf),
      phase: 'credential',
      createdAt,
      updatedAt: createdAt,
      expiresAt,
      identityExpiresAt: input.identityExpiresAt,
      deviceId,
      verifier,
      cleanupRequired: false,
      ...(target ? { renewal: { id: target.id, generation: target.generation, accountId: target.accountId,
        syncVaultId: target.syncVaultId, opaqueDeviceId: target.opaqueDeviceId } } : {})
    };
    await this.options.journals.write(journal);
    this.runtime.set(id, { cookie, csrf, email: input.email ?? null, authorizationUrl: url,
      ...(input.client ? { client: clientLabel(input.client) } : {}) });
    return { id, cookie, formToken: csrf, authorizationUrl: url };
  }

  /** El aviso previo de una transacción que aún espera volver de Lumbre; si no, `null`. */
  async noticeForCookie(cookie: string): Promise<RemotePairingNotice | null> {
    for (const [id, runtime] of this.runtime) {
      if (runtime.cookie !== cookie) continue;
      return this.exclusive(id, async () => {
        const current = this.runtime.get(id);
        if (!current || current.cookie !== cookie) return null;
        const journal = await this.requireJournal(id);
        if (!equalDigest(journal.cookieHash, cookie)) return null;
        await this.ensureAlive(journal);
        if (journal.phase !== 'credential') return null;
        return { email: current.email, renewal: journal.renewal !== undefined,
          ...(current.client ? { client: current.client } : {}),
          authorizationUrl: current.authorizationUrl, formToken: current.csrf };
      });
    }
    return null;
  }

  /** ¿Espera esta transacción el código de Lumbre? Solo entonces la página puente puede enviarlo. */
  /** La transacción ya tuvo un código rechazado: su página puente exige un clic (SPEC.md §12.10). */
  hasRejectedCode(id: string): boolean {
    return (this.runtime.get(id)?.rejectedCodes ?? 0) > 0;
  }

  async awaitsCredential(id: string): Promise<boolean> {
    return (await this.options.journals.read(id).catch(() => null))?.phase === 'credential';
  }

  async sessionForCookie(cookie: string): Promise<RemotePairingSession | null> {
    for (const [id, runtime] of this.runtime) {
      if (runtime.cookie !== cookie) continue;
      return this.exclusive(id, async () => {
        const current = this.runtime.get(id);
        if (!current || current.cookie !== cookie) return null;
        const journal = await this.requireJournal(id);
        if (!equalDigest(journal.cookieHash, cookie)) return null;
        await this.ensureAlive(journal);
        return this.sessionOf(journal);
      });
    }
    return null;
  }

  async pageForCookie(cookie: string): Promise<{
    session: RemotePairingSession;
    formToken: string;
  } | null> {
    for (const [id, runtime] of this.runtime) {
      if (runtime.cookie !== cookie) continue;
      return this.exclusive(id, async () => {
        const current = this.runtime.get(id);
        if (!current || current.cookie !== cookie) return null;
        const journal = await this.requireJournal(id);
        if (!equalDigest(journal.cookieHash, cookie)) return null;
        await this.ensureAlive(journal);
        return { session: this.sessionOf(journal), formToken: current.csrf };
      });
    }
    return null;
  }

  async session(id: string): Promise<RemotePairingSession> {
    return this.sessionOf(await this.requireJournal(id));
  }

  async formToken(id: string): Promise<string> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      return this.requireRuntime(id).csrf;
    });
  }

  private async authorizeFormLocked(
    journal: RemotePairingJournal,
    runtime: RuntimePairing,
    authorization: RemotePairingFormAuthorization
  ): Promise<void> {
    const { cookie, formToken } = authorization;
    if (
      runtime.cookie !== cookie || runtime.csrf !== formToken ||
      !equalDigest(journal.cookieHash, cookie) || !equalDigest(journal.csrfHash, formToken)
    ) throw new RemotePairingError('invalid_form');
    // Cada POST consume su token antes de ejecutar cualquier efecto remoto.
    runtime.csrf = randomBytes(32).toString('base64url');
    journal.csrfHash = digest(runtime.csrf);
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
  }

  private rejectedRecently(sub: string): number {
    const since = this.now() - REJECTED_CODES_WINDOW_MS;
    const recent = (this.rejectedBySub.get(sub) ?? []).filter((at) => at > since);
    if (recent.length > 0) this.rejectedBySub.set(sub, recent); else this.rejectedBySub.delete(sub);
    return recent.length;
  }

  async receiveCredential(
    id: string,
    authorization: RemotePairingFormAuthorization,
    code: string
  ): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      if (journal.phase !== 'credential') throw new RemotePairingError('replayed');
      if (!code || code.length > 4_096) throw new RemotePairingError('invalid_form');
      // Cada canje gasta el límite de Lumbre por IP, que comparten todas las personas: quien ya
      // acumuló rechazos no vuelve a gastarlo y su transacción termina.
      if (this.rejectedRecently(journal.sub) >= MAX_REJECTED_CODES_PER_SUB) {
        await this.cleanup(journal);
        throw new RemotePairingError('too_many_codes', 'sub_limit');
      }
      // El intent queda durable ANTES del efecto remoto. Sin idempotencia/revocación por
      // deviceId, una respuesta perdida no se puede clasificar como «sin efecto».
      journal.phase = 'exchange-pending';
      journal.cleanupRequired = true;
      journal.pairingCode = code;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      let connection;
      try {
        connection = await this.exchangeCode({
          apiOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
          code,
          deviceId: journal.deviceId,
          verifier: journal.verifier,
          fetcher: this.fetcherFor(journal.sub),
          now: this.now
        });
      } catch (error) {
        if (exchangeLeftNoEffect(error) || exchangeRateLimited(error)) {
          // Un código que Lumbre no reconoce (un enlace `#code=` ajeno, uno caducado) o un 429 no
          // dejan nada que limpiar: la transacción vuelve a esperar el código bueno, con el mismo
          // verifier.
          journal.phase = 'credential';
          journal.cleanupRequired = false;
          journal.pairingCode = undefined;
          journal.updatedAt = new Date(this.now()).toISOString();
          await this.options.journals.write(journal);
          if (exchangeRateLimited(error)) {
            throw new RemotePairingError('rate_limited', 'exchange_failed:429',
              error.retryAfterSeconds ?? DEFAULT_EXCHANGE_RETRY_SECONDS);
          }
          await this.countRejectedCode(journal, runtime);
          throw new RemotePairingError('code_rejected', `exchange_failed:${errorDetail(error)}`);
        }
        this.runtime.delete(id);
        throw new RemotePairingError('unavailable', `exchange_failed:${errorDetail(error)}`);
      }
      journal.connection = connection;
      journal.pairingCode = undefined;
      journal.phase = 'credential';
      journal.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.options.journals.write(journal);
      } catch {
        this.runtime.delete(id);
        try {
          await this.revoke(connection, this.fetcherFor(journal.sub));
          journal.phase = 'cancelled';
          journal.cleanupRequired = false;
          await this.options.journals.write(journal);
          await this.options.journals.remove(id);
        } catch { /* El intent durable bloquea una reactivación hasta recovery. */ }
        throw new RemotePairingError('unavailable');
      }
      let wrongAccount = false;
      try {
        const existingKey = journal.renewal ? await this.options.renewals?.agentKey(journal.renewal) : undefined;
        try {
          journal.preparedAgent = await this.prepareAgent(connection, journal.deviceId, this.fetcherFor(journal.sub), existingKey);
        } catch (error) {
          // 404: espacios apagados, credencial no encontrada o carrera con una desactivación; no se
          // sabe cuál. La biblioteca personal no depende de espacios (SPEC: funciona sin la API de
          // H-L7), así que se sigue sin clave de agente: los espacios la registran al usarse y, si
          // siguen sin poder, dan su error normal. Que la credencial exista lo comprueba el enlace
          // de aprobación que viene ahora, y la propiedad, la concesión de Lumbre.
          if (!(error instanceof AgentKeyNotFoundError)) throw error;
          journal.preparedAgent = undefined;
        }
        // Antes de pedir la aprobación: el registro dice de qué cuenta es la credencial. La prueba
        // de propiedad sigue siendo la concesión de Lumbre, esto ahorra aprobar para nada.
        const expected = journal.renewal?.accountId ?? hebraAccountIdOf(journal.sub);
        wrongAccount = journal.preparedAgent !== undefined && journal.preparedAgent.registration.accountId !== expected;
        if (!wrongAccount) {
          const link = await this.startLink({
            connection,
            label: DEFAULT_PAIR_LABEL,
            fetcher: this.fetcherFor(journal.sub)
          });
          runtime.link = link;
          journal.phase = 'approval';
          journal.updatedAt = new Date(this.now()).toISOString();
          await this.options.journals.write(journal);
        }
      } catch (error) {
        if (error instanceof AgentKeyUnauthorizedError) {
          // 401: agente desactivado o credencial revocada, Lumbre no lo distingue y el sondeo
          // previo tampoco. Una renovación conserva los tokens nuevos de la credencial que
          // sobrevive (el canje rotó los guardados): al reactivar el agente vuelve sin otro login.
          // Esa credencial no se revoca ni se borra nada. Con otro id, o en un alta, el camino de
          // siempre: se revoca lo canjeado.
          let kept = false;
          if (journal.renewal) {
            kept = await this.options.renewals?.keepRotatedTokens(journal.renewal, connection).catch(() => false) ?? false;
          }
          if (kept) { journal.connection = undefined; journal.cleanupRequired = false; }
          await this.cleanup(journal);
          throw new RemotePairingError('agent_rejected', kept ? 'tokens_kept' : 'credential_revoked');
        }
        await this.cleanup(journal);
        throw new RemotePairingError('unavailable');
      }
      if (wrongAccount) {
        await this.restartAfterWrongAccount(journal, runtime);
        // Un código válido de otra cuenta también cuenta como rechazo: sin esto, la misma
        // transacción repetiría canje, PUT y DELETE hasta caducar con el cupo común de Lumbre.
        await this.countRejectedCode(journal, runtime);
        throw new RemotePairingError('wrong_lumbre_account');
      }
    });
  }

  /**
   * Suma un código que no sirvió (rechazado por Lumbre o de otra cuenta) a la transacción y a la
   * persona. Al llegar a cualquiera de los dos topes cierra la transacción y lo dice.
   */
  private async countRejectedCode(journal: RemotePairingJournal, runtime: RuntimePairing): Promise<void> {
    runtime.rejectedCodes = (runtime.rejectedCodes ?? 0) + 1;
    this.rejectedBySub.set(journal.sub, [...(this.rejectedBySub.get(journal.sub) ?? []), this.now()]);
    if (runtime.rejectedCodes >= MAX_REJECTED_CODES_PER_TRANSACTION ||
      this.rejectedRecently(journal.sub) >= MAX_REJECTED_CODES_PER_SUB) {
      await this.cleanup(journal);
      throw new RemotePairingError('too_many_codes', 'rejected_codes');
    }
  }

  /**
   * La credencial se emitió para otra cuenta: se revoca y la misma transacción vuelve a esperar
   * un código, con un verifier nuevo. Si no se puede revocar, el diario queda pendiente sin
   * sesión y esta transacción termina, pero el login siguiente no se atasca.
   */
  private async restartAfterWrongAccount(journal: RemotePairingJournal, runtime: RuntimePairing): Promise<void> {
    try {
      await this.revoke(journal.connection!, this.fetcherFor(journal.sub));
      const { url, verifier } = await pairingUrl({
        lumbreOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
        deviceId: journal.deviceId,
        label: sanitizeDeviceLabel(DEFAULT_PAIR_LABEL, 'agent'),
        webOrigin: this.publicOrigin
      });
      journal.verifier = verifier;
      journal.connection = undefined;
      journal.preparedAgent = undefined;
      journal.cleanupRequired = false;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      runtime.authorizationUrl = url;
    } catch {
      await this.cleanup(journal).catch(() => undefined);
    }
  }

  async poll(
    id: string,
    authorization: RemotePairingFormAuthorization
  ): Promise<RemotePairingStatus> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      if (journal.phase === 'confirmation' && runtime.preview) {
        return { kind: 'preview', preview: runtime.preview };
      }
      if (journal.phase !== 'approval' && journal.phase !== 'owner-check') {
        throw new RemotePairingError('not_ready');
      }
      const link = runtime.link;
      if (!link) throw new RemotePairingError('invalid_session');
      const result = runtime.granted ?? await link.poll();
      if (result.kind === 'waiting') return result;
      if (result.kind !== 'granted') {
        await this.cleanup(journal);
        throw new RemotePairingError(result.kind === 'expired' ? 'expired' : 'denied');
      }
      runtime.granted = result;
      journal.phase = 'owner-check';
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      if (!validFuture(journal.identityExpiresAt, this.now())) return { kind: 'reauthenticate' };
      try {
        return await this.verifyOwnershipAndPreview(journal, runtime, result);
      } catch (error) {
        if (error instanceof RemotePairingError) throw error;
        await this.cleanup(journal);
        throw new RemotePairingError('unavailable');
      }
    });
  }

  async resumeIdentity(id: string, sub: string, identityExpiresAt: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      if ((journal.phase !== 'owner-check' && journal.phase !== 'confirmation') || !this.requireRuntime(id).granted) {
        throw new RemotePairingError('not_ready');
      }
      if (sub !== journal.sub) {
        await this.cleanup(journal);
        throw new RemotePairingError('wrong_account');
      }
      if (!validFuture(identityExpiresAt, this.now())) throw new RemotePairingError('invalid_session');
      journal.identityExpiresAt = identityExpiresAt;
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
    });
  }

  /** La vista previa vigente de una transacción en confirmación, para volver a enseñarla. */
  async previewOf(id: string): Promise<PairingPreview | null> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      return journal.phase === 'confirmation' ? this.requireRuntime(id).preview ?? null : null;
    });
  }

  async confirm(
    id: string,
    authorization: RemotePairingFormAuthorization,
    options: { acknowledgeLoss?: boolean } = {}
  ): Promise<
    | { kind: 'reauthenticate' }
    | { kind: 'confirmed'; account: Awaited<ReturnType<RemotePairingPublisher['publish']>> }
  > {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      if (
        journal.phase !== 'confirmation' || !runtime.preview || !runtime.ownership ||
        !journal.connection || !journal.paired
      ) throw new RemotePairingError(journal.phase === 'committing' ? 'replayed' : 'not_ready');
      if (!validFuture(journal.identityExpiresAt, this.now())) return { kind: 'reauthenticate' };
      if (journal.replacesAccount) {
        // Se recuenta SIEMPRE al confirmar, también si la vista previa dio 0: lo escrito entre la
        // vista previa y aquí se borraría con la cuenta anterior. Escrituras sin subir, o sin
        // poder contarlas, exigen una confirmación aparte; si hay más que en la vista previa (o ya
        // no se pueden contar), la anterior no vale y la página enseña el recuento nuevo.
        const seen = runtime.preview.pendingWrites ?? null;
        const now = await this.options.renewals?.pendingWrites?.(journal.renewal!).catch(() => null) ?? null;
        if (now !== 0) {
          const worse = now === null ? seen !== null : seen !== null && now > seen;
          if (worse) runtime.preview = { ...runtime.preview, pendingWrites: now };
          if (!options.acknowledgeLoss || worse) throw new RemotePairingError('loss_unconfirmed');
        }
      }
      journal.phase = 'committing';
      journal.updatedAt = new Date(this.now()).toISOString();
      await this.options.journals.write(journal);
      let account: Awaited<ReturnType<RemotePairingPublisher['publish']>>;
      this.publishing.add(id);
      try {
        account = await this.publishLocked(journal, runtime, id);
      } catch {
        this.runtime.delete(id);
        const committed = await this.options.publisher.findCommitted(journal);
        if (committed) account = committed;
        else {
          await this.abortPublish(journal);
          throw new RemotePairingError('unavailable');
        }
      } finally {
        this.publishing.delete(id);
      }
      // La cuenta publicada ya no pertenece al alta cancelable, incluso si falla el disco.
      this.runtime.delete(id);
      journal.phase = 'finished';
      journal.cleanupRequired = false;
      journal.committedAccountId = account.id;
      journal.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.options.journals.write(journal);
        await this.options.journals.remove(id);
      } catch { /* Recovery reconoce la publicación durable antes de limpiar el diario. */ }
      return { kind: 'confirmed', account };
    });
  }

  /**
   * Confirmar deja la cuenta lista, sin abrir su contexto: lo abre su primera llamada (D22). Con
   * la misma bóveda se renueva sobre su raíz; con otra, se retira antes la cuenta anterior y se da
   * de alta la nueva en su propio directorio, sin mezclar datos.
   */
  private async publishLocked(
    journal: RemotePairingJournal,
    runtime: RuntimePairing,
    id: string
  ): Promise<Awaited<ReturnType<RemotePairingPublisher['publish']>>> {
    const { paired, preparedAgent } = journal;
    const ownership = runtime.ownership;
    if (!paired || !ownership) throw new RemotePairingError('not_ready');
    const renewal = journal.renewal;
    if (renewal && !journal.replacesAccount) {
      if (!this.options.renewals) throw new RemotePairingError('unavailable', 'renewals_not_attached');
      try { await runtime.link?.complete(); } catch { /* El sobre caduca solo. */ }
      return this.options.renewals.publish({ renewal, journalId: id, ownership, paired, preparedAgent });
    }
    if (renewal) {
      if (!this.options.renewals) throw new RemotePairingError('unavailable', 'renewals_not_attached');
      await this.options.renewals.retire(renewal);
    }
    const preparedDir = this.options.journals.preparedDir(id);
    await mkdir(preparedDir, { recursive: true, mode: 0o700 });
    await chmod(preparedDir, 0o700);
    const secrets = openFileSecretStore(preparedDir);
    if (preparedAgent) await savePreparedAgentDevice(secrets, paired, preparedAgent);
    await writePairedSecrets(secrets, paired);
    try { await runtime.link?.complete(); } catch { /* El sobre caduca solo. */ }
    return this.options.publisher.publish({ ownership, paired, preparedDir, journalId: id });
  }

  async cancel(id: string, authorization: RemotePairingFormAuthorization): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      await this.ensureAlive(journal);
      const runtime = this.requireRuntime(id);
      await this.authorizeFormLocked(journal, runtime, authorization);
      await this.cleanup(journal);
    });
  }

  /** Callback OAuth autenticado: solo puede abandonar la transacción original enlazada. */
  async abandon(id: string, oauthRequestId: string): Promise<void> {
    return this.exclusive(id, async () => {
      const journal = await this.requireJournal(id);
      if (journal.oauthRequestId !== oauthRequestId) throw new RemotePairingError('invalid_session');
      await this.cleanup(journal);
    });
  }

  /** Retirada administrativa ya autenticada por el control local; no depende de CSRF web. */
  async cleanupForSub(sub: string): Promise<void> {
    for (const candidate of await this.options.journals.list()) {
      if (candidate.sub !== sub || this.publishing.has(candidate.id)) continue;
      await this.exclusive(candidate.id, async () => this.cleanup(await this.requireJournal(candidate.id)));
    }
  }

  /**
   * Antes de aceptar tráfico y desde el barrido global (D22): limpia los diarios sin sesión viva y
   * los caducados, y no toca una transacción que una persona tiene abierta. Sin diarios, no hace
   * ninguna petición. Nunca reanuda claves efímeras perdidas.
   *
   * `retry` es la espera creciente del barrido: un diario cuya limpieza falla (un 404 o 410 que
   * persiste al recuperar su canje) no se vuelve a intentar hasta que le toque, porque cada intento
   * gasta el límite de canjes de Lumbre por IP.
   */
  async recover(options: { retry?: RecoverRetry } = {}): Promise<{ cleaned: number; pending: number }> {
    const { retry } = options;
    let cleaned = 0;
    let pending = 0;
    for (const candidate of await this.options.journals.list()) {
      if (retry && !retry.ready(candidate.id)) continue;
      try {
        const handled = await this.exclusive(candidate.id, async () => {
          const journal = await this.options.journals.read(candidate.id);
          if (journal && this.runtime.has(journal.id) && Date.parse(journal.expiresAt) > this.now()) return false;
          if (journal) await this.cleanup(journal);
          return true;
        });
        if (handled) cleaned += 1;
        retry?.succeeded(candidate.id);
      } catch {
        retry?.failed(candidate.id);
        pending += 1;
      }
    }
    return { cleaned, pending };
  }

  private async verifyOwnershipAndPreview(
    journal: RemotePairingJournal,
    runtime: RuntimePairing,
    granted: GrantedPoll
  ): Promise<RemotePairingStatus> {
    if (!journal.connection) throw new RemotePairingError('invalid_session');
    const recovered = await decodeRecoveryCode(granted.recoveryCode);
    // Con la misma bóveda se conserva el dispositivo (`credential_renewed`, §7): Lumbre reactiva el
    // `opaqueDeviceId` al registrarlo con la credencial nueva. Otra bóveda estrena el suyo.
    const sameVault = journal.renewal?.syncVaultId === recovered.syncVaultId;
    const paired: PairedSecrets = {
      connection: journal.connection,
      recoveryCode: granted.recoveryCode,
      device: { opaqueDeviceId: (sameVault && journal.renewal?.opaqueDeviceId) || randomBytes(16).toString('hex'),
        lumbreDeviceId: journal.deviceId }
    };
    const binding: Binding = {
      pairedCredentialId: journal.connection.credentialId,
      syncVaultId: recovered.syncVaultId,
      opaqueDeviceId: paired.device.opaqueDeviceId
    };
    if (await this.registerDevice(paired, this.fetcherFor(journal.sub)) !== 'ok') {
      await this.cleanup(journal);
      throw new RemotePairingError('unavailable');
    }
    let ownership: VerifiedOwnership;
    try {
      ownership = await this.options.ownership.verify({
        sub: journal.sub,
        binding,
        oauthRequestId: journal.oauthRequestId
      });
    } catch (error) {
      await this.cleanup(journal);
      if (error instanceof RemotePairingError && error.code === 'unavailable') throw error;
      throw new RemotePairingError('wrong_account');
    }
    // Una persona no renueva sobre la cuenta de otra, aunque Lumbre le dé la propiedad de la suya.
    if (ownership.sub !== journal.sub || !sameBinding(binding, ownership.grant) ||
      (journal.renewal && ownership.grant.accountId !== journal.renewal.accountId)) {
      await this.cleanup(journal);
      throw new RemotePairingError('wrong_account');
    }
    const verified = await runtime.link!.verify(granted);
    const replacesAccount = journal.renewal !== undefined && !sameVault;
    // Antes de enseñar la vista previa: retirar la cuenta anterior borra su copia, con lo que no
    // haya subido. Se cuenta ahora para decirlo; si no se puede leer, también se dice.
    const pendingWrites = replacesAccount
      ? await this.options.renewals?.pendingWrites?.(journal.renewal!).catch(() => null) ?? null
      : undefined;
    const preview: PairingPreview = {
      titles: verified.titles.slice(0, 3),
      vaultCreatedAt: verified.vaultCreatedAt,
      recordsRead: verified.recordsRead,
      more: verified.more,
      ...(replacesAccount ? { replacesLibrary: true, pendingWrites } : {}),
      ...(runtime.client ? { client: runtime.client } : {})
    };
    runtime.ownership = ownership;
    runtime.preview = preview;
    journal.ownership = ownership;
    journal.paired = paired;
    journal.replacesAccount = replacesAccount;
    journal.phase = 'confirmation';
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    return { kind: 'preview', preview };
  }

  private async cleanup(journal: RemotePairingJournal): Promise<void> {
    const link = this.runtime.get(journal.id)?.link;
    // El proceso falla cerrado incluso si el disco falla al persistir el bloqueo.
    this.runtime.delete(journal.id);
    // Publicar es irreversible para el alta: nunca revocar una cuenta ya registrada.
    if (journal.phase === 'finished' || journal.phase === 'cancelled' ||
      await this.options.publisher.findCommitted(journal)) {
      await this.options.journals.remove(journal.id);
      return;
    }
    // Sin publicar, esta alta ya no va a publicar: la cuenta deja de estar bloqueada por ella.
    if (journal.renewal) await this.options.renewals?.abort(journal);
    if (journal.cleanupRequired && !journal.connection) {
      // Un error HTTP genérico no prueba que el canje no ocurrió. Conservar el intent
      // hasta recuperar exactamente su resultado y poder revocarlo.
      if (journal.phase !== 'exchange-pending' || !journal.pairingCode) {
        throw new RemotePairingError('unavailable', `cleanup_no_recoverable_intent:${journal.phase}`);
      }
      try {
        journal.connection = await this.exchangeCode({
          apiOrigin: this.options.lumbreOrigin ?? DEFAULT_LUMBRE_ORIGIN,
          code: journal.pairingCode,
          deviceId: journal.deviceId,
          verifier: journal.verifier,
          fetcher: this.fetcherFor(journal.sub),
          now: this.now
        });
        journal.pairingCode = undefined;
      } catch (error) {
        if (!exchangeLeftNoEffect(error)) {
          throw new RemotePairingError('unavailable', `cleanup_exchange_recover_failed:${errorDetail(error)}`);
        }
        // Resuelto: no hay credencial viva que recuperar ni que revocar.
        journal.pairingCode = undefined;
        journal.cleanupRequired = false;
      }
    }
    journal.phase = 'cleanup-pending';
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    try { await link?.cancel(); } catch { /* Caduca en el relé. */ }
    if (journal.connection && journal.cleanupRequired) {
      try {
        await this.revoke(journal.connection, this.fetcherFor(journal.sub));
      } catch (error) {
        throw new RemotePairingError('unavailable',
          error instanceof RevokeError ? `cleanup_revoke_failed:${error.status}` : 'cleanup_revoke_failed');
      }
    }
    await this.options.publisher.cleanupOrphan(journal);
    journal.phase = 'cancelled';
    journal.cleanupRequired = false;
    journal.updatedAt = new Date(this.now()).toISOString();
    await this.options.journals.write(journal);
    await this.options.journals.remove(journal.id);
    this.runtime.delete(journal.id);
  }

  /** Falla del rename/registro: revoca primero y no olvida un orphan no retirado. */
  private async abortPublish(journal: RemotePairingJournal): Promise<void> {
    try {
      await this.cleanup(journal);
    } catch {
      throw new RemotePairingError('unavailable');
    }
  }

  private sessionOf(journal: RemotePairingJournal): RemotePairingSession {
    return {
      id: journal.id,
      oauthRequestId: journal.oauthRequestId,
      sub: journal.sub,
      expiresAt: journal.expiresAt
    };
  }

  private async requireJournal(id: string): Promise<RemotePairingJournal> {
    const journal = await this.options.journals.read(id).catch(() => null);
    if (!journal) throw new RemotePairingError('not_found');
    return journal;
  }

  private requireRuntime(id: string): RuntimePairing {
    const runtime = this.runtime.get(id);
    if (!runtime) throw new RemotePairingError('invalid_session');
    return runtime;
  }

  /** Caducar revoca y limpia. Lo usa también quien sondee un diario desde fuera. */
  async ensureAlive(journal: RemotePairingJournal): Promise<void> {
    if (Date.parse(journal.expiresAt) > this.now()) return;
    await this.cleanup(journal);
    throw new RemotePairingError('expired');
  }

  private async exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(id, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }
}
