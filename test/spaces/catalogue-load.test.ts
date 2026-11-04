/**
 * El gasto de peticiones al relé por el catálogo no depende de lo que mande un cuerpo ni de
 * cuántas herramientas corran a la vez (D22, SPEC.md §12.10): un cuerpo hostil no agota el
 * cupo por IP de Lumbre, que comparten todas las cuentas.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_PREPARED_SPACES, requestedSpaces } from '../../src/http/app';
import { AgentSpaceManager } from '../../src/spaces/manager';
import { deferred } from '../fixtures/deferred';

const call = (space: unknown) => ({
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'hebra_read_note', arguments: { space } }
});

describe('requestedSpaces', () => {
  it('un lote con decenas de miles de espacios inventados abre como mucho unos pocos', () => {
    const body = Array.from({ length: 40_000 }, () => call(randomUUID()));
    expect(requestedSpaces(body)).toHaveLength(MAX_PREPARED_SPACES);
  });

  it('solo UUID canónicos, sin repetir; personal y basura no cuentan', () => {
    const id = randomUUID();
    const body = [
      call(id), call(id), call('personal'), call('PERSONAL'), call(id.toUpperCase()),
      call('no-es-uuid'), call(42), call({}), call(null), null, 7, 'texto',
      { method: 'tools/list' }
    ];
    expect(requestedSpaces(body)).toEqual([id]);
  });
});

function managerWith(requests: { count: number; gate?: Promise<void> }, now: () => number = () => 0) {
  const device = {
    paired: { connection: { apiOrigin: 'https://relay.test' } },
    ensureRegistered: async () => ({ accountId: 'a', credentialId: 'c', deviceId: 'd', keyId: 'k' }),
    request: async () => {
      requests.count += 1;
      await requests.gate;
      return { spaces: [] };
    }
  };
  return new AgentSpaceManager(device as never, '/nunca', undefined, null, undefined, undefined, now);
}

describe('catálogo del relé', () => {
  it('un lote de espacios lee el catálogo una vez', async () => {
    const requests = { count: 0 };
    const manager = managerWith(requests);
    const ids = Array.from({ length: MAX_PREPARED_SPACES }, () => randomUUID());
    expect(await manager.lifecycle.prepare(ids)).toEqual([]);
    expect(requests.count).toBe(1);
  });

  it('si el cliente ya se fue (shouldStop), el lote no lee nada', async () => {
    const requests = { count: 0 };
    const manager = managerWith(requests);
    expect(await manager.lifecycle.prepare([randomUUID(), randomUUID()], () => true)).toEqual([]);
    expect(requests.count).toBe(0);
  });

  it('herramientas concurrentes comparten lecturas: una en vuelo y una siguiente', async () => {
    const gate = deferred();
    const requests = { count: 0, gate: gate.promise };
    const manager = managerWith(requests);
    const many = Array.from({ length: 50 }, () => manager.lifecycle.prepare([randomUUID()]));
    await Promise.resolve();
    gate.resolve();
    await Promise.all(many);
    // Quien llegó con una lectura en curso espera a una posterior (nunca una anterior a su
    // petición), y todos esos comparten la misma.
    expect(requests.count).toBe(2);
  });

  it('dos consultas seguidas de la misma invocación siguen siendo dos lecturas', async () => {
    const requests = { count: 0 };
    const manager = managerWith(requests);
    await manager.lifecycle.prepare([randomUUID()]);
    await manager.lifecycle.prepare([randomUUID()]);
    expect(requests.count).toBe(2);
  });

  it('la ventana del sync reutiliza la última lectura y caduca con el reloj', async () => {
    const requests = { count: 0 };
    let clock = 1000;
    const manager = managerWith(requests, () => clock) as unknown as {
      catalogue(maxAgeMs?: number): Promise<unknown[]>;
    };
    await manager.catalogue(2000);
    clock += 1999;
    await manager.catalogue(2000);
    expect(requests.count).toBe(1);
    clock += 1;
    await manager.catalogue(2000);
    expect(requests.count).toBe(2);
    // Sin ventana (herramientas, writer.sock) nunca reutiliza una lectura terminada.
    await manager.catalogue();
    expect(requests.count).toBe(3);
  });

  it('un fallo no se guarda: la siguiente consulta vuelve a leer', async () => {
    let fail = true;
    const requests = { count: 0 };
    const device = {
      paired: { connection: { apiOrigin: 'https://relay.test' } },
      ensureRegistered: async () => ({ accountId: 'a', credentialId: 'c', deviceId: 'd', keyId: 'k' }),
      request: async () => {
        requests.count += 1;
        if (fail) throw new Error('relé caído');
        return { spaces: [] };
      }
    };
    const manager = new AgentSpaceManager(device as never, '/nunca') as unknown as {
      catalogue(maxAgeMs?: number): Promise<unknown[]>;
    };
    await expect(manager.catalogue(2000)).rejects.toThrow();
    fail = false;
    await expect(manager.catalogue(2000)).resolves.toEqual([]);
    expect(requests.count).toBe(2);
  });
});
