/**
 * `SecretStore` (SPEC.md §6.1): las dos implementaciones y el formato de los tres
 * secretos. El llavero REAL no se toca en `npm test` (cada ejecución escribiría en el
 * Keychain de David): `KeyringSecretStore` se prueba aquí con una `AsyncEntry` de
 * mentira, y la prueba real de escribir, leer y borrar en el Keychain está medida aparte
 * (informe de L2).
 */
import { describe, expect, it } from 'vitest';
import {
  KeyringSecretStore,
  MemorySecretStore,
  SECRET_SERVICE,
  clearPairedSecrets,
  readPairedSecrets,
  readStoredIdentity,
  writePairedSecrets,
  type PairedSecrets
} from '../../src/secrets';

const SECRETS: PairedSecrets = {
  connection: {
    credentialId: 'cred-1',
    readToken: 'read-1',
    writeToken: 'write-1',
    apiOrigin: 'https://app.lumbre.pro',
    connectedAt: '2026-09-26T10:00:00.000Z'
  },
  recoveryCode: 'hebra-recovery-v2:AbC_-123',
  device: {
    opaqueDeviceId: 'ab'.repeat(16),
    lumbreDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab'
  }
};

describe('secretos de emparejado', () => {
  it('ida y vuelta, y borrar los deja a cero', async () => {
    const store = new MemorySecretStore();
    expect(await readPairedSecrets(store)).toBeNull();
    await writePairedSecrets(store, SECRETS);
    expect(await readPairedSecrets(store)).toEqual(SECRETS);
    expect(await clearPairedSecrets(store)).toBe(3);
    expect(store.size).toBe(0);
    expect(await clearPairedSecrets(store)).toBe(0);
  });

  it('un valor con forma inesperada cuenta como ausente', async () => {
    const store = new MemorySecretStore();
    await writePairedSecrets(store, SECRETS);
    await store.set('lumbre-connection', JSON.stringify({ ...SECRETS.connection, apiOrigin: 'http://x.test' }));
    expect(await readPairedSecrets(store)).toBeNull();
    // La identidad sigue valiendo: `pair` solo renovaría la credencial.
    expect(await readStoredIdentity(store)).toEqual({
      recoveryCode: SECRETS.recoveryCode,
      device: SECRETS.device
    });
    await store.set('device-identity', '{no es json');
    expect(await readStoredIdentity(store)).toBeNull();
  });

  it('KeyringSecretStore: servicio hebra-mcp, una cuenta por secreto', async () => {
    const entries = new Map<string, string>();
    const store = new KeyringSecretStore((service, account) => ({
      getPassword: async () => entries.get(`${service}/${account}`) ?? null,
      setPassword: async (value: string) => void entries.set(`${service}/${account}`, value),
      deleteCredential: async () => entries.delete(`${service}/${account}`)
    }));
    await writePairedSecrets(store, SECRETS);
    expect([...entries.keys()].sort()).toEqual([
      `${SECRET_SERVICE}/device-identity`,
      `${SECRET_SERVICE}/lumbre-connection`,
      `${SECRET_SERVICE}/recovery-code`
    ]);
    expect(await readPairedSecrets(store)).toEqual(SECRETS);
    expect(await clearPairedSecrets(store)).toBe(3);
    expect(entries.size).toBe(0);
  });
});
