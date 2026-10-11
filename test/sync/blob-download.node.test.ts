/**
 * Tope de descargas de adjuntos y espera ante un 429 (`SyncRunner.readBlob`, tarea de
 * Lumbre 342a931c; SPEC.md §8, «Adjuntos»). El 5 oct 2026 mcp.hebra.pro lanzó unos 253 GET
 * de Blob V2 en paralelo y el relé respondió 429 a casi todos.
 *
 * El motor de sync es el de Hebra, sin cambios; lo que se sustituye es su transporte de
 * Blob V2: uno que cuenta las peticiones en vuelo y responde 429 cuando toca, con el mismo
 * error que da `HttpBlobRelayV2` (`BlobRelayV2Error` `rate_limited`, estado 429 y el
 * `Retry-After` ya en ms). Las esperas van con temporizadores falsos: solo `setTimeout`,
 * porque el motor descifra con WebCrypto y el almacén es `node:sqlite`, que siguen en
 * tiempo real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobRelayV2Error, type LibraryBlobTransport } from '../../src/hebra';
import { openNodeLibraryPort } from '../../src/store/node-port';
import {
  BLOB_DOWNLOAD_CONCURRENCY,
  BLOB_DOWNLOAD_RETRIES,
  SyncRunner
} from '../../src/sync/runner';
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY, appCreate, appDevice } from './devices';

type Outcome = 'ok' | 'missing' | 'error' | 'revoked';

interface FakeBlobs {
  transport: LibraryBlobTransport;
  /** Peticiones `getObject` hechas. */
  calls: number;
  /** Máximo de peticiones simultáneas visto. */
  maxActive: number;
}

/**
 * Transporte de Blob V2 de prueba sobre el relé en memoria. `respond(n)` decide la
 * petición `n` (desde 0): `undefined` la pasa al relé; un número o `null`, un 429 con ese
 * `Retry-After` en ms (o sin él). `hold` la deja en vuelo hasta que se resuelve.
 */
function fakeBlobs(
  relay: InMemoryLibraryRelay,
  respond: (call: number) => number | null | undefined = () => undefined,
  hold: () => Promise<void> = () => Promise.resolve()
): FakeBlobs {
  let active = 0;
  const fake: FakeBlobs = {
    calls: 0,
    maxActive: 0,
    transport: {
      putObject: (input) => relay.putObject(input),
      async getObject(key) {
        const call = fake.calls;
        fake.calls += 1;
        active += 1;
        fake.maxActive = Math.max(fake.maxActive, active);
        try {
          await hold();
          const limited = respond(call);
          if (limited !== undefined) {
            throw new BlobRelayV2Error('rate_limited', true, limited ?? undefined, 429);
          }
          return await relay.getObject(key);
        } finally {
          active -= 1;
        }
      }
    }
  };
  return fake;
}

async function runnerWith(relay: InMemoryLibraryRelay, blobs: FakeBlobs, outcomes: Outcome[] = []) {
  const port = await openNodeLibraryPort({ sqlitePath: ':memory:', deviceLabel: 'Claude' });
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    blobTransport: blobs.transport,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null,
    emitAttachment: (outcome) => outcomes.push(outcome)
  });
  return { port, runner };
}

/** Un adjunto que otra app de Hebra subió al relé, con su nota. */
async function uploadedBlob(relay: InMemoryLibraryRelay, text: string): Promise<string> {
  const app = await appDevice(relay, 'Mac', { blobs: true });
  const { sha256 } = await app.port.blobPut(new TextEncoder().encode(text), { mime: 'text/plain' });
  await appCreate(app, `# Con adjunto\n\n![[sha256:${sha256}|nota.txt]]\n`);
  expect((await app.sync.runRound()).result).toBe('ok');
  return sha256;
}

