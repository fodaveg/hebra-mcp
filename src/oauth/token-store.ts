/**
 * Tokens del OAuth con consentimiento Lumbre (SPEC.md §12.2): opacos, aleatorios y guardados solo
 * como SHA-256. Valores de lumbre-mcp (`oauth.ts:25-26`): access de 1 h y familia de
 * refresh de 30 días desde la autorización (vigencia absoluta: pasado ese plazo hay que
 * volver a meter el secreto).
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
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { logEvent } from '../log/logger';
import { readJsonOrNull, tokensFilePath, writeJsonAtomic } from './files';
import type { ActiveGrant } from './backchannel';

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60_000;
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
}

interface TokensFile {
  version: 2;
  families: Family[];
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

function isFamily(value: unknown): value is Family {
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
        if (value.version === 2 && Array.isArray(value.families) && value.families.every(isFamily)) {
          families = value.families;
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
          version: 2,
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

  /** Una familia nueva tras una autorización aprobada. */
  issueFamily(
    input: { clientId: string; scope: string; resource: string; grant: ActiveGrant; authorizedAt: number },
    revokedBefore: number,
    storeBearer: (familyId: string, liveIds: readonly string[]) => Promise<void>
  ): Promise<IssuedTokens> {
    return this.mutate(async () => {
      const now = this.now();
      const priorIds = this.familyIds();
      this.prune(revokedBefore, now);
      if (input.authorizedAt <= revokedBefore) throw new Error('authorization_revoked');
      if (this.families.length >= MAX_FAMILIES) throw new Error('too_many_families');
      const family: Family = {
        id: randomBytes(16).toString('base64url'),
        clientId: input.clientId,
        scope: input.scope,
        resource: input.resource,
        // La marca es la aprobación, no el canje: una revocación concurrente
        // nunca convierte un código antiguo en una familia nueva.
        createdAt: input.authorizedAt,
        expiresAt: Math.min(input.authorizedAt + REFRESH_FAMILY_TTL_MS, Date.parse(input.grant.expiresAt)),
        refreshHash: '',
        access: [],
        grant: input.grant
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

  /** Rota un refresh. Reutilizar uno ya rotado revoca su familia entera. */
  rotateRefresh(refreshToken: string, clientId: string, revokedBefore: number): Promise<RefreshOutcome> {
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
      const accessToken = this.newAccess(family, now);
      const nextRefresh = this.newRefresh(family);
      return { ok: true, tokens: this.issued(family, accessToken, nextRefresh) };
    });
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
