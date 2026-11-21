/**
 * B-N14: el punto de control desde el MCP, con el motor real, el canal de documentos montado por
 * el `SyncRunner` y el formato doble. Reloj falso (`now` inyectado): ninguna espera real.
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - cambiar `autoCheckpointDue` por `true` en `checkpointAfterBatch`: cae "20 ediciones seguidas";
 * - quitar `guardDocumentWrite` del turno de `blobPut`: cae "una nota oculta que enlaza el hash";
 * - quitar la comparación de huellas tras exportar: cae "el documento cambió mientras se exporta".
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deriveNote } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy/config';
import { SyncRunner } from '../../src/sync/runner';
import {
  setDocumentExporter,
  sessionPortOf,
  type DocumentChannelSource,
  type DocumentExporter
} from '../../src/store/document-channel';
import { checkpointAfterBatch, type CheckpointOutcome } from '../../src/store/document-checkpoint';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { InMemoryLibraryRelay } from '../hebra-testing';
import { IDENTITY, VAULT_KEY } from '../sync/devices';
import { fakeBase } from '../../vendor/hebra/src/lib/documents/testing/fake-format';

const CONFIG: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
const MINUTE = 60_000;
const encoder = new TextEncoder();
const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof bytes === 'string' ? encoder.encode(bytes) : bytes)
    .digest('hex');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setDocumentExporter(null);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface World {
  port: NodeLibraryPort;
  source: DocumentChannelSource;
  fileId: string;
  /** Reloj falso, en milisegundos. */
  clock: { now: number };
  /** Una edición del LLM: update V2 por el puerto de sesiones. */
  edit(key: string, value: string): Promise<void>;
  /** Llama a `checkpointAfterBatch` con el reloj falso y el exportador que se pase. */
  batch(exporter?: DocumentExporter | null): Promise<CheckpointOutcome>;
}

/** El estado actual del documento exportado como bytes: mismo estado, mismos bytes. */
const stateExporter: DocumentExporter = async ({ store }, fileId) => {
  const stored = await store.docRead(fileId);
  const doc = new Y.Doc();
  for (const piece of [...stored.segments, ...stored.pending]) Y.applyUpdateV2(doc, piece);
  const cells = doc.getMap<string>('fake').toJSON();
  return { bytes: encoder.encode(`export:${JSON.stringify(cells)}`), referencedBlobs: [] };
};

async function world(): Promise<World> {
  const relay = new InMemoryLibraryRelay();
  const port = await openNodeLibraryPort({ sqlitePath: ':memory:', deviceLabel: 'Claude' });
  const runner = await SyncRunner.create({
    port: port.syncStorePort(),
    transport: relay,
    blobTransport: relay,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null
  });
  cleanups.push(async () => {
    await runner.stop().catch(() => undefined);
    await port.closeWhenIdle().catch(() => undefined);
  });
  const source = port.documentSource();
  const wiring = source.wiring!;
  const base = await source.port.blobPut(fakeBase({ A1: 'base' }));
  const file = await source.port.fileCreate(null, 'cuentas.ods', base.sha256);
  await source.port.docSetHead(file.id, wiring.newHead('ods', base.sha256), [base.sha256]);

  const clock = { now: Date.UTC(2026, 10, 21, 10, 0, 0) };
  const edit = async (key: string, value: string) => {
    const stored = await source.port.docRead(file.id);
    const doc = new Y.Doc();
    for (const piece of [...stored.segments, ...stored.pending]) Y.applyUpdateV2(doc, piece);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => doc.getMap<string>('fake').set(key, value));
    await sessionPortOf(source).docAppendWith(
      file.id,
      stored.head!.generation,
      Y.encodeStateAsUpdateV2(doc, before),
      () => undefined
    );
  };
  const batch = (exporter: DocumentExporter | null = stateExporter) =>
    checkpointAfterBatch(
      {
        source,
        writeExclusive: (operation) => port.writeExclusive(operation),
        privacy: CONFIG,
        exportDocument: exporter,
        now: () => clock.now
      },
      file.id
    );
  return { port, source, fileId: file.id, clock, edit, batch };
}

async function versionsOf(w: World): Promise<number> {
  return (await w.source.port.docRead(w.fileId)).head!.versions.length;
}

async function fileShaOf(w: World): Promise<string> {
  return (await w.source.port.fileRead(w.fileId))!.sha256;
}

/** Una nota con ese cuerpo; devuelve su id. */
async function addNote(port: NodeLibraryPort, body: string): Promise<string> {
  const created = await port.noteCreate(null);
  await port.noteSave({
    ...deriveNote(body),
    id: created.id,
    body,
    expectedLocalSeq: created.localSeq,
    baseBodySha256: created.bodySha256
  });
  return created.id;
}

