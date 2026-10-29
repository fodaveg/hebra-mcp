/**
 * Lumbre de mentira, por HTTP de verdad (`node:http` en `127.0.0.1`), para probar `pair` y
 * `serve` sin red (L2, criterio de cierre «Offline»):
 *
 * - `POST /api/integrations/hebra/pair`: lo que hace la página `/integrations/hebra` con
 *   David dentro. Exige un `webOrigin` loopback con IP literal y PKCE S256 (contrato L2a)
 *   y devuelve `callbacks.web` = `<webOrigin>/lumbre/connect?code=<64 hex>&apiOrigin=…`.
 * - `POST /api/integrations/hebra/exchange`: guarda las cabeceras recibidas (para la
 *   obligación 6: sin `Origin`), responde 403 con `Origin`, 401 con verifier incorrecto
 *   (sin quemar el código) y emite la credencial.
 * - `…/device-links…`: lo reenvía tal cual a `MemoryDeviceLinkRelay` de Hebra (el doble
 *   que usan los tests de `device-link` de Hebra), que habla el mismo HTTP que el relé.
 * - `…/library/v1/vaults/{id}/{changes,records}`: el HTTP de `HttpLibraryTransport` sobre
 *   `InMemoryLibraryRelay` de Hebra (el doble de `sync-engine.test.ts`), con Bearer de
 *   lectura/escritura, 401 para un token revocado y 404 para una bóveda de otra cuenta.
 * - `POST …/blob-v2/vaults/{id}/devices`: registro del dispositivo (201).
 *
 * El relé exige `https:` (`normalizeRelayOrigin`), así que el origen LÓGICO de Lumbre es
 * `https://lumbre.test` y `fetcher` reescribe esas URLs a `http://127.0.0.1:<puerto>` antes
 * de llamar al `fetch` de Node, sin tocar el `init`: las cabeceras que ve el servidor son
 * las que manda hebra-mcp. `requested` guarda cada URL LÓGICA pedida.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  base64FromBytes,
  bytesFromBase64,
  DEVICE_LINKS_PATH,
  InMemoryLibraryRelay,
  MemoryDeviceLinkRelay
} from '../hebra-testing';

import { MultiVaultLibraryRelay } from '../../vendor/hebra/src/lib/library/testing/multi-vault-relay';
import { agentDeviceKeyId } from '../../src/hebra';
import type { AgentSpaceAccess } from '../../src/spaces/protocol';

export const LUMBRE = 'https://lumbre.test';
const LIBRARY_PATH = /^\/api\/integrations\/hebra\/library\/v1\/vaults\/([0-9a-f]{32})\/(changes|records)$/;
const DEVICES_PATH = /^\/api\/integrations\/hebra\/blob-v2\/vaults\/([0-9a-f]{32})\/devices$/;
const LOOPBACK_WEB_ORIGIN = /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/;

interface PendingCode {
  userId: string;
  deviceId: string;
  label: string;
  challenge: string;
}

interface TokenEntry {
  credentialId: string;
  userId: string;
  kind: 'read' | 'write';
}

export interface ExchangeSeen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
  status: number;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class FakeLumbre {
  readonly deviceLinks = new MemoryDeviceLinkRelay({ apiOrigin: LUMBRE });
  readonly relay = new InMemoryLibraryRelay();
  readonly sharedRelay = new MultiVaultLibraryRelay('unused-control-grant');
  relayFor(vault: string) { return this.vaultOwners.has(vault) ? this.relay : this.sharedRelay.vault(vault); }
  /** Cuenta con la que «David» aprueba en la página de Lumbre. */
  approvingUser = 'david';
  readonly exchanges: ExchangeSeen[] = [];
  readonly registrations: Array<{ syncVaultId: string; credentialId: string }> = [];
  /** URLs LÓGICAS pedidas por `fetcher` (`https://lumbre.test/…` o cualquier otra). */
  readonly requested: string[] = [];
  /** Códigos emitidos por `/pair` (para comprobar que no llegan a stderr). */
  readonly issuedCodes: string[] = [];
  /** Tokens emitidos (ídem). */
  readonly issuedTokens: string[] = [];
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly vaultOwners = new Map<string, string>();
  private credentialCount = 0;
  readonly agentKeys = new Map<string, { deviceId: string; publicKey: unknown; keyId: string; accountId: string }>();
  readonly agentSpaces = new Map<string, AgentSpaceAccess[]>();
  /** Con él, `GET /spaces/agent-access` avisa con `entered` y no contesta hasta `released`:
   *  un relé lento, para comprobar que su latencia no entra en el turno de escritura. */
  agentAccessHold: { entered(): void; released: Promise<void> } | null = null;
  private readonly deviceIds = new Map<string, string>();

  addAgent(userId: string, deviceId: string) {
    const credentialId = randomUUID();
    const connection = this.deviceLinks.addCredential({ userId, credentialId, label: 'agent' });
    this.tokens.set(connection.readToken, { credentialId, userId, kind: 'read' });
    this.tokens.set(connection.writeToken, { credentialId, userId, kind: 'write' });
    this.deviceIds.set(credentialId, deviceId);
    return connection;
  }

  private mayReadVault(entry: TokenEntry, vault: string): boolean {
    return this.vaultOwners.get(vault) === entry.userId ||
      (this.agentSpaces.get(entry.credentialId) ?? []).some((space) => space.syncVaultId === vault);
  }


  private constructor(
    private readonly server: Server,
    readonly port: number
  ) {}

  static async start(): Promise<FakeLumbre> {
    let fake: FakeLumbre | null = null;
    const server = createServer((req, res) => {
      void fake!.handle(req).then(
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
        () => {
          res.writeHead(500);
          res.end();
        }
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    fake = new FakeLumbre(server, (server.address() as AddressInfo).port);
    return fake;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** `fetch` de hebra-mcp en los tests: `https://lumbre.test` → este servidor. */
  readonly fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    this.requested.push(url.toString());
    if (url.origin !== LUMBRE) return Promise.reject(new TypeError('fetch failed'));
    const local = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${this.port}`);
    return globalThis.fetch(local, init);
  };

  /** Una bóveda de biblioteca de `userId`, anterior a cualquier solicitud. */
  addLibraryVault(userId: string, syncVaultId: string): void {
    this.vaultOwners.set(syncVaultId, userId);
    this.deviceLinks.addVault({ userId, syncVaultId, createdAt: Date.now() - 3_600_000 });
  }

  /** Una credencial ya existente (la del Mac que aprueba), con su dispositivo en la bóveda. */
  addLinkedApprover(userId: string, syncVaultId: string, credentialId: string) {
    const connection = this.deviceLinks.addCredential({ userId, credentialId, label: 'Mac' });
    this.deviceLinks.registerDevice({
      userId,
      syncVaultId,
      credentialId,
      createdAt: Date.now() - 3_600_000
    });
    this.tokens.set(connection.readToken, { credentialId, userId, kind: 'read' });
    this.tokens.set(connection.writeToken, { credentialId, userId, kind: 'write' });
    return connection;
  }

  /** Revoca una credencial en Lumbre: sus tokens dejan de valer en todo el relé. */
  revoke(credentialId: string): void {
    this.deviceLinks.revokeCredential(credentialId);
    for (const [token, entry] of this.tokens) {
      if (entry.credentialId === credentialId) this.tokens.delete(token);
    }
  }

  /**
   * David en el navegador: abre la URL de emparejado, aprueba (el `POST /pair` de la
   * página) y el navegador sigue `callbacks.web` hasta el listener loopback. `tamper`
   * cambia la URL de retorno antes de seguirla (un `apiOrigin` falso, un código malo…).
   */
  async approveInBrowser(
    pairingUrl: string,
    tamper: (callback: URL) => URL = (callback) => callback
  ): Promise<Response> {
    const url = new URL(pairingUrl);
    const response = await this.fetcher(`${LUMBRE}/api/integrations/hebra/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: url.searchParams.get('deviceId'),
        label: url.searchParams.get('label'),
        webOrigin: url.searchParams.get('webOrigin'),
        code_challenge: url.searchParams.get('code_challenge'),
        code_challenge_method: url.searchParams.get('code_challenge_method')
      })
    });
    if (!response.ok) throw new Error(`pair ${response.status}`);
    const { callbacks } = (await response.json()) as { callbacks: { web: string } };
    return globalThis.fetch(tamper(new URL(callbacks.web)));
  }

  private auth(req: IncomingMessage, kind: 'read' | 'write'): TokenEntry | null {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /u, '');
    const entry = this.tokens.get(token);
    return entry && entry.kind === kind ? entry : null;
  }

  private async handle(
    req: IncomingMessage
  ): Promise<{ status: number; headers: Record<string, string>; body: string | Buffer }> {
    const url = new URL(req.url ?? '/', LUMBRE);
    const method = req.method ?? 'GET';
    const raw = await readBody(req);
    const json = (status: number, value: unknown) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value)
    });

    if (method === 'POST' && url.pathname === '/api/integrations/hebra/pair') {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, string | null>;
      if (
        !body.webOrigin ||
        !LOOPBACK_WEB_ORIGIN.test(body.webOrigin) ||
        body.code_challenge_method !== 'S256' ||
        !body.code_challenge ||
        !body.deviceId
      ) {
        return json(400, { message: 'pair inválido' });
      }
      const code = randomBytes(32).toString('hex');
      this.issuedCodes.push(code);
      this.codes.set(code, {
        userId: this.approvingUser,
        deviceId: body.deviceId,
        label: body.label ?? '',
        challenge: body.code_challenge
      });
      const web = new URL('/lumbre/connect', body.webOrigin);
      web.searchParams.set('code', code);
      web.searchParams.set('apiOrigin', LUMBRE);
      return json(200, { callbacks: { web: web.toString() } });
    }

    if (method === 'POST' && url.pathname === '/api/integrations/hebra/exchange') {
      const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      const seen: ExchangeSeen = { headers: req.headers, body, status: 0 };
      this.exchanges.push(seen);
      const respond = (status: number, value: unknown) => {
        seen.status = status;
        return json(status, value);
      };
      if (req.headers.origin) return respond(403, { message: 'Origen no autorizado' });
      const pending = typeof body.code === 'string' ? this.codes.get(body.code) : undefined;
      if (!pending || body.deviceId !== pending.deviceId) return respond(401, { message: 'no' });
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
      // Verifier incorrecto: 401 SIN quemar el código (contrato L2a).
      if (challenge !== pending.challenge) return respond(401, { message: 'no' });
      this.codes.delete(body.code as string);
      this.credentialCount += 1;
      const credentialId = `00000000-0000-4000-8000-${String(this.credentialCount).padStart(12, '0')}`;
      this.deviceIds.set(credentialId, pending.deviceId);
      const connection = this.deviceLinks.addCredential({
        userId: pending.userId,
        credentialId,
        label: pending.label
      });
      this.tokens.set(connection.readToken, { credentialId, userId: pending.userId, kind: 'read' });
      this.tokens.set(connection.writeToken, { credentialId, userId: pending.userId, kind: 'write' });
      this.issuedTokens.push(connection.readToken, connection.writeToken);
      return respond(200, {
        credentialId,
        readToken: connection.readToken,
        writeToken: connection.writeToken
      });
    }

    if (url.pathname === '/api/integrations/hebra/agent-device-key' && method === 'PUT') {
      const entry = this.auth(req, 'write');
      if (!entry) return json(401, { code: 'credential_revoked' });
      const { publicKey } = JSON.parse(raw.toString('utf8'));
      const keyId = await agentDeviceKeyId(publicKey);
      const previous = this.agentKeys.get(entry.credentialId);
      if (previous && previous.keyId !== keyId) return json(409, { code: 'version_conflict' });
      const deviceId = this.deviceIds.get(entry.credentialId)!;
      const accountId = createHash('sha256').update(`hebra-account:${entry.userId}`).digest('hex');
      const record = { publicKey, keyId, deviceId, accountId };
      this.agentKeys.set(entry.credentialId, record);
      return json(200, { ...record, credentialId: entry.credentialId, actorKind: 'agent' });
    }
    if (url.pathname === '/api/integrations/hebra/spaces/agent-access' && method === 'GET') {
      const entry = this.auth(req, 'read');
      if (!entry || !this.agentKeys.has(entry.credentialId)) return json(401, { code: 'credential_revoked' });
      const hold = this.agentAccessHold;
      if (hold) {
        hold.entered();
        await hold.released;
      }
      return json(200, { spaces: this.agentSpaces.get(entry.credentialId) ?? [] });
    }

    if (url.pathname.startsWith(DEVICE_LINKS_PATH)) {
      const response = await this.deviceLinks.fetch(new URL(`${url.pathname}${url.search}`, LUMBRE), {
        method,
        headers: { authorization: req.headers.authorization ?? '' },
        body: method === 'GET' ? undefined : raw.toString('utf8')
      });
      return {
        status: response.status,
        headers: { 'content-type': 'application/json' },
        body: await response.text()
      };
    }

    const library = LIBRARY_PATH.exec(url.pathname);
    if (library) {
      const [, syncVaultId, suffix] = library;
      const kind = method === 'GET' ? 'read' : 'write';
      const entry = this.auth(req, kind);
      if (!entry) return json(401, { message: 'Credencial no válida' });
      if (!this.mayReadVault(entry, syncVaultId)) return json(404, { code: 'not_found' });
      if (suffix === 'changes' && method === 'GET') {
        const page = await this.relayFor(syncVaultId).getChanges(
          syncVaultId,
          Number(url.searchParams.get('since') ?? 0),
          Number(url.searchParams.get('limit') ?? 500)
        );
        return json(200, {
          ...page,
          records: page.records.map((record) => ({
            ...record,
            envelope: record.envelope === null ? null : base64FromBytes(record.envelope)
          }))
        });
      }
      if (suffix === 'records' && method === 'POST') {
        const body = JSON.parse(raw.toString('utf8')) as {
          records: Array<{
            id: string;
            baseRev: number | null;
            deleted: boolean;
            envelope: string | null;
            objectIds: string[];
          }>;
        };
        const result = await this.relayFor(syncVaultId).postRecords(
          syncVaultId,
          body.records.map((record) => ({
            ...record,
            envelope: record.envelope === null ? null : bytesFromBase64(record.envelope)
          }))
        );
        return json(200, {
          ...result,
          records: result.records.map((record) =>
            record.status === 'conflict' && record.current
              ? {
                  ...record,
                  current: {
                    ...record.current,
                    envelope:
                      record.current.envelope === null
                        ? null
                        : base64FromBytes(record.current.envelope)
                  }
                }
              : record
          )
        });
      }
      return json(404, { code: 'not_found' });
    }

    const devices = DEVICES_PATH.exec(url.pathname);
    if (devices && method === 'POST') {
      const entry = this.auth(req, 'write');
      if (!entry) return json(401, { message: 'Credencial no válida' });
      if (!this.mayReadVault(entry, devices[1])) return json(404, { code: 'not_found' });
      this.registrations.push({ syncVaultId: devices[1], credentialId: entry.credentialId });
      return { status: 201, headers: {}, body: '' };
    }

    return json(404, { code: 'not_found' });
  }
}
