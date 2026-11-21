/**
 * Limpieza de blobs sustituidos (B-N21, R29). El punto de control es el REAL de Hebra
 * (`takeCheckpoint`) sobre un almacén de documentos de mentira y un `FsBlobStore` de verdad en un
 * directorio temporal; el acuse del relé es soltar la retención, como hace el canal con el `/h`.
 *
 * Este paquete BORRA datos, así que cada condición de borrado tiene su test en negativo. Cada una
 * se vio fallar al quitar su comprobación de `document-blob-cleanup.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocHeadRecord } from '../../vendor/hebra/src/lib/documents/contract';
import { takeCheckpoint } from '../../vendor/hebra/src/lib/documents/sync/checkpoint';
import { defaultDocPins } from '../../vendor/hebra/src/lib/documents/sync/doc-channel';
import { blobStorePath, FsBlobStore } from '../../src/store/blob-store-fs';
import {
  FsSupersededJournal,
  removeSupersededBlobs,
  type CleanupDeps,
  type RemovableBlobStore
} from '../../src/store/document-blob-cleanup';
import type { PrivacyConfig } from '../../src/privacy/config';
import type { NoteWriteStore } from '../../src/store/writes';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const FILE = 'file-1';
const encoder = new TextEncoder();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const PRIVACY = {} as PrivacyConfig;

interface World {
  root: string;
  blobs: FsBlobStore;
  /** Un punto de control con ese contenido; devuelve su hash. */
  point(content: string): Promise<string>;
  /** El relé confirma el `/h` actual. */
  ack(): Promise<void>;
  /** Una pasada de limpieza. */
  clean(overrides?: Partial<CleanupDeps>): ReturnType<typeof removeSupersededBlobs>;
  head(): DocHeadRecord;
  baseSha: string;
  /** Ficheros y notas vivas que usan un hash. */
  liveFiles: Set<string>;
  liveNotes: Set<string>;
  /** Hashes fijados por otros documentos. */
  others: Set<string>;
  onDisk(): Promise<string[]>;
}

/** Todos los blobs que hay en disco bajo `<raíz>/blobs`. */
async function listBlobs(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else found.push(entry.name);
    }
  };
  await walk(join(root, 'blobs'));
  return found.sort();
}

async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'hebra-mcp-cleanup-'));
  dirs.push(root);
  const blobs = new FsBlobStore(root);
  const journal = new FsSupersededJournal(root);
  const baseSha = sha('base');
  await blobs.write(baseSha, encoder.encode('base'));

  let head: DocHeadRecord = {
    v: 1,
    format: 'ods',
    generation: 'g1',
    baseSha256: baseSha,
    checkpointSha256: null,
    segments: 0,
    recent: '',
    versions: []
  };
  let fileSha = baseSha;
  let held: string | null = null;
  let clock = 1_000_000;
  const liveFiles = new Set<string>();
  const liveNotes = new Set<string>();
  const others = new Set<string>();
  const retention = {
    async holdFiles(_id: string, hash: string) {
      held = hash;
    },
    async releaseFiles() {
      held = null;
    },
    isHeld: (_id: string, hash: string) => held === hash
  };
  const store = {
    filesIndex: () => ({ files: [{ sha256: fileSha }, ...[...liveFiles].map((hash) => ({ sha256: hash }))] }),
    notesLinkingBlob: (hash: string) => (liveNotes.has(hash) ? [{ noteId: 'n1' }] : [])
  } as unknown as NoteWriteStore;

  const deps: CleanupDeps = {
    blobs,
    journal,
    docRead: async () => ({ head }),
    isHeld: retention.isHeld,
    otherPins: () => others
  };
  return {
    root,
    blobs,
    baseSha,
    liveFiles,
    liveNotes,
    others,
    head: () => head,
    onDisk: () => listBlobs(root),
    async point(content) {
      clock += 31 * 60 * 1000;
      await takeCheckpoint(
        {
          store: {
            docRead: async () => ({ head, segments: [], pending: [], pendingSeqs: [] }),
            docSetHead: async (_id: string, next: DocHeadRecord) => {
              head = next;
            },
            // H-ALMACEN-REVISION de Hebra: el punto de control escribe solo sobre la generación
            // que exportó. Aquí nadie más escribe, así que coincide siempre.
            docSetHeadIfGeneration: async (_id: string, expected: string, next: DocHeadRecord) => {
              if (head.generation !== expected) return { written: false, head };
              head = next;
              return { written: true, head };
            }
          } as never,
          library: {
            blobPut: async (bytes: Uint8Array) => {
              const hash = createHash('sha256').update(bytes).digest('hex');
              await blobs.write(hash, bytes);
              return { sha256: hash, byteLength: bytes.length, alreadyPresent: false };
            },
            fileRead: async () => ({ id: FILE, sha256: fileSha }) as never,
            fileReplace: async (_id: string, hash: string) => {
              fileSha = hash;
              return { id: FILE, sha256: hash } as never;
            }
          },
          retention,
          exportDocument: async () => ({ bytes: encoder.encode(content), referencedBlobs: [] }),
          notifyLocalChange: () => undefined,
          now: () => clock
        },
        FILE,
        'auto'
      );
      return sha(content);
    },
    ack: () => retention.releaseFiles(),
    clean: (overrides = {}) => removeSupersededBlobs({ store, privacy: PRIVACY }, FILE, { ...deps, ...overrides })
  };
}

