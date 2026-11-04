/**
 * D22, SPEC.md §12.10: los secretos globales salen del `secrets.json` de `legacy-root` a
 * `control/secrets.json`. Las caídas se simulan cortando en cada frontera real entre dos
 * escrituras; lo que debe sobrevivir es lo que hay en disco, así que cada reanudación usa
 * almacenes nuevos. Todos los valores son sintéticos.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountContexts } from '../../src/accounts/contexts';
import { ControlSecretsError, migrateControlSecrets, openControlSecrets, openControlSecretStore,
  restoreControlSecrets, rollbackControlSecrets } from '../../src/accounts/control-secrets';
import { accountControlDir } from '../../src/accounts/control-ipc';
import { AccountRegistry } from '../../src/accounts/registry';
import { AccountRemovalService } from '../../src/accounts/removal';
import { WriterLock } from '../../src/lock';
import type { ActiveGrant } from '../../src/oauth/backchannel';
import { GrantSecrets } from '../../src/oauth/grants';
import { RefreshSealer } from '../../src/oauth/sumego-refresh';
import { CONTROL_ROLLBACK_MARK, CONTROL_SECRET_KEYS, fileSecretStorePath, MemorySecretStore, openFileSecretStore,
  type FileSecretStore, type StoredSecrets } from '../../src/secrets';

const dirs: string[] = [];
const FAMILY_A = 'A'.repeat(22);
const FAMILY_B = 'B'.repeat(22);
const BEARER_A = 'a1'.repeat(32);
const BEARER_B = 'b2'.repeat(32);
const CODE_HASH = 'c3'.repeat(32);
const PENDING_BEARER = 'd4'.repeat(32);
const PERSONAL = 'hebra-recovery-v2:personal-sintetico';
const SEALED_PLAIN = 'refresh-sintetico-de-sumego';

const grant: ActiveGrant = { active: true, credentialId: '00000000-0000-4000-8000-000000000001',
  clientId: 'hebra-mcp-claude', resource: 'https://mcp.hebra.pro/mcp', scope: 'hebra:mcp',
  accountId: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z',
  pairedCredentialId: '10000000-0000-4000-8000-000000000001', syncVaultId: '1'.repeat(32),
  opaqueDeviceId: '2'.repeat(32) };

beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hebra-control-secrets-'));
  dirs.push(dir);
  return dir;
}

/** La raíz como la deja la imagen anterior, con sus propios escritores. */
async function seedLegacyRoot(dataDir: string): Promise<{ sealed: string; expected: StoredSecrets }> {
  const legacy = openFileSecretStore(dataDir);
  await legacy.set('recovery-code', PERSONAL);
  const grants = await GrantSecrets.open(legacy, []);
  await grants.set(FAMILY_A, BEARER_A, [FAMILY_A]);
  await grants.set(FAMILY_B, BEARER_B, [FAMILY_A, FAMILY_B]);
  await grants.stage(CODE_HASH, PENDING_BEARER);
  const sealed = (await RefreshSealer.open(legacy)).seal(SEALED_PLAIN);
  return { sealed, expected: await rawGlobals(legacy) };
}

async function rawGlobals(store: FileSecretStore): Promise<StoredSecrets> {
  const state = await store.inspect();
  if (state.status !== 'present') return {};
  return Object.fromEntries(CONTROL_SECRET_KEYS.flatMap((key) =>
    state.values[key] === undefined ? [] : [[key, state.values[key]]]));
}

function stores(dataDir: string): { legacy: FileSecretStore; control: FileSecretStore } {
  return { legacy: openFileSecretStore(dataDir), control: openControlSecretStore(dataDir) };
}

function controlPath(dataDir: string): string {
  return fileSecretStorePath(accountControlDir(dataDir));
}

/** Lo que no puede pasar nunca: un valor perdido, cambiado o distinto en las dos fuentes. */
async function expectNothingLostNorDivergent(dataDir: string, expected: StoredSecrets): Promise<void> {
  const { legacy, control } = stores(dataDir);
  const inLegacy = await rawGlobals(legacy);
  const inControl = await rawGlobals(control);
  for (const key of CONTROL_SECRET_KEYS) {
    const found = [inLegacy[key], inControl[key]].filter((value) => value !== undefined);
    expect(found.length).toBeGreaterThan(0);
    for (const value of found) expect(value).toBe(expected[key]);
  }
  expect(await legacy.get('recovery-code')).toBe(PERSONAL);
}

