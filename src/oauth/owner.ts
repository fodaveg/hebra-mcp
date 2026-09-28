/** Marca global de revocación local, separada del antiguo hash owner. */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonOrNull, writeJsonAtomic } from './files';

export const REVOCATIONS_FILE = 'oauth-revocations-v2.json';
function pathFor(dataDir: string): string { return join(dataDir, REVOCATIONS_FILE); }

interface Revocations { version: 2; revokedBefore: number }
function valid(value: unknown): value is Revocations {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 2 && typeof record.revokedBefore === 'number' && Number.isFinite(record.revokedBefore);
}

/** Revoca localmente todas las familias incluso si el broker está indisponible. */
export async function revokeAllTokens(dataDir: string, now = Date.now()): Promise<void> {
  const previous = await new RevocationFile(dataDir).current();
  await writeJsonAtomic(dataDir, pathFor(dataDir), { version: 2, revokedBefore: Math.max(previous, now) } satisfies Revocations);
}

/** El proceso HTTP relee la marca si otro proceso ejecuta oauth-revoke-all. */
export class RevocationFile {
  private cached: { key: string; value: number } | null = null;
  constructor(private readonly dataDir: string) {}

  async current(): Promise<number> {
    let key: string;
    try {
      const info = await stat(pathFor(this.dataDir), { bigint: true });
      key = `${info.ino}:${info.mtimeNs}:${info.size}`;
    } catch { this.cached = null; return 0; }
    if (this.cached?.key === key) return this.cached.value;
    let raw: unknown;
    try { raw = await readJsonOrNull(pathFor(this.dataDir)); } catch { return Number.MAX_SAFE_INTEGER; }
    const value = valid(raw) ? raw.revokedBefore : Number.MAX_SAFE_INTEGER;
    this.cached = { key, value };
    return value;
  }
}
