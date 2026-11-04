import { createHash } from 'node:crypto';

/**
 * `accountId` de Hebra de un `sub` de Sumego: `sha256hex("hebra-account:" + sub)`, con el `sub`
 * en minúsculas (`deriveHebraAccountId` y `accountIdOf` de Lumbre; el contrato de Hebra lo cita en
 * `vendor/hebra/src/lib/spaces/space-key-envelope.ts`). El registro de un dispositivo de agente
 * devuelve ese mismo valor para la cuenta de la credencial, así que compararlos dice, antes de
 * pedir la aprobación, si la sesión de Lumbre del navegador es de la persona que hizo login.
 * La prueba de propiedad sigue siendo la concesión de Lumbre: esto solo adelanta el error.
 */
export function hebraAccountIdOf(sub: string): string {
  return createHash('sha256').update(`hebra-account:${sub.toLowerCase()}`).digest('hex');
}