async function expectMigrated(dataDir: string, expected: StoredSecrets): Promise<void> {
  const { legacy, control } = stores(dataDir);
  expect(await rawGlobals(control)).toEqual(expected);
  expect(await rawGlobals(legacy)).toEqual({});
  expect(await legacy.get('recovery-code')).toBe(PERSONAL);
  expect(await control.get(CONTROL_ROLLBACK_MARK)).toBeNull();
  // El bearer de nadie queda en el fichero personal, ni en el JSON ni en un temporal.
  for (const name of (await readdir(dataDir)).filter((entry) => entry.includes('secrets.json'))) {
    const raw = await readFile(join(dataDir, name), 'utf8');
    for (const secret of [BEARER_A, BEARER_B, PENDING_BEARER]) expect(raw).not.toContain(secret);
  }
}

describe('migrateControlSecrets', () => {
  it('migración limpia: mueve los valores tal cual, en 0600 y 0700, y deja lo personal', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);

    const report = await migrateControlSecrets(legacy, control);

    expect(report.retired.sort()).toEqual([...CONTROL_SECRET_KEYS].sort());
    await expectMigrated(dataDir, expected);
    expect((await stat(controlPath(dataDir))).mode & 0o777).toBe(0o600);
    expect((await stat(accountControlDir(dataDir))).mode & 0o777).toBe(0o700);
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(accountControlDir(dataDir))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('corrige permisos más abiertos aunque no haya nada que migrar', async () => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await chmod(controlPath(dataDir), 0o644);
    await chmod(accountControlDir(dataDir), 0o755);

    await migrateControlSecrets(legacy, control);

    expect((await stat(controlPath(dataDir))).mode & 0o777).toBe(0o600);
    expect((await stat(accountControlDir(dataDir))).mode & 0o777).toBe(0o700);
  });

  it('sin secretos globales en ningún sitio no crea nada', async () => {
    const dataDir = await tempDataDir();
    await openFileSecretStore(dataDir).set('recovery-code', PERSONAL);
    const { legacy, control } = stores(dataDir);

    await expect(migrateControlSecrets(legacy, control)).resolves.toEqual({ retired: [], copied: [] });

    expect(await readdir(dataDir)).toEqual(['secrets.json']);
  });

  it('volver a migrar no tiene efecto: ninguno de los dos ficheros se reescribe', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    await migrateControlSecrets(openFileSecretStore(dataDir), openControlSecretStore(dataDir));
    const snapshot = async () => {
      const [source, target] = await Promise.all([
        stat(fileSecretStorePath(dataDir), { bigint: true }), stat(controlPath(dataDir), { bigint: true })
      ]);
      return [source.ino, source.mtimeNs, target.ino, target.mtimeNs];
    };
    const before = await snapshot();

    const { legacy, control } = stores(dataDir);
    await expect(migrateControlSecrets(legacy, control)).resolves.toEqual({ retired: [], copied: [] });

    expect(await snapshot()).toEqual(before);
    await expectMigrated(dataDir, expected);
  });

  /** Cada fila corta la ejecución en una frontera, antes o después de su efecto. */
  const FAULTS: readonly (readonly [string, (legacy: FileSecretStore, control: FileSecretStore) => void])[] = [
    ['antes de copiar', (_legacy, control) => {
      control.update = async () => { throw new Error('crash'); };
    }],
    ['tras copiar, antes de comprobar', (_legacy, control) => {
      const update = control.update.bind(control);
      control.update = async (changes) => { await update(changes); throw new Error('crash'); };
    }],
    ['al asegurar la copia en disco', (_legacy, control) => {
      control.flush = async () => { throw new Error('crash'); };
    }],
    ['antes de retirar del origen', (legacy) => {
      legacy.update = async () => { throw new Error('crash'); };
    }],
    ['tras retirar, antes de asegurarlo', (legacy) => {
      const update = legacy.update.bind(legacy);
      legacy.update = async (changes) => { await update(changes); throw new Error('crash'); };
    }],
    ['al asegurar la retirada en disco', (legacy) => {
      legacy.flush = async () => { throw new Error('crash'); };
    }],
    ['antes de barrer los temporales del origen', (legacy) => {
      legacy.deleteTemporaryFilesHolding = async () => { throw new Error('crash'); };
    }],
    ['antes de barrer los temporales de control', (_legacy, control) => {
      control.deleteTemporaryFilesHolding = async () => { throw new Error('crash'); };
    }]
  ];

  it.each(FAULTS)('caída %s: no pierde ni discrepa, y se reanuda', async (_name, inject) => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    inject(legacy, control);

    await expect(migrateControlSecrets(legacy, control)).rejects.toThrow('crash');
    await expectNothingLostNorDivergent(dataDir, expected);

    const resumed = stores(dataDir);
    await migrateControlSecrets(resumed.legacy, resumed.control);
    await expectMigrated(dataDir, expected);
  });

  it('caída en cada frontera seguida, reanudando cada vez sobre lo que dejó la anterior', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    for (const [, inject] of FAULTS) {
      const { legacy, control } = stores(dataDir);
      inject(legacy, control);
      await migrateControlSecrets(legacy, control).catch(() => undefined);
      await expectNothingLostNorDivergent(dataDir, expected);
    }
    const resumed = stores(dataDir);
    await migrateControlSecrets(resumed.legacy, resumed.control);
    await expectMigrated(dataDir, expected);
  });

  it('si lo releído no coincide con lo copiado, no retira nada', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    const inspect = control.inspect.bind(control);
    let reads = 0;
    control.inspect = async () => { reads += 1; return reads === 1 ? inspect() : { status: 'present', values: {} }; };

    await expect(migrateControlSecrets(legacy, control)).rejects.toMatchObject({ code: 'control_secrets_verify_failed' });

    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual(expected);
  });

  it('barre temporales interrumpidos que aún llevan bearers y respeta los que no', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    await writeFile(join(dataDir, '.secrets.json.interrumpido.tmp'),
      JSON.stringify({ 'hebra-mcp-oauth-grants': JSON.stringify({ [FAMILY_A]: BEARER_A }) }), { mode: 0o600 });
    await writeFile(join(dataDir, '.secrets.json.truncado.tmp'), `{"hebra-mcp-oauth-grants":"{\\"${FAMILY_A}`, { mode: 0o600 });
    await writeFile(join(dataDir, '.secrets.json.de-pair.tmp'), JSON.stringify({ 'recovery-code': PERSONAL }), { mode: 0o600 });
    await mkdir(accountControlDir(dataDir), { mode: 0o700 });
    await writeFile(join(accountControlDir(dataDir), '.secrets.json.interrumpido.tmp'),
      JSON.stringify({ 'hebra-mcp-oauth-grants': '{}' }), { mode: 0o600 });
    const { legacy, control } = stores(dataDir);

    await migrateControlSecrets(legacy, control);

    await expectMigrated(dataDir, expected);
    expect((await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))).toEqual(['.secrets.json.de-pair.tmp']);
    expect((await readdir(accountControlDir(dataDir))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('sin marca de vuelta atrás, dos valores distintos detienen el arranque y no se toca nada', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    // Lo que deja arrancar una imagen anterior sin la orden de vuelta atrás.
    await legacy.set('hebra-mcp-sumego-refresh-key', 'k'.repeat(43));
    const rawLegacy = await readFile(fileSecretStorePath(dataDir), 'utf8');
    const rawControl = await readFile(controlPath(dataDir), 'utf8');

    const failure = await migrateControlSecrets(legacy, control).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ControlSecretsError);
    expect(failure).toMatchObject({ code: 'control_secrets_conflict' });
    expect((failure as Error).message).not.toContain('k'.repeat(43));
    expect((failure as Error).message).not.toContain(expected['hebra-mcp-sumego-refresh-key']);
    expect(await readFile(fileSecretStorePath(dataDir), 'utf8')).toBe(rawLegacy);
    expect(await readFile(controlPath(dataDir), 'utf8')).toBe(rawControl);
  });

  it('un control/secrets.json corrupto detiene el arranque en vez de regenerar la clave', async () => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await writeFile(controlPath(dataDir), '{ roto', { mode: 0o600 });

    await expect(openControlSecrets(dataDir, openFileSecretStore(dataDir)))
      .rejects.toMatchObject({ code: 'control_secrets_corrupt' });

    expect(await readFile(controlPath(dataDir), 'utf8')).toBe('{ roto');
  });

  it('un secrets.json corrupto para antes de migrar y no afecta a nadie después', async () => {
    const first = await tempDataDir();
    await writeFile(fileSecretStorePath(first), '{ roto', { mode: 0o600 });
    await expect(migrateControlSecrets(...Object.values(stores(first)) as [FileSecretStore, FileSecretStore]))
      .rejects.toMatchObject({ code: 'control_secrets_source_corrupt' });
    await expect(readdir(accountControlDir(first))).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await tempDataDir();
    const { expected } = await seedLegacyRoot(second);
    const { legacy, control } = stores(second);
    await migrateControlSecrets(legacy, control);
    await writeFile(fileSecretStorePath(second), '{ roto', { mode: 0o600 });
    await expect(migrateControlSecrets(legacy, control)).resolves.toEqual({ retired: [], copied: [] });
    expect(await rawGlobals(control)).toEqual(expected);
    expect(await readFile(fileSecretStorePath(second), 'utf8')).toBe('{ roto');
  });
});