/** Deja correr lo que espera a E/S real (WebCrypto, SQLite) hasta que `done` se cumpla. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

/** Unas vueltas de E/S real sin esperar nada concreto: para comprobar que algo NO pasa. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('SyncRunner.readBlob: tope de descargas y espera ante 429', () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
  });

  it(`20 descargas lanzadas a la vez: como mucho ${BLOB_DOWNLOAD_CONCURRENCY} en vuelo`, async () => {
    const relay = new InMemoryLibraryRelay();
    // Cada petición tarda un poco (tiempo real): las de la cola tienen que coincidir con
    // las que están en vuelo si nadie las frena.
    const blobs = fakeBlobs(relay, () => undefined, () => new Promise((resolve) => setTimeout(resolve, 5)));
    const outcomes: Outcome[] = [];
    const { port, runner } = await runnerWith(relay, blobs, outcomes);
    closers.push(() => port.close());

    const shas = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    const results = await Promise.all(shas.map((sha) => runner.readBlob(sha)));

    expect(results).toEqual(shas.map(() => false));
    expect(outcomes).toEqual(shas.map(() => 'missing'));
    expect(blobs.calls).toBe(20);
    expect(blobs.maxActive).toBeLessThanOrEqual(BLOB_DOWNLOAD_CONCURRENCY);
    expect(blobs.maxActive).toBe(BLOB_DOWNLOAD_CONCURRENCY);
  });

  it('un 429 sin Retry-After se reintenta a los 2 s y a los 4 s, y acaba bajando el adjunto', async () => {
    const relay = new InMemoryLibraryRelay();
    const sha = await uploadedBlob(relay, 'contenido del adjunto');
    const blobs = fakeBlobs(relay, (call) => (call < 2 ? null : undefined));
    const outcomes: Outcome[] = [];
    const { port, runner } = await runnerWith(relay, blobs, outcomes);
    closers.push(() => port.close());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let result: boolean | undefined;
    void runner.readBlob(sha).then((value) => (result = value));
    await until(() => blobs.calls === 1);

    await vi.advanceTimersByTimeAsync(1_999);
    await settle();
    expect(blobs.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => blobs.calls === 2);

    await vi.advanceTimersByTimeAsync(3_999);
    await settle();
    expect(blobs.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => result !== undefined);

    expect(result).toBe(true);
    expect(blobs.calls).toBe(3);
    expect(outcomes).toEqual(['ok']);
    expect(new TextDecoder().decode((await port.blobRead(sha))!)).toBe('contenido del adjunto');
  });

  it('con Retry-After espera lo que pide el relé, con tope de 30 s', async () => {
    const relay = new InMemoryLibraryRelay();
    const sha = await uploadedBlob(relay, 'otro adjunto');
    // 5 s pedidos; después 2 min, que se quedan en 30 s.
    const blobs = fakeBlobs(relay, (call) => (call === 0 ? 5_000 : call === 1 ? 120_000 : undefined));
    const { port, runner } = await runnerWith(relay, blobs);
    closers.push(() => port.close());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let result: boolean | undefined;
    void runner.readBlob(sha).then((value) => (result = value));
    await until(() => blobs.calls === 1);
    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(blobs.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => blobs.calls === 2);

    await vi.advanceTimersByTimeAsync(29_999);
    await settle();
    expect(blobs.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => result !== undefined);
    expect(result).toBe(true);
  });

  it(`tras ${BLOB_DOWNLOAD_RETRIES} reintentos con 429, el error de siempre`, async () => {
    const relay = new InMemoryLibraryRelay();
    const sha = await uploadedBlob(relay, 'nunca baja');
    const blobs = fakeBlobs(relay, () => null);
    const outcomes: Outcome[] = [];
    const { port, runner } = await runnerWith(relay, blobs, outcomes);
    closers.push(() => port.close());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let result: boolean | undefined;
    void runner.readBlob(sha).then((value) => (result = value));
    for (const [index, wait] of [2_000, 4_000, 8_000].entries()) {
      await until(() => blobs.calls === index + 1);
      await vi.advanceTimersByTimeAsync(wait);
    }
    await until(() => result !== undefined);

    expect(result).toBe(false);
    expect(blobs.calls).toBe(1 + BLOB_DOWNLOAD_RETRIES);
    expect(outcomes).toEqual(['error']);
    // Y no queda ninguna espera pendiente: no hay un quinto intento.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(blobs.calls).toBe(1 + BLOB_DOWNLOAD_RETRIES);
    expect(await port.blobRead(sha)).toBeNull();
  });

  it('la que espera tras un 429 conserva su plaza: la cola no pasa por el relé mientras tanto', async () => {
    const relay = new InMemoryLibraryRelay();
    const sha = await uploadedBlob(relay, 'compartido');
    // Las cuatro primeras peticiones reciben 429; las siguientes pasan.
    const blobs = fakeBlobs(relay, (call) => (call < BLOB_DOWNLOAD_CONCURRENCY ? null : undefined));
    const { port, runner } = await runnerWith(relay, blobs);
    closers.push(() => port.close());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const results: boolean[] = [];
    const total = BLOB_DOWNLOAD_CONCURRENCY + 2;
    for (let i = 0; i < total; i += 1) void runner.readBlob(sha).then((value) => results.push(value));
    await until(() => blobs.calls === BLOB_DOWNLOAD_CONCURRENCY);
    await vi.advanceTimersByTimeAsync(1_999);
    await settle();
    // Las dos de la cola siguen esperando turno: nadie más pidió nada al relé.
    expect(blobs.calls).toBe(BLOB_DOWNLOAD_CONCURRENCY);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => results.length === total);
    expect(results).toEqual(Array.from({ length: total }, () => true));
    expect(blobs.maxActive).toBeLessThanOrEqual(BLOB_DOWNLOAD_CONCURRENCY);
  });
});
