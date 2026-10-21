/**
 * Tokens del OAuth con consentimiento Lumbre (SPEC.md §12.2): opacos, aleatorios y guardados solo
 * como SHA-256. Access de 1 h, como lumbre-mcp (`oauth.ts:25`).
 *
 * - Caducidad de la familia = la de su concesión de Lumbre (`grant.expiresAt`), sin tope
 *   absoluto propio desde la autorización (decisión del 17 oct 2026, H-dec4/H31). Lumbre
 *   da 30 días al autorizar, y cada refresh correcto la renueva por `/renew` (otros 30
 *   días desde la renovación): `rotateRefresh` guarda esa fecha nueva en la familia en la
 *   misma escritura que rota el refresh, antes de entregar tokens, porque la introspección
 *   siguiente la compara exactamente. Una familia caducada o revocada no se renueva.
 *
 * - Familia = una autorización aprobada. Guarda el hash del refresh VIGENTE y los de sus
 *   access aún válidos (como mucho `MAX_ACCESS_PER_FAMILY`: el refresh deja vivos los
 *   access anteriores hasta que caducan, por si hay peticiones en vuelo).
 * - Refresh rotatorio: `hmcp_rt_<familia>.<aleatorio>`. Cada uso emite uno nuevo y el
 *   anterior deja de valer. Presentar uno de esa familia que no es el vigente es una
 *   reutilización (lo robó alguien, o lo usó antes): se revoca la familia ENTERA, access
 *   incluidos. Llevar el id de familia dentro del token permite detectarlo sin guardar
 *   una lista de refresh usados. Excepción: el refresh recién rotado, presentado en los
 *   30 s siguientes a la rotación (dos refresh simultáneos), da `invalid_grant` sin
 *   revocar nada.
 * - Revocación global: una familia creada hasta `revokedBefore` local
 *   (`./owner.ts`) está muerta, aunque siga en el fichero.
 * - Persistencia: `oauth-tokens.json` (0600, escritura atómica), que solo escribe este
 *   proceso. Las mutaciones van en cola y se persisten ANTES de devolver el token nuevo:
 *   un reinicio no resucita un refresh ya rotado. Un fichero corrupto se trata como vacío
 *   (todos los tokens dejan de valer: cerrado ante la duda).
 * - Versión 3 (D20, SPEC.md §12.9): cada familia guarda el `sub` y el `sid` del ID token de
 *   Sumego con el que se autorizó, o `null` si se autorizó con el login de Lumbre. Un fichero
 *   v2 se carga con los dos a `null` y la escritura siguiente ya es v3. Esas familias solo se
 *   cortan con `oauth-revoke-all` o al revocarlas en Lumbre, nunca por back-channel logout.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { logEvent } from '../log/logger';
import { readJsonOrNull, tokensFilePath, writeJsonAtomic } from './files';
import type { ActiveGrant } from './backchannel';

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const MAX_ACCESS_PER_FAMILY = 4;
/** Ventana tras una rotación en la que el refresh recién rotado da `invalid_grant` sin
 *  revocar la familia (hallazgo B3 de la auditoría). */
export const REFRESH_REUSE_GRACE_MS = 30_000;
/** Familias vivas a la vez: una por dispositivo de claude.ai que conecta; de sobra. */
const MAX_FAMILIES = 32;

