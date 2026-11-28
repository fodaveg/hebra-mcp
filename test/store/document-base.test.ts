/**
 * La regla de `src/store/document-base.ts`: un documento se proyecta, se compila, se aplica y se
 * exporta sobre el fichero BASE de la generación (`projectionBaseSha256`), nunca sobre el punto de
 * control. Este test es la regla de lint que la vigila: en `src/`, leer `.checkpointSha256` solo
 * se permite donde no se abren bytes con él (la lista de abajo, cada uno con su motivo). Quien
 * necesite los bytes que el documento enseña para la privacidad usa `exposedBytesSha256`.
 *
 * El comportamiento lo cubre `test/tools/sheet-base-projection.node.test.ts` (los síntomas y el
 * invariante MCP = app). Prueba negativa hecha a mano al escribirlo: volver a poner
 * `head.checkpointSha256 ?? head.baseSha256` en `openSessionInTurn` hace caer «nadie más lee el
 * punto de control» con ese fichero y su línea.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exposedBytesSha256, projectionBaseSha256 } from '../../src/store/document-base';
import { openDocumentRead } from '../../src/store/document-read';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { DocFormatAdapter } from '../../vendor/hebra/src/lib/documents/contract';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';
import {
  createFakeAdapter,
  fakeBase,
  type FakeModel,
  type FakeOp
} from '../../vendor/hebra/src/lib/documents/testing/fake-format';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Dónde se puede leer `.checkpointSha256`, y por qué no abre bytes con él. */
const ALLOWED: Readonly<Record<string, string>> = {
  'store/document-base.ts': 'el helper: exposedBytesSha256, solo para la privacidad',
  'store/document-checkpoint.ts': 'la huella del documento y saber si el punto de control cambió',
  'store/document-blob-cleanup.ts': 'el acuse del /h antes de borrar blobs sustituidos'
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Las líneas de código (sin comentarios) que leen el punto de control de una cabecera. */
function checkpointReads(text: string): number[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  return code
    .split('\n')
    .map((line, index) => ({ line: line.replace(/\/\/.*$/, ''), index }))
    .filter(({ line }) => /\.checkpointSha256\b/.test(line))
    .map(({ index }) => index + 1);
}

/**
 * La lectura (`openDocumentRead`) y la sesión de escritura del turno (`openSessionInTurn`) son
 * comunes a `.ods` y `.odp`: con el formato doble de Hebra en `odp` (las presentaciones aún no
 * tienen adaptador propio en el MCP), un punto de control con una marca que la base no tiene. El
 * doble proyecta solo el `Y.Doc`, así que lo que se mira son los bytes que recibe `project`: si
 * cualquiera de las dos proyecta sobre el punto de control, le llegan los de la marca.
 */
describe('lectura y sesión del turno, para cualquier formato (.odp)', () => {
  const ports: NodeLibraryPort[] = [];
  afterEach(async () => {
    for (const port of ports.splice(0)) await port.closeWhenIdle();
  });

  async function presentation() {
    const port = await openNodeLibraryPort({ sqlitePath: ':memory:' });
    ports.push(port);
    const source = port.documentSource();
    const base = await source.port.blobPut(fakeBase({ A1: 'base' }));
    const checkpoint = await source.port.blobPut(fakeBase({ A1: 'base', MARCA: 'punto de control' }));
    const file = await source.port.fileCreate(null, 'charla.odp', checkpoint.sha256);
    const head = { ...newDocumentHead('odp', 'g1', base.sha256), checkpointSha256: checkpoint.sha256 };
    await source.port.docSetHead(file.id, head, [base.sha256, checkpoint.sha256]);
    const seen: string[] = [];
    const inner = createFakeAdapter('odp');
    const adapter: DocFormatAdapter<FakeModel, FakeOp> = {
      ...inner,
      project: (bytes, doc, signal) => {
        seen.push(new TextDecoder().decode(bytes));
        return inner.project(bytes, doc, signal);
      }
    };
    return { port, source, fileId: file.id, adapter, seen, base: new TextDecoder().decode(fakeBase({ A1: 'base' })) };
  }

  it('openDocumentRead proyecta sobre la base', async () => {
    const p = await presentation();
    const read = await openDocumentRead<FakeModel, FakeOp>(p.source, p.fileId, p.adapter);
    try {
      expect(p.seen).toEqual([p.base]);
    } finally {
      await read.close();
    }
  });

  it('la sesión del turno aplica y proyecta sobre la base', async () => {
    const p = await presentation();
    const model = await p.port.writeExclusive(async (store) => {
      const session = await store.openDocumentSession<FakeModel, FakeOp>(p.fileId, p.adapter, new AbortController().signal);
      try {
        const result = await session.apply([{ kind: 'set', key: 'B1', value: 'agente' }], 'agent', { seed: 's1' });
        if (!result.ok) throw new Error('el lote no entró');
        return result.model;
      } finally {
        await session.close();
      }
    });
    expect(model?.entries).toEqual({ B1: 'agente' });
    expect(p.seen.length).toBeGreaterThan(0);
    expect(new Set(p.seen)).toEqual(new Set([p.base]));
  });
});

describe('los bytes de proyección salen de un solo sitio (document-base.ts)', () => {
  it('projectionBaseSha256 es la base de la generación, aunque haya punto de control', () => {
    const head = { baseSha256: 'a'.repeat(64), checkpointSha256: 'b'.repeat(64) };
    expect(projectionBaseSha256(head)).toBe(head.baseSha256);
    expect(exposedBytesSha256(head)).toBe(head.checkpointSha256);
    expect(exposedBytesSha256({ ...head, checkpointSha256: null })).toBe(head.baseSha256);
  });

  it('el detector ve una lectura del punto de control y no un comentario', () => {
    expect(checkpointReads('const base = await blobRead(head.checkpointSha256 ?? head.baseSha256);')).toEqual([1]);
    expect(checkpointReads('/**\n * `head.checkpointSha256` en un comentario\n */\n// head.checkpointSha256\nconst x = 1;')).toEqual([]);
  });

  it('nadie más lee el punto de control de una cabecera en src/', () => {
    const offenders = sources(SRC).flatMap((path) => {
      const name = relative(SRC, path).split('\\').join('/');
      if (name in ALLOWED) return [];
      return checkpointReads(readFileSync(path, 'utf8')).map((line) => `${name}:${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