/** Una pasada con el diario ya sembrado con los hashes del `/h` actual (como hace el cableado). */
async function seed(w: World): Promise<void> {
  await w.clean();
}

describe('limpieza de blobs sustituidos (B-N21)', () => {
  it('R29: 20 puntos sin acuse no borran nada y, con el acuse, quedan solo los fijados por el /h', async () => {
    const w = await world();
    await seed(w);
    for (let index = 0; index < 20; index += 1) {
      await w.point(`punto ${index}`);
      expect(await w.clean()).toMatchObject({ removed: 0 });
    }
    // Sin acuse: la base y los 20 puntos siguen en disco.
    expect((await w.onDisk()).length).toBe(21);

    await w.ack();
    const result = await w.clean();
    expect(result.removed).toBe(19);
    expect(await w.onDisk()).toEqual([...defaultDocPins(w.head())].sort());
    expect(await w.onDisk()).toEqual([sha('base'), sha('punto 19')].sort());
  });

  it('R29: con el acuse tras cada punto se retienen todas las versiones y no se borra nada', async () => {
    const w = await world();
    await seed(w);
    for (let index = 0; index < 20; index += 1) {
      await w.point(`punto ${index}`);
      await w.ack();
      expect(await w.clean()).toEqual({ removed: 0, kept: 0 });
    }
    expect(w.head().versions).toHaveLength(20);
    expect(await w.onDisk()).toEqual([...defaultDocPins(w.head())].sort());
  });

  it('R29: con un acuse cada cuatro puntos, en disco queda justo lo que fija el /h', async () => {
    const w = await world();
    await seed(w);
    for (let index = 0; index < 20; index += 1) {
      await w.point(`punto ${index}`);
      if (index % 4 === 3) await w.ack();
      await w.clean();
    }
    await w.ack();
    await w.clean();
    const pins = [...defaultDocPins(w.head())].sort();
    expect(await w.onDisk()).toEqual(pins);
    // El último de cada grupo de cuatro se confirmó y se conserva como versión.
    expect(w.head().versions.map((version) => version.sha256).sort()).toEqual(
      [3, 7, 11, 15, 19].map((index) => sha(`punto ${index}`)).sort()
    );
  });

  it('R29, rotura: un punto sin confirmar sustituido sigue en disco hasta el acuse del /h nuevo', async () => {
    const w = await world();
    await seed(w);
    const first = await w.point('uno');
    await w.ack();
    await w.clean();
    const second = await w.point('dos');
    await w.clean();
    // `dos` aún no tiene acuse y lo sustituye `tres`: sale del /h pero no se puede borrar todavía.
    await w.point('tres');
    expect(w.head().versions.map((version) => version.sha256)).not.toContain(second);
    expect(await w.clean()).toMatchObject({ removed: 0, kept: 1 });
    expect(await w.onDisk()).toContain(second);
    expect(await w.onDisk()).toContain(first);
    await w.ack();
    expect(await w.clean()).toEqual({ removed: 1, kept: 0 });
    expect(await w.onDisk()).not.toContain(second);
    expect(await w.onDisk()).toContain(first);
  });

  /** Un candidato claro: `dos` sustituido por `tres`, con el acuse puesto. */
  async function withSupersededBlob() {
    const w = await world();
    await seed(w);
    await w.point('uno');
    await w.ack();
    await w.clean();
    const second = await w.point('dos');
    await w.clean();
    await w.point('tres');
    await w.clean();
    await w.ack();
    return { w, second };
  }

  it('sin ninguna referencia, el sustituido se borra', async () => {
    const { w, second } = await withSupersededBlob();
    expect(await w.clean()).toEqual({ removed: 1, kept: 0 });
    expect(await w.onDisk()).not.toContain(second);
  });

  it('un fichero vivo que usa el blob lo conserva', async () => {
    const { w, second } = await withSupersededBlob();
    w.liveFiles.add(second);
    expect(await w.clean()).toMatchObject({ removed: 0 });
    expect(await w.onDisk()).toContain(second);
  });

  it('una nota viva que lo enlaza lo conserva', async () => {
    const { w, second } = await withSupersededBlob();
    w.liveNotes.add(second);
    expect(await w.clean()).toMatchObject({ removed: 0 });
    expect(await w.onDisk()).toContain(second);
  });

  it('una versión anterior retenida por el /h lo conserva', async () => {
    const w = await world();
    await seed(w);
    const first = await w.point('uno');
    await w.ack();
    await w.point('dos');
    await w.ack();
    // Aunque el diario lo tuviera anotado, `uno` sigue en `versions`.
    await new FsSupersededJournal(w.root).save(FILE, { pins: [], pending: [first] });
    expect(w.head().versions.map((version) => version.sha256)).toContain(first);
    expect(await w.clean()).toMatchObject({ removed: 0 });
    expect(await w.onDisk()).toContain(first);
  });

  it('un documento de otro espacio que fija el mismo contenido lo conserva', async () => {
    const { w, second } = await withSupersededBlob();
    w.others.add(second);
    expect(await w.clean()).toMatchObject({ removed: 0 });
    expect(await w.onDisk()).toContain(second);
  });

  it('un fallo al borrar no rompe la pasada y se reintenta en la siguiente', async () => {
    const { w, second } = await withSupersededBlob();
    const failing: RemovableBlobStore = {
      remove: async () => {
        throw new Error('EBUSY');
      }
    };
    expect(await w.clean({ blobs: failing })).toEqual({ removed: 0, kept: 1 });
    expect(await w.onDisk()).toContain(second);
    expect(await w.clean()).toEqual({ removed: 1, kept: 0 });
    expect(await w.onDisk()).not.toContain(second);
  });

  it('un corte entre el acuse y el borrado no pierde el candidato: lo recoge otro proceso', async () => {
    const { w, second } = await withSupersededBlob();
    // Primera pasada: el proceso muere al borrar (el diario ya está escrito, el blob sigue).
    await w.clean({
      blobs: {
        remove: async () => {
          throw new Error('proceso cortado');
        }
      }
    });
    const saved = JSON.parse(
      await readFile(join(w.root, 'superseded', `${sha(FILE)}.json`), 'utf8')
    ) as { pending: string[] };
    expect(saved.pending).toEqual([second]);
    // Otro proceso, con un diario nuevo sobre el mismo directorio, termina el trabajo.
    expect(await w.clean({ journal: new FsSupersededJournal(w.root) })).toEqual({ removed: 1, kept: 0 });
    expect(await w.onDisk()).not.toContain(second);
  });

  it('un hash mal formado del diario no llega a ninguna ruta', async () => {
    const { w } = await withSupersededBlob();
    const outside = join(w.root, 'fuera.txt');
    await writeFile(outside, 'no me toques');
    const removed: string[] = [];
    await mkdir(join(w.root, 'superseded'), { recursive: true });
    await new FsSupersededJournal(w.root).save(FILE, {
      pins: [],
      pending: ['../../fuera.txt', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64).replace(/A/g, 'g')]
    });
    await w.clean({
      blobs: {
        remove: async (hash) => {
          removed.push(hash);
        }
      }
    });
    expect(removed.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(removed).not.toContain('../../fuera.txt');
    expect((await stat(outside)).isFile()).toBe(true);
  });
});

describe('FsBlobStore.remove (B-N21)', () => {
  it('borra los bytes de un hash y no falla si ya no están', async () => {
    const w = await world();
    const hash = sha('x');
    await w.blobs.write(hash, encoder.encode('x'));
    await w.blobs.remove(hash);
    expect(await w.blobs.read(hash)).toBeNull();
    await expect(w.blobs.remove(hash)).resolves.toBeUndefined();
  });

  it('rechaza un `../` o una longitud incorrecta sin tocar el disco', async () => {
    const w = await world();
    const outside = join(w.root, 'fuera.txt');
    await writeFile(outside, 'no me toques');
    for (const bad of ['../../fuera.txt', `${'a'.repeat(62)}/.`, 'a'.repeat(63), 'a'.repeat(65), '', 'A'.repeat(64)]) {
      await expect(w.blobs.remove(bad)).rejects.toThrow('invalid_blob_hash');
    }
    expect(await readFile(outside, 'utf8')).toBe('no me toques');
    const kept = blobStorePath(w.root, w.baseSha);
    expect((await stat(kept)).isFile()).toBe(true);
  });
});