const ACCESS_PREFIX = 'hmcp_at_';
const REFRESH_PREFIX = 'hmcp_rt_';
const ACCESS_PATTERN = /^hmcp_at_[A-Za-z0-9_-]{43}$/;
const REFRESH_PATTERN = /^hmcp_rt_([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/;

interface AccessEntry {
  hash: string;
  expiresAt: number;
}

interface Family {
  id: string;
  clientId: string;
  scope: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  refreshHash: string;
  /** Hash del refresh anterior y cuándo se rotó: la ventana de gracia (`REFRESH_REUSE_GRACE_MS`). */
  previousRefreshHash?: string;
  rotatedAt?: number;
  access: AccessEntry[];
  grant: ActiveGrant;
  /** `sub` del ID token de Sumego (v3); `null` con el login de Lumbre o migrada de v2. */
  sub: string | null;
  /** `sid` del ID token de Sumego (v3), si lo traía. */
  sid: string | null;
  /**
   * Refresh de Sumego CIFRADO (`./sumego-refresh.ts`, AES-256-GCM con la clave del almacén de
   * secretos), nunca en claro; `null` sin login de Sumego. Rota en cada renovación horaria.
   */
  sumegoRefresh: string | null;
  /** Última renovación con Sumego (o el login), en ms; `null` sin login de Sumego. */
  sumegoRenewedAt: number | null;
}

interface TokensFile {
  version: 3;
  families: Family[];
}

/** Identidad de Sumego de una autorización; `null` en las de Lumbre. */
export interface FamilyIdentity {
  sub: string;
  sid: string | null;
}

/** A quién corta un back-channel logout: con `sid`, ese y (si viene) solo de ese `sub`. */
export type LogoutSelector = { sid: string; sub?: string } | { sid?: undefined; sub: string };

/** ¿Corta este logout a esta identidad? Una autorización sin identidad (Lumbre, v2) nunca casa. */
export function logoutMatches(selector: LogoutSelector, identity: FamilyIdentity | null): boolean {
  if (identity === null) return false;
  if (selector.sid !== undefined) return identity.sid === selector.sid && (selector.sub === undefined || identity.sub === selector.sub);
  return identity.sub === selector.sub;
}

/** Refresh de Sumego de una familia, cifrado, y cuándo se renovó por última vez. */
export interface SumegoRefreshState {
  sealedRefresh: string;
  renewedAt: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Segundos. */
  expiresIn: number;
  scope: string;
}

export interface VerifiedAccess {
  clientId: string;
  scope: string;
  resource: string;
  /** Segundos desde epoch. */
  expiresAt: number;
  familyId: string;
  grant: ActiveGrant;
}

export type RefreshOutcome =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: 'invalid' | 'expired' | 'client_mismatch' | 'replay' | 'recently_rotated' };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Igualdad de dos hashes hex en tiempo constante. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/**
 * Familia v3: la de v2 más `sub`/`sid` y el refresh de Sumego cifrado con su fecha (los dos o
 * ninguno). Los v3 escritos antes de guardar el refresh no traen esos dos campos: cuentan como
 * `null` (`normalize`).
 */
function isFamily(value: unknown): value is Family {
  if (!isFamilyV2(value)) return false;
  const family = value as Record<string, unknown>;
  const sealed = family.sumegoRefresh ?? null;
  const renewedAt = family.sumegoRenewedAt ?? null;
  return nullableString(family.sub) && nullableString(family.sid) &&
    ((sealed === null && renewedAt === null) || (typeof sealed === 'string' && typeof renewedAt === 'number' && Number.isFinite(renewedAt)));
}

function normalize(family: Family): Family {
  return { ...family, sumegoRefresh: family.sumegoRefresh ?? null, sumegoRenewedAt: family.sumegoRenewedAt ?? null };
}

function isFamilyV2(value: unknown): value is Omit<Family, 'sub' | 'sid' | 'sumegoRefresh' | 'sumegoRenewedAt'> {
  if (typeof value !== 'object' || value === null) return false;
  const family = value as Record<string, unknown>;
  return (
    typeof family.id === 'string' &&
    typeof family.clientId === 'string' &&
    typeof family.scope === 'string' &&
    typeof family.resource === 'string' &&
    typeof family.createdAt === 'number' &&
    typeof family.expiresAt === 'number' &&
    typeof family.refreshHash === 'string' &&
    (family.previousRefreshHash === undefined || typeof family.previousRefreshHash === 'string') &&
    (family.rotatedAt === undefined || typeof family.rotatedAt === 'number') &&
    typeof family.grant === 'object' && family.grant !== null &&
    typeof (family.grant as ActiveGrant).credentialId === 'string' &&
    typeof (family.grant as ActiveGrant).opaqueDeviceId === 'string' &&
    Array.isArray(family.access) &&
    family.access.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AccessEntry).hash === 'string' &&
        typeof (entry as AccessEntry).expiresAt === 'number'
    )
  );
}

export class TokenStore {
  private queue: Promise<unknown> = Promise.resolve();
  private familiesRemoved: ((ids: readonly string[]) => () => Promise<void>) | null = null;

  private constructor(
    private readonly dataDir: string,
    private families: Family[],
    private readonly now: () => number
  ) {}

