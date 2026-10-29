/** Protocolo público H-L7 del relé. Los sobres de cuenta no forman parte de esta API. */
import { z } from 'zod';
import { agentDeviceKeyId, parseAgentSpaceGrant } from '../hebra';

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const b64 = (bytes: number) =>
  z
    .string()
    .refine(
      (s) =>
        /^[A-Za-z0-9_-]+$/.test(s) &&
        Buffer.from(s, 'base64url').length === bytes &&
        Buffer.from(s, 'base64url').toString('base64url') === s
    );
export const publicKeySchema = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: b64(32), y: b64(32) })
  .strict();
export const registrationSchema = z
  .object({
    credentialId: uuid,
    deviceId: z.string().min(1).max(200),
    accountId: hex(32),
    keyId: hex(32),
    publicKey: publicKeySchema,
    actorKind: z.literal('agent')
  })
  .strict();
export const grantSchema = z.unknown().transform((value, ctx) => {
  try {
    return parseAgentSpaceGrant(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid-agent-grant' });
    return z.NEVER;
  }
});
export const accessSchema = z
  .object({ spaceId: uuid, syncVaultId: hex(16), grant: grantSchema })
  .strict();
export const catalogueSchema = z.object({ spaces: z.array(accessSchema).max(1000) }).strict();
export type AgentRegistration = z.infer<typeof registrationSchema>;
export type AgentSpaceGrant = z.infer<typeof grantSchema>;
export type AgentSpaceAccess = z.infer<typeof accessSchema>;
export type AgentPublicKey = z.infer<typeof publicKeySchema>;

/** Orden de propiedades acordado con el relé; no es el kid de la clave de cuenta. */
export const deviceKeyId = agentDeviceKeyId;