describe('openControlSecrets', () => {
  it('con otro almacén (llavero, tests) devuelve el mismo, sin crear ficheros', async () => {
    const dataDir = await tempDataDir();
    const memory = new MemorySecretStore();
    await memory.set('hebra-mcp-oauth-grants', '{}');

    expect(await openControlSecrets(dataDir, memory)).toBe(memory);

    expect(await readdir(dataDir)).toEqual([]);
    expect(await memory.get('hebra-mcp-oauth-grants')).toBe('{}');
  });

  it('un refresh sellado antes de migrar se abre después, con la misma clave y sin generar otra', async () => {
    const dataDir = await tempDataDir();
    const { sealed, expected } = await seedLegacyRoot(dataDir);

    const control = await openControlSecrets(dataDir, openFileSecretStore(dataDir));
    const sealer = await RefreshSealer.open(control);

    expect(sealer.open(sealed)).toBe(SEALED_PLAIN);
    expect(await control.get('hebra-mcp-sumego-refresh-key')).toBe(expected['hebra-mcp-sumego-refresh-key']);
  });

  it('las concesiones y los pendientes siguen legibles desde control, sin cambiar bearers', async () => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);

    const control = await openControlSecrets(dataDir, openFileSecretStore(dataDir));
    const grants = await GrantSecrets.open(control, [FAMILY_A, FAMILY_B]);
    const revoked: string[] = [];
    await GrantSecrets.recoverPending(control, [FAMILY_A, FAMILY_B], grants, async (token) => { revoked.push(token); });

    expect(grants.get(FAMILY_A)).toBe(BEARER_A);
    expect(grants.get(FAMILY_B)).toBe(BEARER_B);
    expect(revoked).toEqual([PENDING_BEARER]);
  });

  it('una instalación nueva crea sus secretos globales en control, nunca en secrets.json', async () => {
    const dataDir = await tempDataDir();
    const legacy = openFileSecretStore(dataDir);

    const control = await openControlSecrets(dataDir, legacy);
    const grants = await GrantSecrets.open(control, []);
    await grants.set(FAMILY_A, BEARER_A, [FAMILY_A]);
    await RefreshSealer.open(control);

    expect(await rawGlobals(legacy)).toEqual({});
    expect(Object.keys(await rawGlobals(openControlSecretStore(dataDir))).sort())
      .toEqual(['hebra-mcp-oauth-grants', 'hebra-mcp-sumego-refresh-key']);
  });
});

