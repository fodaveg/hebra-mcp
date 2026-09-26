/**
 * Tokens del OAuth de un solo dueño (SPEC.md §12.2): opacos, aleatorios y guardados solo
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
 *   una lista de refresh usados.
 * - Revocación global: una familia creada hasta `revokedBefore` del dueño
 *   (`./owner.ts`) está muerta, aunque siga en el fichero.
 * - Persistencia: `oauth-tokens.json` (0600, escritura atómica), que solo escribe este
 *   proceso. Las mutaciones van en cola y se persisten ANTES de devolver el token nuevo:
 *   un reinicio no resucita un refresh ya rotado. Un fichero corrupto se trata como vacío
 *   (todos los tokens dejan de valer: cerrado ante la duda).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { logEvent } from '../log/logger';
import { readJsonOrNull, tokensFilePath, writeJsonAtomic } from './files';

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_FAMILY_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_ACCESS_PER_FAMILY = 4;
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
  access: AccessEntry[];
}

interface TokensFile {
  version: 1;
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
}

export type RefreshOutcome =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: 'invalid' | 'expired' | 'client_mismatch' | 'replay' };

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
        if (value.version === 1 && Array.isArray(value.families) && value.families.every(isFamily)) {
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

  private alive(family: Family, revokedBefore: number, now: number): boolean {
    return family.createdAt > revokedBefore && family.expiresAt > now;
  }

  /** Serializa una mutación y la persiste antes de resolver. */
  private mutate<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(async () => {
      const result = operation();
      await writeJsonAtomic(this.dataDir, tokensFilePath(this.dataDir), {
        version: 1,
        families: this.families
      } satisfies TokensFile);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
    input: { clientId: string; scope: string; resource: string },
    revokedBefore: number
  ): Promise<IssuedTokens> {
    return this.mutate(() => {
      const now = this.now();
      this.prune(revokedBefore, now);
      const family: Family = {
        id: randomBytes(16).toString('base64url'),
        clientId: input.clientId,
        scope: input.scope,
        resource: input.resource,
        // Estrictamente después de la revocación vigente, aunque el reloj diga lo mismo.
        createdAt: Math.max(now, revokedBefore + 1),
        expiresAt: now + REFRESH_FAMILY_TTL_MS,
        refreshHash: '',
        access: []
      };
      const accessToken = this.newAccess(family, now);
      const refreshToken = this.newRefresh(family);
      this.families.push(family);
      while (this.families.length > MAX_FAMILIES) this.families.shift();
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
      if (!sameHash(sha256(refreshToken), family.refreshHash)) {
        this.families = this.families.filter((candidate) => candidate !== family);
        return { ok: false, reason: 'replay' };
      }
      this.prune(revokedBefore, now);
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
            expiresAt: Math.floor(entry.expiresAt / 1000)
          };
        }
      }
    }
    return null;
  }

  /**
   * RFC 7009: un access revoca solo ese access; un refresh vigente, su familia entera.
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
          family.access.splice(index, 1);
          return 'access';
        }
      }
      return 'none';
    });
  }
}
