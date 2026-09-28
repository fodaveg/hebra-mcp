import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LibraryError } from '../../src/hebra';
import {
  InMemoryLibraryRelay,
  IDENTITY,
  VAULT_KEY,
  allBodies,
  appCreate,
  appDevice,
  appSave,
  mcpDevice
} from './devices';
import { openNodeLibraryPort } from '../../src/store/node-port';
import { NoteWriter } from '../../src/store/writes';
import { SyncRunner } from '../../src/sync/runner';
import { NO_PRIVATE } from '../fixtures/no-private';

/**
 * L3 (SPEC.md §10): el motor de sync de Hebra sin cambios, sobre el almacén de
 * hebra-mcp, contra el relé en memoria de Hebra y frente a otro dispositivo montado
 * como lo monta Hebra (`./devices.ts`).
 */

const PLAN = '# Plan de viaje\n\nIdeas para #viajes/2026 y enlace a [[Receta de flan]].\n';

describe('SyncRunner: hebra-mcp como un dispositivo más', () => {
  it('una nota creada en hebra-mcp aparece en otro dispositivo con los mismos derivados', async () => {
    const relay = new InMemoryLibraryRelay();
    const mcp = await mcpDevice(relay);
    const app = await appDevice(relay);

    const created = await mcp.writer.createNote({ body: PLAN, privacy: NO_PRIVATE });
    expect(created.title).toBe('Plan de viaje');
    await mcp.runner.requestRound();
    await app.sync.runRound();

    const there = await app.port.noteRead(created.id);
    const here = await mcp.port.noteRead(created.id);
    expect(there?.body).toBe(PLAN);
    expect(there?.title).toBe('Plan de viaje');
    expect(there?.title).toBe(here?.title);
    expect(there?.titleNorm).toBe(here?.titleNorm);
    expect(there?.excerpt).toBe(here?.excerpt);
    const tagsThere = (await app.port.tagsList()).tags.map(({ tag, count }) => ({ tag, count }));
    const tagsHere = (await mcp.port.tagsList()).tags.map(({ tag, count }) => ({ tag, count }));
    expect(tagsThere).toEqual([
      { tag: 'viajes', count: 1 },
      { tag: 'viajes/2026', count: 1 }
    ]);
    expect(tagsHere).toEqual(tagsThere);

    const status = await mcp.runner.syncStatus();
    expect(status).toMatchObject({ lastSyncOutcome: 'ok', pendingUpload: 0, revoked: false });
    expect(status.lastSyncAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('un registro entrante de otro dispositivo es visible en HebraLibraryPort con derivados', async () => {
    const relay = new InMemoryLibraryRelay();
    const mcp = await mcpDevice(relay);
    const app = await appDevice(relay);

    const plan = await mcp.writer.createNote({ body: PLAN, privacy: NO_PRIVATE });
    await mcp.runner.requestRound();
    await app.sync.runRound();
    const receta = await appCreate(
      app,
      '# Receta de flan\n\n#cocina/postres para después de [[Plan de viaje]].\n'
    );
    await app.sync.runRound();
    await mcp.runner.requestRound();

    const note = await mcp.port.noteRead(receta);
    expect(note?.title).toBe('Receta de flan');
    const tags = (await mcp.port.tagsList()).tags.map((entry) => entry.tag);
    expect(tags).toEqual(expect.arrayContaining(['cocina', 'cocina/postres']));
    // Enlaces derivados por el motor al recibir: backlink y resolución en los dos sentidos.
    const backlinks = await mcp.port.backlinks(plan.id);
    expect(backlinks.items.map((item) => item.id)).toEqual([receta]);
    const resolved = await mcp.port.resolveLink('Receta de flan');
    expect(resolved).toMatchObject({ status: 'resolved' });
    expect((await mcp.port.search('flan', null, 10)).items.map((item) => item.id)).toContain(
      receta
    );
  });

  it('añadir mientras otro dispositivo edita la misma nota deja una copia de conflicto y no pierde texto', async () => {
    const relay = new InMemoryLibraryRelay();
    const mcp = await mcpDevice(relay);
    const app = await appDevice(relay);

    const id = await appCreate(app, '# Compartida\n\ntexto base');
    await app.sync.runRound();
    await mcp.runner.requestRound();
    expect((await mcp.port.noteRead(id))?.body).toBe('# Compartida\n\ntexto base');

    // Edición local en la app, aún sin subir, y a la vez hebra-mcp añade al final.
    await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
    const appended = await mcp.writer.appendToNote({
      id,
      text: 'AÑADIDO POR CLAUDE',
      privacy: NO_PRIVATE
    });
    expect(appended).toEqual({ id, outcome: 'saved' });
    expect((await mcp.port.noteRead(id))?.body).toBe(
      '# Compartida\n\ntexto base\n\nAÑADIDO POR CLAUDE'
    );

    // Rondas hasta converger.
    await mcp.runner.requestRound();
    await app.sync.runRound();
    await mcp.runner.requestRound();
    await app.sync.runRound();

    for (const bodies of [await allBodies(mcp.port), await allBodies(app.port)]) {
      const family = bodies.filter((note) => note.id === id || note.conflictOf === id);
      expect(family.filter((note) => note.conflictOf === id)).toHaveLength(1);
      const joined = family.map((note) => note.body).join('\n---\n');
      expect(joined).toContain('EDICIÓN DEL MAC');
      expect(joined).toContain('AÑADIDO POR CLAUDE');
    }
    // El aviso de la copia llegó por algún lado (§11), y los logs no llevan texto.
    const copies = [
      ...mcp.logged.filter((entry) => entry.event === 'sync.conflict_copy'),
      ...app.events.filter((event) => event.event === 'sync.conflict_copy')
    ];
    expect(copies.length).toBeGreaterThan(0);
    const logText = JSON.stringify(mcp.logged);
    for (const secret of ['Compartida', 'texto base', 'EDICIÓN', 'AÑADIDO']) {
      expect(logText).not.toContain(secret);
    }
  });

  it("una copia de conflicto creada por hebra-mcp lleva conflictDevice 'Claude' (L5)", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-conflict-device-'));
    try {
      const sqlitePath = join(dataDir, 'library.sqlite');
      // `deviceLabel` por defecto (sin pasarlo): 'Claude' desde L5 (`src/store/node-port.ts`).
      const port = await openNodeLibraryPort({ sqlitePath, dataDir });
      const relay = new InMemoryLibraryRelay();
      const runner = await SyncRunner.create({
        port: port.syncStorePort(),
        transport: relay,
        identity: IDENTITY,
        vaultKey: VAULT_KEY,
        intervalMs: null,
        emit: () => undefined
      });
      // Sin ronda automática en `onWritten`: el orden de las rondas de abajo decide
      // a propósito quién sube primero y a quién le toca crear la copia.
      const writer = new NoteWriter(port, { onWritten: () => undefined });
      const app = await appDevice(relay);

      const id = await appCreate(app, '# Compartida\n\ntexto base');
      await app.sync.runRound();
      await runner.requestRound();

      // Edición concurrente en los dos lados, ninguna subida todavía.
      await appSave(app, id, '# Compartida\n\ntexto base\n\nEDICIÓN DEL MAC');
      await writer.appendToNote({ id, text: 'AÑADIDO POR CLAUDE', privacy: NO_PRIVATE });

      // La app sube PRIMERO y no choca con nada; hebra-mcp sube DESPUÉS, contra un
      // servidor que ya cambió: es hebra-mcp quien crea la copia, con SU deviceLabel.
      await app.sync.runRound();
      await runner.requestRound();
      await app.sync.runRound();
      await runner.requestRound();
      port.close();

      // `conflict_device` no lo expone `NodeLibraryPort` (D2: fuera de lo que ven las
      // herramientas), así que se lee del fichero con una conexión de solo lectura aparte.
      const raw = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        const row = raw
          .prepare('SELECT conflict_device FROM notes WHERE conflict_of = ?')
          .get(id) as { conflict_device: string } | undefined;
        expect(row?.conflict_device).toBe('Claude');
      } finally {
        raw.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('appendToNote a una nota inexistente o en la papelera: note_not_found', async () => {
    const relay = new InMemoryLibraryRelay();
    const mcp = await mcpDevice(relay);
    await expect(mcp.writer.appendToNote({ id: 'no-existe', text: 'x', privacy: NO_PRIVATE })).rejects.toBeInstanceOf(
      LibraryError
    );
  });

  it('un 401 del relé deja revoked:true y no vuelve a llamar al relé', async () => {
    const relay = new InMemoryLibraryRelay();
    const mcp = await mcpDevice(relay);
    await mcp.runner.requestRound();
    relay.httpErrorNextChanges = { status: 401 };
    const round = await mcp.runner.requestRound();
    expect(round?.result).toBe('http_401');
    expect(mcp.runner.revoked).toBe(true);
    const status = await mcp.runner.syncStatus();
    expect(status).toMatchObject({ revoked: true, lastSyncOutcome: 'http_401' });

    const calls = relay.changesCalls;
    await mcp.writer.createNote({ body: '# Después de revocar', privacy: NO_PRIVATE });
    expect(await mcp.runner.requestRound()).toBeNull();
    expect(relay.changesCalls).toBe(calls);
  });

  it('un 403 por el transporte HTTP de Hebra (fetch real inyectado) también revoca', async () => {
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    const seen: string[] = [];
    const runner = await SyncRunner.create({
      port: port.syncStorePort(),
      identity: IDENTITY,
      vaultKey: VAULT_KEY,
      intervalMs: null,
      connection: async () => ({
        apiOrigin: 'https://relay.test',
        readToken: 'r-token',
        writeToken: 'w-token'
      }),
      fetcher: async (input) => {
        seen.push(String(input));
        return new Response('{"error":"revoked"}', {
          status: 403,
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    const round = await runner.requestRound();
    expect(round?.result).toBe('http_403');
    expect(runner.revoked).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/api/integrations/hebra/library/v1/vaults/');
    expect(await runner.requestRound()).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('nunca hay dos rondas solapadas; las peticiones de mientras comparten UNA ronda detrás', async () => {
    const relay = new InMemoryLibraryRelay();
    let inFlight = 0;
    let maxInFlight = 0;
    let rounds = 0;
    const slowRelay = Object.assign(Object.create(relay) as InMemoryLibraryRelay, {
      async getChanges(syncVaultId: string, since: number, limit?: number) {
        inFlight += 1;
        rounds += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await relay.getChanges(syncVaultId, since, limit);
        } finally {
          inFlight -= 1;
        }
      }
    });
    const mcp = await mcpDevice(slowRelay);
    const first = mcp.runner.requestRound();
    const second = mcp.runner.requestRound();
    const third = mcp.runner.requestRound();
    expect(second).toBe(third);
    await Promise.all([first, second, third]);
    expect(maxInFlight).toBe(1);
    // La sonda de vínculo (relé vacío) es 1 petición por ronda: dos rondas, no tres.
    expect(rounds).toBe(2);
  });

  it('whenReady espera a la ronda de arranque y nunca más del límite', async () => {
    const relay = new InMemoryLibraryRelay();
    const never = Object.assign(Object.create(relay) as InMemoryLibraryRelay, {
      getChanges: () => new Promise<never>(() => undefined)
    });
    const mcp = await mcpDevice(never);
    mcp.runner.start();
    const started = Date.now();
    await mcp.runner.whenReady(50);
    expect(Date.now() - started).toBeLessThan(1_000);

    const ok = await mcpDevice(new InMemoryLibraryRelay());
    ok.runner.start();
    await ok.runner.whenReady(5_000);
    expect((await ok.runner.syncStatus()).lastSyncOutcome).toBe('ok');
    await ok.runner.stop();
  });
});
