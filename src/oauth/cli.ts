/** Mantenimiento del OAuth con consentimiento Lumbre. */
import { revokeAllTokens } from './owner';

export class OAuthCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OAuthCliError'; }
}

export async function runOAuthRevokeAll(dataDir: string, io: { print(line: string): void }, now = Date.now()): Promise<void> {
  await revokeAllTokens(dataDir, now);
  io.print('Todos los tokens OAuth locales quedan revocados. Claude tendrá que volver a autorizarse en Lumbre.');
}

/** El comando antiguo falla claramente y no cambia la marca de revocación. */
export async function runOAuthSetSecret(): Promise<never> {
  throw new OAuthCliError('owner_secret_replaced', 'El secreto del dueño ha sido sustituido por el consentimiento de Lumbre.');
}
