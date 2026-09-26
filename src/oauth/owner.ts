/**
 * El secreto del dueño (SPEC.md §12.2, D7) y la revocación global.
 *
 * - Solo se guarda un hash: scrypt de `node:crypto` (N = 2^15, r = 8, p = 1, 32 bytes,
 *   sal aleatoria de 16 bytes). Por qué scrypt y no argon2: argon2 solo existe en Node 24
 *   como API experimental (`crypto.argon2`, que además avisa en stderr al usarla), y
 *   cualquier otra vía exige un módulo nativo nuevo. scrypt es estable, no añade
 *   dependencias y, con un secreto largo de gestor de contraseñas, la función de
 *   derivación solo tiene que frenar un ataque sin conexión si alguien se lleva el
 *   fichero; el ataque en línea lo frena el límite de intentos (`./provider.ts`).
 * - La comparación es en tiempo constante (`timingSafeEqual` sobre los hashes).
 * - `revokedBefore` (ms): toda familia de tokens creada hasta ese instante está revocada.
 *   `oauth-revoke-all` solo mueve esa marca, y fijar un secreto nuevo también (cambiar el
 *   secreto porque se sospecha una fuga no puede dejar vivos los tokens emitidos con el
 *   viejo). `serve-http` relee el fichero cuando cambia (`OwnerFile`), así que la
 *   revocación corta al momento aunque la haga otro proceso.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { logEvent } from '../log/logger';
import { ownerFilePath, readJsonOrNull, writeJsonAtomic } from './files';

/** Longitud mínima del secreto: «de alta entropía», el de un gestor de contraseñas. */
export const OWNER_SECRET_MIN_LENGTH = 32;
/** Tope: por encima, ni se deriva (un formulario no puede pedir un scrypt de megabytes). */
export const OWNER_SECRET_MAX_LENGTH = 1024;

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const SCRYPT_KEY_LENGTH = 32;
/** scrypt necesita 128·N·r bytes (32 MiB con estos parámetros); el tope por defecto de
 *  Node es justo 32 MiB, así que se sube. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface OwnerRecord {
  version: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64url. */
  salt: string;
  /** base64url. */
  hash: string;
  /** Familias creadas hasta aquí (ms desde epoch), revocadas. */
  revokedBefore: number;
}

/** Secreto que no cumple los límites: el mensaje los dice, nunca cita el valor. */
export class OwnerSecretError extends Error {
  readonly code = 'owner_secret_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'OwnerSecretError';
  }
}

/** No hay secreto fijado (para `oauth-revoke-all`). */
export class OwnerNotConfiguredError extends Error {
  readonly code = 'oauth_not_configured';
  constructor() {
    super('No hay secreto del dueño: fíjalo con `hebra-mcp oauth-set-secret`.');
    this.name = 'OwnerNotConfiguredError';
  }
}

function derive(secret: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret.normalize('NFC'),
      salt,
      SCRYPT_KEY_LENGTH,
      { ...params, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

function isOwnerRecord(value: unknown): value is OwnerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.kdf === 'scrypt' &&
    Number.isInteger(record.N) &&
    Number.isInteger(record.r) &&
    Number.isInteger(record.p) &&
    typeof record.salt === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.revokedBefore === 'number' &&
    Number.isFinite(record.revokedBefore)
  );
}

export function validateOwnerSecret(secret: string): void {
  if (secret.length < OWNER_SECRET_MIN_LENGTH) {
    throw new OwnerSecretError(
      `El secreto tiene que tener al menos ${OWNER_SECRET_MIN_LENGTH} caracteres (genéralo con el gestor de contraseñas).`
    );
  }
  if (secret.length > OWNER_SECRET_MAX_LENGTH) {
    throw new OwnerSecretError(`El secreto no puede pasar de ${OWNER_SECRET_MAX_LENGTH} caracteres.`);
  }
}

/** El registro del dueño, o `null` si no existe o está corrupto (= sin configurar). */
export async function readOwnerRecord(dataDir: string): Promise<OwnerRecord | null> {
  let value: unknown;
  try {
    value = await readJsonOrNull(ownerFilePath(dataDir));
  } catch {
    logEvent({ event: 'oauth.owner', result: 'invalid' });
    return null;
  }
  if (value === null) return null;
  if (!isOwnerRecord(value)) {
    logEvent({ event: 'oauth.owner', result: 'invalid' });
    return null;
  }
  return value;
}

/** Fija el secreto del dueño y revoca todos los tokens anteriores. */
export async function setOwnerSecret(dataDir: string, secret: string, now = Date.now()): Promise<void> {
  validateOwnerSecret(secret);
  const salt = randomBytes(16);
  const hash = await derive(secret, salt, SCRYPT_PARAMS);
  const record: OwnerRecord = {
    version: 1,
    kdf: 'scrypt',
    ...SCRYPT_PARAMS,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
    revokedBefore: now
  };
  await writeJsonAtomic(dataDir, ownerFilePath(dataDir), record);
}

/** Revoca todas las familias de tokens emitidas hasta ahora. */
export async function revokeAllTokens(dataDir: string, now = Date.now()): Promise<void> {
  const record = await readOwnerRecord(dataDir);
  if (!record) throw new OwnerNotConfiguredError();
  // `Math.max`: dos revocaciones en el mismo milisegundo, o un reloj que retrocede, no
  // pueden reabrir familias ya revocadas.
  await writeJsonAtomic(dataDir, ownerFilePath(dataDir), {
    ...record,
    revokedBefore: Math.max(record.revokedBefore, now)
  });
}

/** ¿`candidate` es el secreto del dueño? Tiempo constante sobre los hashes. */
export async function verifyOwnerSecret(record: OwnerRecord, candidate: string): Promise<boolean> {
  if (candidate.length === 0 || candidate.length > OWNER_SECRET_MAX_LENGTH) return false;
  const expected = Buffer.from(record.hash, 'base64url');
  const actual = await derive(candidate, Buffer.from(record.salt, 'base64url'), {
    N: record.N,
    r: record.r,
    p: record.p
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * El registro del dueño tal como está en disco AHORA, para `serve-http`: un `stat` por
 * consulta (microsegundos) y relectura solo si cambió el fichero. Si desaparece, `null`:
 * sin dueño no vale ningún token ni se aprueba ninguna autorización.
 */
export class OwnerFile {
  private cached: { key: string; record: OwnerRecord | null } | null = null;

  constructor(private readonly dataDir: string) {}

  async current(): Promise<OwnerRecord | null> {
    let key: string;
    try {
      const info = await stat(ownerFilePath(this.dataDir), { bigint: true });
      key = `${info.ino}:${info.mtimeNs}:${info.size}`;
    } catch {
      this.cached = null;
      return null;
    }
    if (this.cached?.key === key) return this.cached.record;
    const record = await readOwnerRecord(this.dataDir);
    this.cached = { key, record };
    return record;
  }
}
