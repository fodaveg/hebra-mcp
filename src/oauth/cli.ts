/**
 * Subcomandos de mantenimiento del OAuth de un solo dueño (SPEC.md §12.2):
 *
 * - `hebra-mcp oauth-set-secret`: lee el secreto por stdin y guarda su hash. Nunca por
 *   argumentos ni variables de entorno (se verían en `ps` o en `docker inspect`). En una
 *   terminal lo pide dos veces sin eco; por una tubería lee la entrada entera (quitando un
 *   salto de línea final). Fijar un secreto revoca todos los tokens anteriores.
 * - `hebra-mcp oauth-revoke-all`: revoca todos los tokens emitidos. Corta al momento a un
 *   `serve-http` que esté corriendo (relee `oauth-owner.json` en cada petición).
 *
 * En el contenedor van por `docker compose exec`, nunca por `run` (§12.5).
 */
import { OwnerNotConfiguredError, OwnerSecretError, OWNER_SECRET_MAX_LENGTH, revokeAllTokens, setOwnerSecret } from './owner';

export interface OAuthCliIo {
  /** Lee una línea sin eco (terminal) o la entrada entera (tubería). */
  readSecret(prompt: string): Promise<string>;
  /** `true` si la entrada es una terminal (y entonces se pide confirmación). */
  interactive: boolean;
  print(line: string): void;
}

/** Error de uso: el mensaje es para David y no cita ningún valor. */
export class OAuthCliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'OAuthCliError';
  }
}

export async function runOAuthSetSecret(dataDir: string, io: OAuthCliIo, now = Date.now()): Promise<void> {
  const secret = await io.readSecret('Secreto del dueño: ');
  if (io.interactive) {
    const again = await io.readSecret('Repítelo: ');
    if (again !== secret) throw new OAuthCliError('owner_secret_mismatch', 'Los dos secretos no coinciden; no se ha guardado nada.');
  }
  try {
    await setOwnerSecret(dataDir, secret, now);
  } catch (error) {
    if (error instanceof OwnerSecretError) throw new OAuthCliError(error.code, error.message);
    throw error;
  }
  io.print('Secreto guardado (solo su hash). Todos los tokens anteriores quedan revocados.');
}

export async function runOAuthRevokeAll(dataDir: string, io: Pick<OAuthCliIo, 'print'>, now = Date.now()): Promise<void> {
  try {
    await revokeAllTokens(dataDir, now);
  } catch (error) {
    if (error instanceof OwnerNotConfiguredError) throw new OAuthCliError(error.code, error.message);
    throw error;
  }
  io.print('Todos los tokens quedan revocados. Claude tendrá que volver a autorizarse con el secreto.');
}

/** Tope de lo que se lee por una tubería: el secreto máximo y algo de margen. */
const MAX_PIPED_BYTES = OWNER_SECRET_MAX_LENGTH * 4 + 16;

function readPiped(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PIPED_BYTES) {
        stdin.destroy();
        reject(new OAuthCliError('owner_secret_invalid', 'La entrada es demasiado larga para ser el secreto.'));
        return;
      }
      chunks.push(chunk);
    });
    stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
    stdin.once('error', reject);
  });
}

/** Una línea en modo crudo, sin eco. Ctrl-C o Ctrl-D cancelan sin guardar nada. */
function readHidden(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    let value = '';
    const finish = (error: Error | null) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(null);
        if (char === '\u0003' || char === '\u0004') {
          return finish(new OAuthCliError('cancelled', 'Cancelado; no se ha guardado nada.'));
        }
        if (char === '\u007f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        value += char;
        if (value.length > OWNER_SECRET_MAX_LENGTH) {
          return finish(new OAuthCliError('owner_secret_invalid', 'El secreto es demasiado largo.'));
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** stdin/stdout del proceso. */
export function processOAuthCliIo(): OAuthCliIo {
  const interactive = process.stdin.isTTY === true;
  return {
    interactive,
    readSecret: (prompt) =>
      interactive ? readHidden(process.stdin, process.stdout, prompt) : readPiped(process.stdin),
    print: (line) => {
      process.stdout.write(`${line}\n`);
    }
  };
}
