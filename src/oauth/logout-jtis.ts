/**
 * `jti` ya usados de los `logout_token` de Sumego (SPEC.md §12.9): `oauth-logout-jtis.json`,
 * en el directorio de datos, con el sha256 de cada `jti` hasta que el token deja de valer.
 * Solo lo escribe `serve-http`, de forma atómica (`writeJsonAtomic`, 0600) y en cola.
 *
 * El `jti` se apunta DESPUÉS de cortar las familias en local: si el corte falla, el
 * back-channel logout responde 500 y el reintento de Sumego vale. Un fichero corrupto se
 * trata como vacío y se dice en el log: repetir un logout solo vuelve a cortar lo ya cortado.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { logEvent } from '../log/logger';
import { readJsonOrNull, writeJsonAtomic } from './files';

export const LOGOUT_JTIS_FILE = 'oauth-logout-jtis.json';
/** Techo defensivo: con 60 logouts por minuto y dirección, de sobra para 11 min de vida. */
const MAX_JTIS = 4096;
const HEX64 = /^[0-9a-f]{64}$/;

interface JtiEntry { hash: string; expiresAt: number }
interface JtisFile { version: 1; jtis: JtiEntry[] }

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function validFile(value: unknown): value is JtisFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Array.isArray(record.jtis) && record.jtis.every((entry: unknown) =>
    !!entry && typeof entry === 'object' && typeof (entry as JtiEntry).hash === 'string' && HEX64.test((entry as JtiEntry).hash) &&
    typeof (entry as JtiEntry).expiresAt === 'number' && Number.isFinite((entry as JtiEntry).expiresAt));
}

export class LogoutJtiStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly dataDir: string,
    private entries: JtiEntry[],
    private readonly now: () => number
  ) {}

  static async open(dataDir: string, now: () => number = Date.now): Promise<LogoutJtiStore> {
    let entries: JtiEntry[] = [];
    try {
      const value = await readJsonOrNull(join(dataDir, LOGOUT_JTIS_FILE));
      if (value !== null) {
        if (validFile(value)) entries = value.jtis;
        else logEvent({ event: 'oauth.logout_jtis', result: 'invalid' });
      }
    } catch { logEvent({ event: 'oauth.logout_jtis', result: 'invalid' }); }
    return new LogoutJtiStore(dataDir, entries, now);
  }

  /** ¿Ya se usó este `jti` y sigue vigente? Comparación de hashes en tiempo constante. */
  has(jti: string): boolean {
    const hash = Buffer.from(sha256(jti), 'hex');
    const now = this.now();
    let found = false;
    for (const entry of this.entries) {
      if (entry.expiresAt <= now) continue;
      if (timingSafeEqual(hash, Buffer.from(entry.hash, 'hex'))) found = true;
    }
    return found;
  }

  /** Apunta el `jti` hasta `expiresAt` y lo persiste antes de resolver; si falla, no queda. */
  remember(jti: string, expiresAt: number): Promise<void> {
    const run = this.queue.then(async () => {
      const before = this.entries;
      const now = this.now();
      const next = this.entries.filter((entry) => entry.expiresAt > now);
      next.push({ hash: sha256(jti), expiresAt });
      next.sort((a, b) => a.expiresAt - b.expiresAt);
      while (next.length > MAX_JTIS) next.shift();
      this.entries = next;
      try {
        await writeJsonAtomic(this.dataDir, join(this.dataDir, LOGOUT_JTIS_FILE), { version: 1, jtis: next } satisfies JtisFile);
      } catch (error) { this.entries = before; throw error; }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