describe('punto de control desde el MCP (B-N14)', () => {
  it('20 ediciones seguidas crean 0 puntos de control y pasados 30 minutos, 1', async () => {
    const w = await world();
    // El primero: sin versiones, toca.
    await w.edit('B1', 'uno');
    const first = await w.batch();
    expect(first.status).toBe('created');
    expect(await versionsOf(w)).toBe(1);
    const firstSha = await fileShaOf(w);

    for (let index = 0; index < 20; index += 1) {
      w.clock.now += 10_000;
      await w.edit(`C${index}`, `v${index}`);
      expect(await w.batch()).toEqual({ status: 'not-due' });
    }
    expect(await versionsOf(w)).toBe(1);
    expect(await fileShaOf(w)).toBe(firstSha);

    w.clock.now += 30 * MINUTE;
    const second = await w.batch();
    expect(second.status).toBe('created');
    // El primero seguía sin confirmar por el relé (R6): el segundo lo sustituye en las versiones.
    expect(await versionsOf(w)).toBe(1);
    expect(await fileShaOf(w)).not.toBe(firstSha);
    expect((await w.source.port.docRead(w.fileId)).head!.checkpointSha256).toBe(await fileShaOf(w));
    // Sin más ediciones ni tiempo, otro lote no crea nada.
    expect(await w.batch()).toEqual({ status: 'not-due' });
  });

  it('sin edición nueva, pasado el plazo, no escribe: el estado exportado ya es el del fichero', async () => {
    const w = await world();
    await w.edit('B1', 'uno');
    await w.batch();
    const before = await fileShaOf(w);
    w.clock.now += 31 * MINUTE;
    expect(await w.batch()).toEqual({ status: 'unchanged', sha256: before });
    expect(await versionsOf(w)).toBe(1);
  });

  it('sin exportador registrado queda pendiente y no escribe nada', async () => {
    const w = await world();
    await w.edit('B1', 'uno');
    const fileBefore = await fileShaOf(w);
    const headBefore = (await w.source.port.docRead(w.fileId)).head;
    expect(await w.batch(null)).toEqual({ status: 'pending', reason: 'exporter-unavailable' });
    expect(await fileShaOf(w)).toBe(fileBefore);
    expect((await w.source.port.docRead(w.fileId)).head).toEqual(headBefore);
    // El lote ya aplicado sigue ahí y el siguiente, con exportador, lo recoge.
    expect((await w.batch()).status).toBe('created');
  });

  it('el exportador que lanza document-export-unavailable (el del canal sin registrar) es pendiente', async () => {
    const w = await world();
    const unavailable: DocumentExporter = async () => {
      throw new Error('document-export-unavailable');
    };
    expect(await w.batch(unavailable)).toEqual({ status: 'pending', reason: 'exporter-unavailable' });
    expect(await versionsOf(w)).toBe(0);
  });

  it('un fallo de exportación no lanza ni escribe', async () => {
    const w = await world();
    const broken: DocumentExporter = async () => {
      throw new Error('boom');
    };
    expect(await w.batch(broken)).toEqual({ status: 'failed', message: 'boom' });
    expect(await versionsOf(w)).toBe(0);
  });

  it('una nota oculta que enlaza el hash impide el punto de control: no se escribe ni el blob', async () => {
    const w = await world();
    const bytes = encoder.encode('punto oculto');
    await addNote(w.port, `# Nota\n#secreto\n![[sha256:${sha(bytes)}|x.ods]]\n`);
    const fileBefore = await fileShaOf(w);
    const headBefore = (await w.source.port.docRead(w.fileId)).head;
    const outcome = await w.batch(async () => ({ bytes, referencedBlobs: [] }));
    expect(outcome).toEqual({ status: 'hidden' });
    expect(await fileShaOf(w)).toBe(fileBefore);
    expect((await w.source.port.docRead(w.fileId)).head).toEqual(headBefore);
    expect(await w.source.port.blobRead(sha(bytes))).toBeNull();
  });

  it('una nota visible que enlaza el hash no lo impide', async () => {
    const w = await world();
    const bytes = encoder.encode('punto visible');
    await addNote(w.port, `# Nota\n![[sha256:${sha(bytes)}|x.ods]]\n`);
    const outcome = await w.batch(async () => ({ bytes, referencedBlobs: [] }));
    expect(outcome).toEqual({ status: 'created', sha256: sha(bytes) });
  });

  it('el documento cambió mientras se exporta: stale, sin escribir, y el lote siguiente lo recoge', async () => {
    const w = await world();
    await w.edit('B1', 'uno');
    const fileBefore = await fileShaOf(w);
    const racing: DocumentExporter = async (context, fileId, head) => {
      const exported = await stateExporter(context, fileId, head);
      await w.edit('B2', 'a mitad de la exportación');
      return exported;
    };
    expect(await w.batch(racing)).toEqual({ status: 'stale' });
    expect(await versionsOf(w)).toBe(0);
    expect(await fileShaOf(w)).toBe(fileBefore);
    // Sin carrera, el siguiente lote exporta el estado completo.
    const next = await w.batch();
    expect(next.status).toBe('created');
    expect(await versionsOf(w)).toBe(1);
  });
});