  static async open(dataDir: string, now: () => number = Date.now): Promise<TokenStore> {
    let families: Family[] = [];
    try {
      const value = (await readJsonOrNull(tokensFilePath(dataDir))) as Partial<TokensFile> | null;
      if (value !== null) {
        const record = value as { version?: unknown; families?: unknown };
        if (record.version === 3 && Array.isArray(record.families) && record.families.every(isFamily)) {
          families = record.families.map(normalize);
        } else if (record.version === 2 && Array.isArray(record.families) && record.families.every(isFamilyV2)) {
          // Migración v2 → v3: sin identidad de Sumego. Se escribe v3 en la mutación siguiente.
          families = record.families.map((family) => ({ ...family, sub: null, sid: null, sumegoRefresh: null, sumegoRenewedAt: null }));
          logEvent({ event: 'oauth.tokens', result: 'migrated', from: 2 });
        } else {
          logEvent({ event: 'oauth.tokens', result: 'invalid' });
        }
      }
    } catch {
      logEvent({ event: 'oauth.tokens', result: 'invalid' });
    }
    return new TokenStore(dataDir, families, now);
  }

  /** Familias vivas ahora (para tests y para el log de arranque; nunca hashes). */
  liveFamilyCount(revokedBefore: number): number {
    const now = this.now();
    return this.families.filter((family) => this.alive(family, revokedBefore, now)).length;
  }

  /** Identificadores de familias persistidas para limpiar bearers huérfanos al reiniciar. */
  familyIds(): string[] { return this.families.map((family) => family.id); }

  /** Tras persistir, invalida en síncrono y devuelve una limpieza esperable fuera de la cola. */
  onFamiliesRemoved(handler: (ids: readonly string[]) => () => Promise<void>): void {
    this.familiesRemoved = handler;
  }

  private alive(family: Family, revokedBefore: number, now: number): boolean {
    return family.createdAt > revokedBefore && family.expiresAt > now;
  }

