/**
 * Refresh de Sumego de cada familia, cifrado (SPEC.md §12.9). Va dentro de `oauth-tokens.json`
 * para que su rotación entre en la misma escritura atómica que rota el refresh de Hebra, pero
 * nunca en claro: AES-256-GCM con una clave aleatoria de 32 bytes que vive en el almacén de
 * secretos existente (`hebra-mcp-sumego-refresh-key`, el mismo llavero o fichero 0600 que el
 * emparejado). Sin esa clave, el fichero de tokens no da acceso a Sumego.
 *
 * Formato: `v1.<iv>.<cifrado>.<etiqueta>`, todo base64url, con datos asociados fijos. Un valor
 * que no descifra (clave perdida o fichero manipulado) es `null`: la familia no se puede
 * renovar y se corta (cerrado ante la duda).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretStore } from '../secrets';

const KEY = 'hebra-mcp-sumego-refresh-key';
const AAD = Buffer.from('hebra-mcp/sumego-refresh/v1');
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SEALED = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

export class RefreshSealer {
  private constructor(private readonly key: Buffer) {}

  /** La clave del almacén; si no hay (o no vale), una nueva, guardada antes de usarla. */
  static async open(store: SecretStore): Promise<RefreshSealer> {
    const raw = await store.get(KEY);
    if (raw !== null && KEY_PATTERN.test(raw)) return new RefreshSealer(Buffer.from(raw, 'base64url'));
    const key = randomBytes(32);
    await store.set(KEY, key.toString('base64url'));
    return new RefreshSealer(key);
  }

  seal(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  open(sealed: string): string | null {
    const match = SEALED.exec(sealed);
    if (!match) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(match[1]!, 'base64url'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(match[3]!, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(match[2]!, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return null; }
  }
}
