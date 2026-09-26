/**
 * `pair` → `serve` → revocación → `unpair` de punta a punta contra `FakeLumbre` (HTTP de
 * verdad en 127.0.0.1) y una biblioteca REAL: un «Mac» montado como Hebra monta los suyos
 * (`test/sync/devices.ts`) sube notas cifradas al relé, y otra credencial de la cuenta
 * aprueba la solicitud con `grantDeviceLink` de Hebra, como Ajustes > Sincronización.
 *
 * Criterio de cierre de L2 (offline): aprobación, secretos guardados y `hebra_status` con
 * `linked: true`; un 401 deja `revoked: true`; `unpair` deja vacíos el llavero de test y el
 * directorio; y ni un secreto, código, token ni título en stderr.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeRecoveryCode,
  grantDeviceLink,
  HttpDeviceLinkTransport,
  type LumbreConnection
} from '../../src/hebra';
import { PairError } from '../../src/pair/errors';
import { runPair, type PairOptions } from '../../src/pair/pair';
import { runUnpair } from '../../src/pair/unpair';
import { MemorySecretStore, readPairedSecrets } from '../../src/secrets';
import { resolveToolContext } from '../../src/server/context';
import { openServeContext } from '../../src/server/serve';
import { runStatus } from '../../src/server/tools/status';
import { IDENTITY, VAULT_KEY, appCreate, appDevice } from '../sync/devices';
import { FakeLumbre, LUMBRE } from './fake-lumbre';

const TITLES = ['Lista de la compra', 'Ideas para el viaje', 'Receta de lentejas'];
const LOCK = { releaseOnExit: false };

interface ScriptedTerminal {
  lines: string[];
  print(line: string): void;
  confirm(question: string): Promise<boolean>;
}

function scriptedTerminal(answers: boolean[]): ScriptedTerminal {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => void lines.push(line),
    confirm: async (question) => {
      lines.push(question);
      return answers.shift() ?? false;
    }
  };
}

/** La otra credencial de la cuenta (el Mac) aprueba la primera solicitud que vea. */
async function approveWhenAsked(approver: LumbreConnection, fake: FakeLumbre, recoveryCode: string) {
  const transport = new HttpDeviceLinkTransport({ get: async () => approver }, fake.deviceLinks.fetch);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { requests } = await transport.list();
    if (requests.length > 0) {
      await grantDeviceLink(transport, requests[0], recoveryCode);
      return requests[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('nadie pidió acceso');
}

describe('hebra-mcp pair (offline, contra FakeLumbre)', () => {
  let fake: FakeLumbre;
  let dataDir: string;
  let recoveryCode: string;
  let approver: LumbreConnection;
  let stderr: string[];

  beforeEach(async () => {
    fake = await FakeLumbre.start();
    fake.addLibraryVault('david', IDENTITY.syncVaultId);
    approver = fake.addLinkedApprover('david', IDENTITY.syncVaultId, 'cred-mac');
    const app = await appDevice(fake.relay);
    for (const title of TITLES) await appCreate(app, `# ${title}\n\nTexto de ${title}.`);
    expect((await app.sync.runRound()).result).toBe('ok');
    recoveryCode = await encodeRecoveryCode({
      relayOrigin: LUMBRE,
      syncVaultId: IDENTITY.syncVaultId,
      keyEpoch: 1,
      vaultKey: VAULT_KEY
    });
    dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-pair-'));
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function pairOptions(
    secrets: MemorySecretStore,
    terminal: ScriptedTerminal,
    tamper?: (callback: URL) => URL
  ): PairOptions {
    return {
      dataDir,
      secrets,
      terminal,
      lumbreOrigin: LUMBRE,
      fetcher: fake.fetcher,
      openUrl: async (url) => {
        void fake.approveInBrowser(url, tamper).catch(() => undefined);
        return true;
      },
      pollMs: 10,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
      instance: { lock: LOCK, checkIntervalMs: null },
      firstSyncTimeoutMs: 10_000
    };
  }

  it('aprobación, secretos, linked:true, revocación, unpair; y nada secreto en stderr', async () => {
    const secrets = new MemorySecretStore();
    const terminal = scriptedTerminal([true]);
    const approval = approveWhenAsked(approver, fake, recoveryCode);
    // (1) Una web dispara el callback con un apiOrigin falso: el canje va igual a LUMBRE.
    const result = await runPair(
      pairOptions(secrets, terminal, (callback) => {
        callback.searchParams.set('apiOrigin', 'https://evil.test');
        return callback;
      })
    );
    const request = await approval;

    expect(result).toEqual({ mode: 'linked', register: 'ok', firstSync: 'ok', pulled: TITLES.length });
    expect(fake.requested.some((url) => url.includes('evil.test'))).toBe(false);
    expect(fake.requested).toContain(`${LUMBRE}/api/integrations/hebra/exchange`);

    // (6) y (4): el canje llegó sin Origin, con un verifier de 32 bytes o más.
    expect(fake.exchanges).toHaveLength(1);
    const [exchange] = fake.exchanges;
    expect(exchange.status).toBe(200);
    expect(exchange.headers.origin).toBeUndefined();
    const verifier = exchange.body.code_verifier as string;
    expect(Buffer.from(verifier, 'base64url').byteLength).toBeGreaterThanOrEqual(32);

    // Vínculo: plataforma agent, etiqueta saneada, completado en el relé.
    expect(request.platform).toBe('agent');
    expect(request.label).toBe('Claude (hebra-mcp)');
    expect(fake.deviceLinks.rows().map((row) => row.state)).toEqual(['completed']);
    expect(terminal.lines).toContain('  «Claude (hebra-mcp)» · Claude');
    for (const title of TITLES) expect(terminal.lines).toContain(`  · ${title}`);

    // Secretos en el llavero de test, y el dispositivo registrado en la bóveda.
    expect(secrets.size).toBe(3);
    const paired = await readPairedSecrets(secrets);
    expect(paired?.connection.credentialId).toBe('cred-mcp-1');
    expect(paired?.connection.apiOrigin).toBe(LUMBRE);
    expect(paired?.recoveryCode).toBe(recoveryCode);
    expect(fake.registrations).toEqual([{ syncVaultId: IDENTITY.syncVaultId, credentialId: 'cred-mcp-1' }]);

    // serve con los secretos: linked:true y la biblioteca descargada.
    const served = await openServeContext({
      dataDir,
      secrets,
      fetcher: fake.fetcher,
      instance: { lock: LOCK, checkIntervalMs: null },
      syncIntervalMs: null
    });
    try {
      await served.instance.whenReady();
      const status = await runStatus(await resolveToolContext(served.ctx));
      expect(status).toMatchObject({
        linked: true,
        revoked: false,
        writer: 'this',
        lastSyncOutcome: 'ok',
        pendingUpload: 0
      });
      const notes = await served.ctx.port.notesPage(null, 50, { kind: 'all' });
      expect(notes.items.map((item) => item.title).sort()).toEqual([...TITLES].sort());

      // unpair con serve abierto: no borra nada. Otro `pid` para que el bloqueo de
      // `serve` (este mismo proceso) cuente como de OTRA instancia viva, como en la vida
      // real (`writer-lock.ts` trata el mismo pid con otro nonce como huérfano).
      const refused = await runUnpair({
        dataDir,
        secrets,
        terminal: scriptedTerminal([true]),
        lock: { ...LOCK, pid: process.pid + 1 }
      }).catch((error: unknown) => error);
      expect((refused as PairError).code).toBe('other_instance_running');
      expect(secrets.size).toBe(3);

      // Revocación en Lumbre: la siguiente ronda recibe 401 y el estado lo dice.
      fake.revoke('cred-mcp-1');
      await served.instance.syncRunner!.requestRound();
      expect(await runStatus(await resolveToolContext(served.ctx))).toMatchObject({
        linked: true,
        revoked: true,
        lastSyncOutcome: 'http_401'
      });
    } finally {
      await served.close();
    }

    // unpair: llavero de test y directorio vacíos.
    const unpaired = await runUnpair({ dataDir, secrets, terminal: scriptedTerminal([true]), lock: LOCK });
    expect(unpaired).toEqual({ confirmed: true, deletedSecrets: 3, removedDataDir: true });
    expect(secrets.size).toBe(0);
    expect(existsSync(dataDir)).toBe(false);

    // Logs: ni códigos, ni verifier, ni tokens, ni código de recuperación, ni títulos.
    const logged = stderr.join('');
    expect(logged).toContain('"event":"pair.step"');
    const forbidden = [
      ...fake.issuedCodes,
      ...fake.issuedTokens,
      verifier,
      recoveryCode,
      recoveryCode.split(':')[1],
      Buffer.from(VAULT_KEY).toString('hex'),
      ...TITLES,
      'Texto de'
    ];
    for (const needle of forbidden) expect(logged).not.toContain(needle);
    for (const line of stderr) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('otra cuenta al renovar la credencial: account_mismatch y no se guarda nada', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('recovery-code', recoveryCode);
    await secrets.set(
      'device-identity',
      JSON.stringify({ opaqueDeviceId: 'ef'.repeat(16), lumbreDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab' })
    );
    fake.approvingUser = 'otra';
    const failure = await runPair(pairOptions(secrets, scriptedTerminal([true]))).catch(
      (error: unknown) => error
    );
    expect((failure as PairError).code).toBe('account_mismatch');
    expect(await secrets.get('lumbre-connection')).toBeNull();
    expect(fake.deviceLinks.rows()).toEqual([]);
  });

  it('misma cuenta con identidad guardada: solo renueva la credencial', async () => {
    const secrets = new MemorySecretStore();
    await secrets.set('recovery-code', recoveryCode);
    await secrets.set(
      'device-identity',
      JSON.stringify({ opaqueDeviceId: 'ef'.repeat(16), lumbreDeviceId: '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab' })
    );
    const result = await runPair(pairOptions(secrets, scriptedTerminal([])));
    expect(result.mode).toBe('credential_renewed');
    expect(result.firstSync).toBe('ok');
    expect(fake.exchanges[0].body.deviceId).toBe('6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab');
    expect((await readPairedSecrets(secrets))?.connection.credentialId).toBe('cred-mcp-1');
    expect(fake.deviceLinks.rows()).toEqual([]);
  });

  it('David no reconoce las notas: cancela y no guarda nada', async () => {
    const secrets = new MemorySecretStore();
    const approval = approveWhenAsked(approver, fake, recoveryCode);
    const failure = await runPair(pairOptions(secrets, scriptedTerminal([false]))).catch(
      (error: unknown) => error
    );
    await approval;
    expect((failure as PairError).code).toBe('not_confirmed');
    expect(secrets.size).toBe(0);
    expect(fake.deviceLinks.rows().map((row) => row.state)).toEqual(['cancelled']);
    expect(existsSync(join(dataDir, 'library.sqlite'))).toBe(false);
  });

  it('Hebra deniega: link_denied y no guarda nada', async () => {
    const secrets = new MemorySecretStore();
    const transport = new HttpDeviceLinkTransport({ get: async () => approver }, fake.deviceLinks.fetch);
    const denial = (async () => {
      for (;;) {
        const { requests } = await transport.list();
        if (requests.length > 0) return transport.cancel(requests[0].id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const failure = await runPair(pairOptions(secrets, scriptedTerminal([true]))).catch(
      (error: unknown) => error
    );
    await denial;
    expect((failure as PairError).code).toBe('link_denied');
    expect(secrets.size).toBe(0);
  });

  it('código no hexadecimal en el callback: rechazado, y el bueno sigue valiendo', async () => {
    const secrets = new MemorySecretStore();
    const approval = approveWhenAsked(approver, fake, recoveryCode);
    const options = pairOptions(secrets, scriptedTerminal([true]));
    const statuses: number[] = [];
    options.openUrl = async (url) => {
      const webOrigin = new URL(url).searchParams.get('webOrigin')!;
      statuses.push((await fetch(`${webOrigin}/lumbre/connect?code=NO-ES-HEX`)).status);
      void fake.approveInBrowser(url).catch(() => undefined);
      return true;
    };
    const result = await runPair(options);
    await approval;
    expect(statuses).toEqual([400]);
    expect(result.mode).toBe('linked');
    expect(fake.exchanges).toHaveLength(1);
  });
});