describe('vuelta atrás', () => {
  it('copia de vuelta sin borrar control, y la imagen anterior encuentra sus concesiones y su clave', async () => {
    const dataDir = await tempDataDir();
    const { sealed, expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);

    const report = await restoreControlSecrets(legacy, control);

    expect(report.restored.sort()).toEqual([...CONTROL_SECRET_KEYS].sort());
    expect(await rawGlobals(legacy)).toEqual(expected);
    expect(await rawGlobals(control)).toEqual(expected);
    expect((await stat(fileSecretStorePath(dataDir))).mode & 0o777).toBe(0o600);
    const previous = await GrantSecrets.open(legacy, [FAMILY_A, FAMILY_B]);
    expect(previous.get(FAMILY_A)).toBe(BEARER_A);
    expect((await RefreshSealer.open(legacy)).open(sealed)).toBe(SEALED_PLAIN);
    expect(await legacy.get('recovery-code')).toBe(PERSONAL);
  });

  it('al volver hacia delante gana lo que escribió la imagen anterior, también una revocación', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await restoreControlSecrets(legacy, control);
    const previous = await GrantSecrets.open(legacy, [FAMILY_A, FAMILY_B]);
    await previous.delete(FAMILY_A);

    await migrateControlSecrets(legacy, control);

    const newer = { ...expected, 'hebra-mcp-oauth-grants': JSON.stringify({ [FAMILY_B]: BEARER_B }) };
    await expectMigrated(dataDir, newer);
    expect((await GrantSecrets.open(control, [FAMILY_B])).get(FAMILY_A)).toBeNull();
  });

  it('volver hacia delante sin que la imagen anterior llegara a arrancar lo deja como estaba', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await restoreControlSecrets(legacy, control);

    await migrateControlSecrets(legacy, control);

    await expectMigrated(dataDir, expected);
  });

  it('repetir la orden con la imagen anterior ya en marcha no pisa lo que esta escribió', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await restoreControlSecrets(legacy, control);
    const newerGrants = JSON.stringify({ [FAMILY_B]: BEARER_B });
    await legacy.set('hebra-mcp-oauth-grants', newerGrants);

    await expect(restoreControlSecrets(legacy, control)).resolves.toEqual({ restored: [] });

    expect(await rawGlobals(legacy)).toEqual({ ...expected, 'hebra-mcp-oauth-grants': newerGrants });
  });

  it.each([
    ['antes de copiar', (legacy: FileSecretStore) => {
      legacy.update = async () => { throw new Error('crash'); };
    }],
    ['tras copiar', (legacy: FileSecretStore) => {
      const update = legacy.update.bind(legacy);
      legacy.update = async (changes) => { await update(changes); throw new Error('crash'); };
    }],
    ['al asegurar en disco', (legacy: FileSecretStore) => {
      legacy.flush = async () => { throw new Error('crash'); };
    }]
  ])('caída %s: repetir la orden termina, y también volver hacia delante', async (_name, inject) => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const first = stores(dataDir);
    await migrateControlSecrets(first.legacy, first.control);
    const crashed = stores(dataDir);
    inject(crashed.legacy);

    await expect(restoreControlSecrets(crashed.legacy, crashed.control)).rejects.toThrow('crash');
    expect(await rawGlobals(openControlSecretStore(dataDir))).toEqual(expected);

    const repeated = stores(dataDir);
    await restoreControlSecrets(repeated.legacy, repeated.control);
    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual(expected);

    const forward = stores(dataDir);
    await migrateControlSecrets(forward.legacy, forward.control);
    await expectMigrated(dataDir, expected);
  });

  it('una caída entre la marca y la copia no impide volver hacia delante', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    const crashed = stores(dataDir);
    crashed.legacy.update = async () => { throw new Error('crash'); };
    await expect(restoreControlSecrets(crashed.legacy, crashed.control)).rejects.toThrow('crash');

    await migrateControlSecrets(legacy, control);

    await expectMigrated(dataDir, expected);
  });

  it('sin marca, un valor distinto en secrets.json detiene la orden sin marcar nada', async () => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await legacy.set('hebra-mcp-oauth-pending', '{}');

    await expect(restoreControlSecrets(legacy, control)).rejects.toMatchObject({ code: 'control_secrets_conflict' });

    expect(await control.get(CONTROL_ROLLBACK_MARK)).toBeNull();
  });

  it('sin migración previa no hay nada que hacer y no crea control/secrets.json', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);

    await expect(rollbackControlSecrets(dataDir)).resolves.toEqual({ restored: [] });

    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual(expected);
    await expect(stat(controlPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('con el servicio en marcha se niega, y sin él toma y suelta el bloqueo de control', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    // Otro PID vivo: el padre del worker de vitest.
    const server = new WriterLock({ dataDir: accountControlDir(dataDir), pid: process.ppid, releaseOnExit: false });
    expect(server.tryAcquire()).toBe(true);

    await expect(rollbackControlSecrets(dataDir)).rejects.toMatchObject({ code: 'control_secrets_busy' });
    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual({});

    server.release();
    const report = await rollbackControlSecrets(dataDir);
    expect(report.restored.sort()).toEqual([...CONTROL_SECRET_KEYS].sort());
    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual(expected);
    expect(await readdir(accountControlDir(dataDir))).toEqual(['secrets.json']);
  });
});

