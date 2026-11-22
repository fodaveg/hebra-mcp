/**
 * H-BLOQUEO-SYNC: el exportador de `.ods` que registra el escritor (`createSheetDocumentExporter`,
 * `src/server/tools/sheet-export.ts`) da los MISMOS bytes que el del núcleo (`createOdsExporter`,
 * `vendor/hebra/src/lib/documents/kinds/ods/editor.ts`) para el mismo estado: segmentos,
 * pendientes y el `recent` del `/h`, sobre el fichero base. Y no devuelve bytes viejos si falta la
 * base ni exporta otro formato.
 *
 * El módulo del núcleo se importa con una ruta en variable: arrastra los tipos de `svelte`, que
 * aquí no están instalados, y tsc no lo sigue así. En vitest carga sin el componente (su
 * `import('./OdsEditorHost.svelte')` solo corre al pedir el editor).
 *
 * Prueba negativa hecha al escribirlo: sin aplicar `recent` en el exportador del MCP, cae «los
 * mismos bytes que el núcleo» en el caso con `recent` (el `.ods` no lleva esa edición).
 * H-TOPES-MCP: con `SHEET_ODS_READ_LIMITS` en el adaptador del exportador, cae «exporta un .ods
 * que se lee aunque descomprimido entero pase de los topes de lectura» (`ExportOdsError`).
 */
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { DocHeadRecord, DocStorePort } from '../../vendor/hebra/src/lib/documents/contract';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { createSheetAdapter, prepareSheetBase, type SheetOp } from '../../src/sheets';
import { createSheetDocumentExporter } from '../../src/server/tools/sheet-export';
import { SHEET_DOCUMENT_MAX_BYTES, SHEET_ODS_READ_LIMITS } from '../../src/store/sheet-limits';
import { PHOTO_ODS_MEDIA_BYTES, photoOds } from '../fixtures/photo-ods';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const FILE = 'hoja-1';
/** `A1` de la hoja `Datos` del fichero de prueba. */
const A1 = { sheet: 's0', row: 'b0', col: 'b0' };
const setA1 = (value: number | string): SheetOp => ({ type: 'cell.set', ...A1, value, replaces: [] });

type CoreExporter = (deps: {
  store: Pick<DocStorePort, 'docRead'>;
  blobRead(sha256: string): Promise<Uint8Array | null>;
}) => (fileId: string, head: DocHeadRecord) => Promise<{ bytes: Uint8Array; referencedBlobs: string[] }>;

async function coreExporter(): Promise<CoreExporter> {
  const path = '../../vendor/hebra/src/lib/documents/kinds/ods/editor';
  return ((await import(/* @vite-ignore */ path)) as { createOdsExporter: CoreExporter }).createOdsExporter;
}

/**
 * Un documento con el andamio y `A1 = 7` en un segmento; con `recent`, un `A1 = 'reciente'` más.
 * El fichero base es el del fixture del adaptador, u otro con `base`.
 */
async function state(options: { recent: boolean; base?: Uint8Array }) {
  const base = options.base ?? buildOds();
  const adapter = createSheetAdapter(await prepareSheetBase(base));
  const doc = new Y.Doc();
  adapter.scaffold(base, doc);
  doc.transact(() => adapter.applyOp(doc, setA1(7), { newId: () => 'x' }), 'agent');
  const segment = Y.encodeStateAsUpdateV2(doc);
  let recent = '';
  if (options.recent) {
    const vector = Y.encodeStateVector(doc);
    doc.transact(() => adapter.applyOp(doc, setA1('reciente'), { newId: () => 'y' }), 'agent');
    recent = Buffer.from(Y.encodeStateAsUpdateV2(doc, vector)).toString('base64');
  }
  doc.destroy();
  const head: DocHeadRecord = { ...newDocumentHead('ods', 'g1', sha(base)), recent };
  const store: Pick<DocStorePort, 'docRead'> = {
    docRead: async () => ({ head, segments: [segment], pending: [], pendingSeqs: [] })
  };
  const blobs = new Map([[sha(base), base]]);
  const blobRead = async (hash: string) => blobs.get(hash) ?? null;
  return { base, head, store, blobRead, blobs };
}

/** `A1` de unos bytes `.ods`, leídos como un fichero nuevo. */
async function a1Of(bytes: Uint8Array): Promise<unknown> {
  const adapter = createSheetAdapter(await prepareSheetBase(bytes));
  const doc = new Y.Doc();
  try {
    adapter.scaffold(bytes, doc);
    const model = await adapter.project(bytes, doc, new AbortController().signal);
    const sheet = model.sheets[0]!;
    return sheet.cells.get(`${sheet.rows.idAt(0)}:${sheet.cols.idAt(0)}`);
  } finally {
    doc.destroy();
  }
}

describe('exportador de .ods del escritor (H-BLOQUEO-SYNC)', () => {
  for (const recent of [false, true]) {
    it(`da los mismos bytes que el núcleo${recent ? ', con recent en el /h' : ''}`, async () => {
      const s = await state({ recent });
      const mine = await createSheetDocumentExporter()(
        { libraryId: 'personal', store: s.store as DocStorePort, blobRead: s.blobRead },
        FILE,
        s.head
      );
      const core = await (await coreExporter())({ store: s.store, blobRead: s.blobRead })(FILE, s.head);
      expect(sha(mine.bytes)).toBe(sha(core.bytes));
      expect(mine.referencedBlobs).toEqual(core.referencedBlobs);
      expect(await a1Of(mine.bytes)).toBe(recent ? 'reciente' : 7);
    });
  }

  it('exporta un .ods que se lee aunque descomprimido entero pase de los topes de lectura (H-TOPES-MCP)', async () => {
    const base = photoOds();
    expect(base.length).toBeLessThan(SHEET_DOCUMENT_MAX_BYTES);
    expect(PHOTO_ODS_MEDIA_BYTES).toBeGreaterThan(SHEET_ODS_READ_LIMITS.maxTotalBytes);
    const s = await state({ recent: false, base });
    const out = await createSheetDocumentExporter()(
      { libraryId: 'personal', store: s.store as DocStorePort, blobRead: s.blobRead },
      FILE,
      s.head
    );
    expect(await a1Of(out.bytes)).toBe(7);
    // La foto y el SVG siguen en el paquete, byte a byte.
    const before = unzipSync(base);
    const after = unzipSync(out.bytes);
    expect(sha(after['Pictures/foto.png']!)).toBe(sha(before['Pictures/foto.png']!));
    expect(sha(after['Pictures/b.svg']!)).toBe(sha(before['Pictures/b.svg']!));
  });

  it('sin el fichero base lanza, sin devolver bytes', async () => {
    const s = await state({ recent: false });
    s.blobs.clear();
    await expect(
      createSheetDocumentExporter()({ libraryId: 'personal', store: s.store as DocStorePort, blobRead: s.blobRead }, FILE, s.head)
    ).rejects.toThrow('blob_missing');
  });

  it('otro formato es document-export-unavailable: el punto de control queda pendiente', async () => {
    const s = await state({ recent: false });
    await expect(
      createSheetDocumentExporter()(
        { libraryId: 'personal', store: s.store as DocStorePort, blobRead: s.blobRead },
        FILE,
        { ...s.head, format: 'odp' }
      )
    ).rejects.toThrow('document-export-unavailable');
  });
});
