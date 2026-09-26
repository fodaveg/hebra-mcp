/**
 * SPEC.md §12.3: selección explícita del almacén por `HEBRA_MCP_SECRET_STORE`, nunca un
 * fallback automático, y en modo `file` sin cargar `@napi-rs/keyring`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretStoreModeError, resolveSecretStoreMode } from '../../src/secrets';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-mcp-store-mode-'));
  dirs.push(dir);
  return dir;
}

describe('resolveSecretStoreMode', () => {
  it('por defecto (sin variable, o vacía), es "keychain"', () => {
    expect(resolveSecretStoreMode({})).toBe('keychain');
    expect(resolveSecretStoreMode({ HEBRA_MCP_SECRET_STORE: '' })).toBe('keychain');
  });

  it('acepta "file" y "keychain" explícitos', () => {
    expect(resolveSecretStoreMode({ HEBRA_MCP_SECRET_STORE: 'file' })).toBe('file');
    expect(resolveSecretStoreMode({ HEBRA_MCP_SECRET_STORE: 'keychain' })).toBe('keychain');
  });

  it('un modo desconocido falla con un error claro (nunca un fallback silencioso)', () => {
    expect(() => resolveSecretStoreMode({ HEBRA_MCP_SECRET_STORE: 'memoria' })).toThrow(
      SecretStoreModeError
    );
    try {
      resolveSecretStoreMode({ HEBRA_MCP_SECRET_STORE: 'memoria' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretStoreModeError);
      expect((error as SecretStoreModeError).code).toBe('secret_store_mode_invalid');
      expect((error as Error).message).toContain('memoria');
    }
  });
});

describe('openSecretStoreForMode en modo "file"', () => {
  it('devuelve un FileSecretStore sin importar "@napi-rs/keyring"', async () => {
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('no debe cargarse @napi-rs/keyring en modo fichero');
    });
    vi.resetModules();
    try {
      const { openSecretStoreForMode: openInIsolation } = await import('../../src/secrets/store-mode');
      const dataDir = await tmpDataDir();
      const store = await openInIsolation('file', dataDir);
      // `vi.resetModules()` da una copia distinta de la clase (otra identidad de
      // módulo), así que se comprueba por nombre y por comportamiento, no por
      // `instanceof` contra la `FileSecretStore` importada arriba.
      expect(store.constructor.name).toBe('FileSecretStore');
      // Ida y vuelta real, para confirmar que el almacén devuelto funciona de verdad.
      await store.set('recovery-code', 'hebra-recovery-v2:abc');
      await expect(store.get('recovery-code')).resolves.toBe('hebra-recovery-v2:abc');
    } finally {
      vi.doUnmock('@napi-rs/keyring');
      vi.resetModules();
    }
  });

  it('en cambio, en modo "keychain" sí lo importa (control del propio test)', async () => {
    let imported = false;
    vi.doMock('@napi-rs/keyring', () => {
      imported = true;
      throw new Error('no hay llavero en este entorno de test');
    });
    vi.resetModules();
    try {
      const { openSecretStoreForMode: openInIsolation } = await import('../../src/secrets/store-mode');
      await expect(openInIsolation('keychain', '/tmp/no-usado')).rejects.toThrow();
      expect(imported).toBe(true);
    } finally {
      vi.doUnmock('@napi-rs/keyring');
      vi.resetModules();
    }
  });
});