  /** Serializa una mutación y la persiste antes de resolver. */
  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const committed = this.queue.then(async () => {
      const before = structuredClone(this.families);
      let result: T;
      let removed: string[];
      try {
        result = await operation();
        const liveIds = new Set(this.familyIds());
        removed = before.filter((family) => !liveIds.has(family.id)).map((family) => family.id);
        await writeJsonAtomic(this.dataDir, tokensFilePath(this.dataDir), {
          version: 3,
          families: this.families
        } satisfies TokensFile);
      } catch (error) { this.families = before; throw error; }
      const cleanup = removed.length ? this.familiesRemoved?.(removed) : undefined;
      return { result, cleanup };
    });
    this.queue = committed.then(() => undefined, () => undefined);
    return committed.then(async ({ result, cleanup }) => {
      if (cleanup) await cleanup();
      return result;
    });
  }

  private prune(revokedBefore: number, now: number): void {
    this.families = this.families.filter((family) => this.alive(family, revokedBefore, now));
    for (const family of this.families) {
      family.access = family.access.filter((entry) => entry.expiresAt > now);
    }
  }

  private newAccess(family: Family, now: number): string {
    const token = `${ACCESS_PREFIX}${randomBytes(32).toString('base64url')}`;
    family.access.push({ hash: sha256(token), expiresAt: now + ACCESS_TOKEN_TTL_MS });
    while (family.access.length > MAX_ACCESS_PER_FAMILY) family.access.shift();
    return token;
  }

  private newRefresh(family: Family): string {
    const token = `${REFRESH_PREFIX}${family.id}.${randomBytes(32).toString('base64url')}`;
    family.refreshHash = sha256(token);
    return token;
  }

  private issued(family: Family, accessToken: string, refreshToken: string): IssuedTokens {
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: family.scope
    };
  }

  /**
   * Una familia nueva tras una autorización aprobada. `loggedOut`, si lo hay, se evalúa dentro
   * de la cola de mutaciones: un back-channel logout ya apuntado por el proveedor rechaza la
   * identidad (`logged_out`) aunque llegue entre el canje del código y esta escritura.
   */
  issueFamily(
    input: { clientId: string; scope: string; resource: string; grant: ActiveGrant; authorizedAt: number;
      identity?: FamilyIdentity | null; sumego?: SumegoRefreshState | null; loggedOut?: () => boolean },
    revokedBefore: number,
    storeBearer: (familyId: string, liveIds: readonly string[]) => Promise<void>
  ): Promise<IssuedTokens> {
    return this.mutate(async () => {
      const now = this.now();
      const priorIds = this.familyIds();
      this.prune(revokedBefore, now);
      if (input.authorizedAt <= revokedBefore) throw new Error('authorization_revoked');
      if (input.loggedOut?.()) throw new Error('logged_out');
      if (this.families.length >= MAX_FAMILIES) throw new Error('too_many_families');
      const family: Family = {
        id: randomBytes(16).toString('base64url'),
        clientId: input.clientId,
        scope: input.scope,
        resource: input.resource,
        // La marca es la aprobación, no el canje: una revocación concurrente
        // nunca convierte un código antiguo en una familia nueva.
        createdAt: input.authorizedAt,
        // La de la concesión, sin tope propio: cada refresh la renueva en Lumbre.
        expiresAt: Date.parse(input.grant.expiresAt),
        refreshHash: '',
        access: [],
        grant: input.grant,
        sub: input.identity?.sub ?? null,
        sid: input.identity?.sid ?? null,
        sumegoRefresh: input.sumego?.sealedRefresh ?? null,
        sumegoRenewedAt: input.sumego?.renewedAt ?? null
      };
      if (family.expiresAt <= now) throw new Error('grant_expired');
      const accessToken = this.newAccess(family, now);
      const refreshToken = this.newRefresh(family);
      this.families.push(family);
      // Conservar bearers de familias podadas hasta que la eliminación sea durable;
      // el observador los revoca y retira después de persistir los tokens.
      await storeBearer(family.id, [...priorIds, family.id]);
      return this.issued(family, accessToken, refreshToken);
    });
  }

  /**
   * Rota un refresh. Reutilizar uno ya rotado revoca su familia entera. Con
   * `renewedExpiresAt` (la fecha que devolvió `/renew`), la familia y su concesión pasan a
   * caducar entonces, en la misma escritura atómica que la rotación. Con `sumego` (el refresh
   * de Sumego recién rotado, cifrado), también va en esa escritura.
   */
  rotateRefresh(refreshToken: string, clientId: string, revokedBefore: number, renewedExpiresAt?: string,
    sumego?: SumegoRefreshState): Promise<RefreshOutcome> {
    return this.mutate((): RefreshOutcome => {
      const now = this.now();
      const match = REFRESH_PATTERN.exec(refreshToken);
      const family = match ? this.families.find((candidate) => candidate.id === match[1]) : undefined;
      if (!family) return { ok: false, reason: 'invalid' };
      if (!this.alive(family, revokedBefore, now)) {
        this.prune(revokedBefore, now);
        return { ok: false, reason: 'expired' };
      }
      if (family.clientId !== clientId) return { ok: false, reason: 'client_mismatch' };
      const presented = sha256(refreshToken);
      if (!sameHash(presented, family.refreshHash)) {
        // Dos refresh simultáneos con el mismo token (el cliente reintenta, o dos pestañas):
        // el segundo llega con el recién rotado. Dentro de la ventana se rechaza sin tocar
        // la familia; fuera, es una reutilización y cae entera.
        if (
          family.previousRefreshHash !== undefined &&
          family.rotatedAt !== undefined &&
          now - family.rotatedAt < REFRESH_REUSE_GRACE_MS &&
          sameHash(presented, family.previousRefreshHash)
        ) {
          return { ok: false, reason: 'recently_rotated' };
        }
        this.families = this.families.filter((candidate) => candidate !== family);
        return { ok: false, reason: 'replay' };
      }
      this.prune(revokedBefore, now);
      family.previousRefreshHash = family.refreshHash;
      family.rotatedAt = now;
      if (renewedExpiresAt !== undefined) {
        // En el sitio, no una copia: una verificación en vuelo que ya tiene la concesión
        // compara con la fecha nueva. Si la escritura falla, `mutate` restaura la copia previa.
        family.grant.expiresAt = renewedExpiresAt;
        family.expiresAt = Date.parse(renewedExpiresAt);
      }
      if (sumego !== undefined) {
        family.sumegoRefresh = sumego.sealedRefresh;
        family.sumegoRenewedAt = sumego.renewedAt;
      }
      const accessToken = this.newAccess(family, now);
      const nextRefresh = this.newRefresh(family);
      return { ok: true, tokens: this.issued(family, accessToken, nextRefresh) };
    });
  }

  /** Refresh de Sumego (cifrado) de una familia y su última renovación; `null` sin login de Sumego. */
  sumegoRefreshOf(familyId: string): SumegoRefreshState | null {
    const family = this.families.find((candidate) => candidate.id === familyId);
    if (!family || family.sumegoRefresh === null || family.sumegoRenewedAt === null) return null;
    return { sealedRefresh: family.sumegoRefresh, renewedAt: family.sumegoRenewedAt };
  }

  /** El access token, si es válido ahora. Sin escribir nada. */
  verifyAccess(accessToken: string, revokedBefore: number): VerifiedAccess | null {
    if (!ACCESS_PATTERN.test(accessToken)) return null;
    const hash = sha256(accessToken);
    const now = this.now();
    for (const family of this.families) {
      if (!this.alive(family, revokedBefore, now)) continue;
      for (const entry of family.access) {
        if (entry.expiresAt > now && sameHash(hash, entry.hash)) {
          return {
            clientId: family.clientId,
            scope: family.scope,
            resource: family.resource,
            expiresAt: Math.floor(entry.expiresAt / 1000),
            familyId: family.id,
            grant: family.grant
          };
        }
      }
    }
    return null;
  }

  /** Vínculo de la familia del refresh vigente, sin revelar el bearer upstream. */
  lookupRefresh(token: string, clientId: string, revokedBefore: number): { familyId: string; grant: ActiveGrant } | null {
    const match = REFRESH_PATTERN.exec(token);
    const family = match ? this.families.find((candidate) => candidate.id === match[1]) : undefined;
    if (!family || family.clientId !== clientId || !this.alive(family, revokedBefore, this.now()) ||
      !sameHash(sha256(token), family.refreshHash)) return null;
    return { familyId: family.id, grant: family.grant };
  }

  /** Corta una familia cuando Lumbre confirma revocación. */
  dropFamily(id: string): Promise<void> {
    return this.mutate(() => { this.families = this.families.filter((family) => family.id !== id); });
  }

  /**
   * Back-channel logout de Sumego (SPEC.md §12.9): con `sid`, las familias de esa sesión
   * (y de ese `sub`, si viene); con solo `sub`, todas las suyas. Las familias sin identidad
   * (Lumbre o v2) nunca casan. Resuelve con los ids cortados una vez persistida la baja;
   * el observador de `onFamiliesRemoved` pide después la revocación upstream.
   */
  dropFamiliesByLogout(selector: LogoutSelector): Promise<string[]> {
    return this.mutate((): string[] => {
      const matches = (family: Family): boolean =>
        logoutMatches(selector, family.sub === null ? null : { sub: family.sub, sid: family.sid });
      const dropped = this.families.filter(matches).map((family) => family.id);
      if (dropped.length) this.families = this.families.filter((family) => !matches(family));
      return dropped;
    });
  }

  /**
   * RFC 7009: revocar cualquier token vigente corta la autorización completa y su
   * concesión upstream; una familia nunca queda parcialmente abierta en Lumbre.
   * Un token desconocido, de otro cliente o ya revocado no hace nada.
   */
  revoke(token: string, clientId: string): Promise<'access' | 'family' | 'none'> {
    return this.mutate((): 'access' | 'family' | 'none' => {
      const hash = sha256(token);
      const refresh = REFRESH_PATTERN.exec(token);
      if (refresh) {
        const family = this.families.find((candidate) => candidate.id === refresh[1]);
        if (!family || family.clientId !== clientId || !sameHash(hash, family.refreshHash)) return 'none';
        this.families = this.families.filter((candidate) => candidate !== family);
        return 'family';
      }
      if (!ACCESS_PATTERN.test(token)) return 'none';
      for (const family of this.families) {
        if (family.clientId !== clientId) continue;
        const index = family.access.findIndex((entry) => sameHash(hash, entry.hash));
        if (index >= 0) {
          this.families = this.families.filter((candidate) => candidate !== family);
          return 'family';
        }
      }
      return 'none';
    });
  }
}