describe('retirar a la persona de legacy-root', () => {
  async function removeLegacy(dataDir: string) {
    const registry = await AccountRegistry.open(dataDir);
    const account = await registry.claimLegacy({ sub: 'david', grant });
    const service = new AccountRemovalService({ dataDir, registry,
      contexts: new AccountContexts(registry, async () => { throw new Error('unexpected_open'); }),
      oauth: { invalidateAccount: async () => 1 }, revokeDevice: async () => undefined,
      legacySecrets: openFileSecretStore(dataDir) });
    return { registry, account, service };
  }

  it('borra de secrets.json solo lo suyo y deja control/secrets.json intacto', async () => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await legacy.set('lumbre-connection', '{"sintetico":true}');
    await migrateControlSecrets(legacy, control);
    await writeFile(join(dataDir, 'library.sqlite'), 'personal');
    const rawControl = await readFile(controlPath(dataDir), 'utf8');
    const { registry, account, service } = await removeLegacy(dataDir);

    await service.remove(account);

    expect(registry.findById(account.id)?.state).toBe('removed');
    expect(await readFile(controlPath(dataDir), 'utf8')).toBe(rawControl);
    expect(JSON.parse(await readFile(fileSecretStorePath(dataDir), 'utf8'))).toEqual({});
    await expect(stat(join(dataDir, 'library.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    const grants = await GrantSecrets.open(openControlSecretStore(dataDir), [FAMILY_B]);
    expect(grants.get(FAMILY_B)).toBe(BEARER_B);
  });

  it('con los campos aún en secrets.json (vuelta atrás) tampoco se los lleva', async () => {
    const dataDir = await tempDataDir();
    const { expected } = await seedLegacyRoot(dataDir);
    const { account, service } = await removeLegacy(dataDir);

    await service.remove(account);

    expect(await rawGlobals(openFileSecretStore(dataDir))).toEqual(expected);
    expect(await openFileSecretStore(dataDir).get('recovery-code')).toBeNull();
  });

  it.each([
    ['un fichero en la raíz', async (dataDir: string) => { await writeFile(join(dataDir, 'sin-clasificar.json'), '{}'); }],
    ['un fichero en control/', async (dataDir: string) => { await writeFile(join(accountControlDir(dataDir), 'sin-clasificar.json'), '{}'); }],
    ['una clave en secrets.json', async (dataDir: string) => {
      const raw = JSON.parse(await readFile(fileSecretStorePath(dataDir), 'utf8')) as Record<string, string>;
      await writeFile(fileSecretStorePath(dataDir), JSON.stringify({ ...raw, 'clave-sin-clasificar': 'x' }), { mode: 0o600 });
    }]
  ])('%s sin clasificar detiene el borrado y conserva los datos', async (_name, plant) => {
    const dataDir = await tempDataDir();
    await seedLegacyRoot(dataDir);
    const { legacy, control } = stores(dataDir);
    await migrateControlSecrets(legacy, control);
    await writeFile(join(dataDir, 'library.sqlite'), 'personal');
    await plant(dataDir);
    const { registry, account, service } = await removeLegacy(dataDir);

    await expect(service.remove(account)).rejects.toThrow('legacy_inventory_unknown');

    expect(registry.findById(account.id)).toMatchObject({ state: 'removing', removalPhase: 'remote-revoked' });
    expect(await readFile(join(dataDir, 'library.sqlite'), 'utf8')).toBe('personal');
    expect(await openFileSecretStore(dataDir).get('recovery-code')).toBe(PERSONAL);
  });
});
