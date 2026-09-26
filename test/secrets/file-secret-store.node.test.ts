/**
 * SPEC.md §12.3: `FileSecretStore` sobre un JSON 0600 en un directorio 0700, escritura
 * atómica, corrección de permisos y valor corrupto = ausente.
 */
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSecretStore,
  fileSecretStorePath,
  openFileSecretStore
} from '../../src/secrets/file-secret-store';
import { clearPairedSecrets } from '../../src/secrets/paired-secrets';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-mcp-file-secrets-'));
  dirs.push(dir);
  return dir;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('FileSecretStore', () => {
  it('crea el JSON en 0600 dentro de un directorio 0700, y lee lo escrito', async () => {
    const dataDir = await tmpDataDir();
    const store = openFileSecretStore(dataDir);

    await store.set('recovery-code', 'hebra-recovery-v2:abc');

    const path = fileSecretStorePath(dataDir);
    expect(await modeOf(dataDir)).toBe(0o700);
    expect(await modeOf(path)).toBe(0o600);
    expect(await store.get('recovery-code')).toBe('hebra-recovery-v2:abc');
    expect(await store.get('device-identity')).toBeNull();
  });

  it('escritura atómica: no deja ficheros temporales tras `set`', async () => {
    const dataDir = await tmpDataDir();
    const store = openFileSecretStore(dataDir);

    await store.set('recovery-code', 'hebra-recovery-v2:abc');
    await store.set('device-identity', '{"opaqueDeviceId":"x"}');

    const entries = await readdir(dataDir);
    expect(entries).toEqual(['secrets.json']);
  });

  it('corrige permisos de un directorio y fichero preexistentes más abiertos', async () => {
    const dataDir = await tmpDataDir();
    const path = fileSecretStorePath(dataDir);

    // Simula un despliegue anterior con permisos flojos.
    await writeFile(path, JSON.stringify({ 'recovery-code': 'hebra-recovery-v2:abc' }));
    await chmod(path, 0o644);
    await chmod(dataDir, 0o755);

    const store = openFileSecretStore(dataDir);
    expect(await store.get('recovery-code')).toBe('hebra-recovery-v2:abc');
    expect(await modeOf(path)).toBe(0o600);

    await store.set('device-identity', '{"opaqueDeviceId":"y"}');
    expect(await modeOf(dataDir)).toBe(0o700);
  });

  it('un JSON inválido cuenta como ausente, sin lanzar', async () => {
    const dataDir = await tmpDataDir();
    const path = fileSecretStorePath(dataDir);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path, 'esto no es json', { mode: 0o600 });

    const store = openFileSecretStore(dataDir);
    await expect(store.get('recovery-code')).resolves.toBeNull();
    await expect(store.get('device-identity')).resolves.toBeNull();
  });

  it('un campo con forma incorrecta cuenta como ausente para esa clave, sin afectar a las demás', async () => {
    const dataDir = await tmpDataDir();
    const path = fileSecretStorePath(dataDir);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      JSON.stringify({ 'recovery-code': 42, 'device-identity': '{"opaqueDeviceId":"y"}' }),
      { mode: 0o600 }
    );

    const store = openFileSecretStore(dataDir);
    await expect(store.get('recovery-code')).resolves.toBeNull();
    await expect(store.get('device-identity')).resolves.toBe('{"opaqueDeviceId":"y"}');
  });

  it('un JSON que no es un objeto (array, cadena) cuenta como ausente', async () => {
    const dataDir = await tmpDataDir();
    const path = fileSecretStorePath(dataDir);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(['no', 'es', 'un', 'objeto']), { mode: 0o600 });

    const store = openFileSecretStore(dataDir);
    await expect(store.get('recovery-code')).resolves.toBeNull();
  });

  it('`delete` borra una clave y devuelve si había algo que borrar', async () => {
    const dataDir = await tmpDataDir();
    const store = openFileSecretStore(dataDir);
    await store.set('recovery-code', 'hebra-recovery-v2:abc');

    await expect(store.delete('recovery-code')).resolves.toBe(true);
    await expect(store.get('recovery-code')).resolves.toBeNull();
    await expect(store.delete('recovery-code')).resolves.toBe(false);
  });

  it('`unpair` (clearPairedSecrets) deja el almacén de fichero vacío', async () => {
    const dataDir = await tmpDataDir();
    const store: FileSecretStore = openFileSecretStore(dataDir);
    await store.set('recovery-code', 'hebra-recovery-v2:abc');
    await store.set('device-identity', '{"opaqueDeviceId":"x"}');
    await store.set('lumbre-connection', '{"credentialId":"c"}');

    const deleted = await clearPairedSecrets(store);
    expect(deleted).toBe(3);

    for (const key of ['recovery-code', 'device-identity', 'lumbre-connection'] as const) {
      await expect(store.get(key)).resolves.toBeNull();
    }
    // El fichero sigue en 0600, pero su contenido queda en `{}`: ninguna clave viva.
    const raw = JSON.parse(await readFile(fileSecretStorePath(dataDir), 'utf8'));
    expect(raw).toEqual({});
  });
});
