/**
 * El MCP proyecta, compila y aplica un `.ods` sobre el fichero BASE de la generación
 * (`head.baseSha256`), como la app (`vendor/hebra/src/lib/documents/kinds/ods/editor.ts`), y no
 * sobre el punto de control (`head.checkpointSha256`), que ya lleva el `Y.Doc` dentro.
 *
 * Motor real: `NodeLibraryPort` en SQLite con el canal de documentos cableado
 * (`wireDocuments`), el formato de hojas de producción (`createSheetDocumentFormat`) y su
 * exportador (`createSheetDocumentExporter`), el motor de fórmulas en su hilo (empaquetado con
 * esbuild, como en `edit-sheet.node.test.ts`), `hebra_edit_sheet` (`runEditSheet`),
 * `hebra_create_sheet` (`runCreateSheet`) y duplicar como lo hace el escritor
 * (`prepareDocumentCopy` y `writeLooseFile`, `looseFileWriteLocal` de `library-instance.ts`).
 * El primer lote sobre un documento sin versiones ya crea un punto de control (el automático,
 * `autoCheckpointDue`); los demás, en la secuencia, con `ensureCheckpoint` del cableado.
 *
 * Parte 1: un test por síntoma visto en producción. Parte 2: el invariante que cierra la clase,
 * sobre secuencias fijas y generadas con semilla fija: tras cada paso, lo que proyecta el MCP es
 * idéntico (ids incluidos) a lo que proyecta la app (base + `Y.Doc` + `recent`), el `.ods`
 * exportado se relee igual, y los nombres de las hojas y los valores escritos son los que pide la
 * secuencia (un oráculo propio, para que «el MCP y la réplica de la app se equivocan igual» no
 * pase por bueno).
 *
 * Pruebas negativas hechas a mano al escribirlo (se rompe, el test cae, se restaura):
 * - `projectionBaseSha256` devuelve `head.checkpointSha256 ?? head.baseSha256` (el código de
 *   antes): caen los cuatro síntomas, las dos secuencias fijas, las semillas 1 a 5 y la de
 *   `hebra_create_sheet` (la semilla 6 sigue verde: su secuencia no llega a separar base y punto
 *   de control, por eso hay varias);
 * - solo `openSessionInTurn` vuelve al punto de control: aquí no cae nada, porque el adaptador de
 *   hojas aplica con el libro de su lectura (`batchAdapter` sobre `openSheetRead`); lo ven la regla
 *   de `test/store/document-base.test.ts` y su prueba de la sesión del turno con `.odp`;
 * - el oráculo con una hoja de más: caen las ocho secuencias (el oráculo mira de verdad).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PrivacyConfig } from '../../src/privacy/config';
import { PrivacyFilter } from '../../src/privacy/filter';
import type { ToolContext } from '../../src/server/context';
import { ToolError } from '../../src/server/errors';
import { DEFAULT_SHEET_NAME, runCreateSheet, type CreateSheetWriter } from '../../src/server/tools/create-sheet';
import { createSheetDocumentFormat, runEditSheet, type EditSheetWriter, type SheetEditOp } from '../../src/server/tools/edit-sheet';
import { createSheetDocumentExporter } from '../../src/server/tools/sheet-export';
import { openSheetRead } from '../../src/server/tools/sheet-read';
import {
  createNodeFormulaEngine,
  createSheetAdapter,
  prepareSheetBase,
  type CellValue,
  type SheetCommand,
  type SheetModel
} from '../../src/sheets';
import { UnlinkedStatusSource } from '../../src/status/status-source';
import { setDocumentExporter, wireDocuments } from '../../src/store/document-channel';
import { prepareDocumentCopy, registerDocumentFormat, runDocumentRequest } from '../../src/store/document-service';
import { DOCUMENT_OPS_VERSION } from '../../src/store/document-types';
import { writeLooseFile } from '../../src/store/file-verbs';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import { SHEET_ODS_READ_LIMITS } from '../../src/store/sheet-limits';
import type { DocumentSyncWiring } from '../../vendor/hebra/src/lib/documents/sync/wiring';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG: PrivacyConfig = { privateFolders: [], privateTags: [] };
const live = new AbortController().signal;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const directories: string[] = [];
const ports: NodeLibraryPort[] = [];
let engineUrl: URL;
const engine = () => createNodeFormulaEngine({ workerUrl: engineUrl });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-base-projection-engine-'));
  directories.push(dir);
  const outfile = join(dir, 'sheet-engine-worker.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'sheet-engine-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile,
    tsconfig: join(ROOT, 'tsconfig.json'),
    logLevel: 'silent'
  });
  engineUrl = pathToFileURL(outfile);
  registerDocumentFormat<SheetModel, SheetEditOp>('ods', createSheetDocumentFormat({ engineWorkerUrl: engineUrl }));
  setDocumentExporter(createSheetDocumentExporter({ engine }));
});

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
});

afterAll(() => {
  registerDocumentFormat('ods', null);
  setDocumentExporter(null);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// El libro de partida: hojas del FICHERO (ids `s0`, `s1`… por posición), cada una con su nombre
// en A1 y un número en B1.

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3"';
const enc = (text: string) => new TextEncoder().encode(text);
const MTIME = Date.UTC(2020, 0, 1);
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

function bookOds(names: readonly string[]): Uint8Array {
  const table = (name: string, index: number) =>
    `<table:table table:name="${name}"><table:table-column table:number-columns-repeated="3"/>` +
    '<table:table-row>' +
    `<table:table-cell office:value-type="string"><text:p>${name}</text:p></table:table-cell>` +
    `<table:table-cell office:value-type="float" office:value="${index + 1}"><text:p>${index + 1}</text:p></table:table-cell>` +
    '<table:table-cell/></table:table-row>' +
    '<table:table-row table:number-rows-repeated="5"><table:table-cell table:number-columns-repeated="3"/></table:table-row>' +
    '</table:table>';
  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><office:body><office:spreadsheet>` +
    names.map(table).join('') +
    '</office:spreadsheet></office:body></office:document-content>';
  const styles = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}><office:styles/></office:document-styles>`;
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
    `<manifest:file-entry manifest:full-path="/" manifest:media-type="${ODS_MIME}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';
  return zipSync({
    mimetype: [enc(ODS_MIME), { level: 0, mtime: MTIME }],
    'content.xml': [enc(content), { level: 9, mtime: MTIME }],
    'styles.xml': [enc(styles), { level: 9, mtime: MTIME }],
    'META-INF/manifest.xml': [enc(manifest), { level: 9, mtime: MTIME }]
  });
}

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril'] as const;

// ---------------------------------------------------------------------------------------------
// El mundo: una biblioteca con el canal cableado y las herramientas reales.

interface World {
  port: NodeLibraryPort;
  wiring: DocumentSyncWiring;
  ctx: ToolContext;
  folderId: string;
}

async function world(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-base-projection-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), dataDir: directory });
  ports.push(port);
  const source = port.documentSource();
  const wiring = wireDocuments(source, {
    requestRound: async () => undefined,
    readBlob: (sha256) => source.port.blobRead(sha256)
  });
  const folderId = await port.writeExclusive(async (store) => (await store.folderCreate('root', 'Hojas')).id);
  const privacy = await (await PrivacyFilter.build(port, CONFIG)).ensureAll();
  const ctx: ToolContext = { port, privacy, privacyConfig: CONFIG, status: new UnlinkedStatusSource() };
  return { port, wiring, ctx, folderId };
}

/** Sube `bytes` como un `.ods` sin cabecera (nunca abierto en el editor). */
async function upload(w: World, name: string, bytes: Uint8Array): Promise<string> {
  return w.port.writeExclusive(async (store) => {
    await store.blobPut(bytes, { mime: ODS_MIME, expectedSha256: sha(bytes) });
    return (await store.fileCreate(w.folderId, name, sha(bytes))).id;
  });
}

const capacity = { key: 'cuenta', gate: { admit: async () => ({ done: () => undefined }) } };

function editWriter(w: World): EditSheetWriter {
  return async (request) => {
    const outcome = await runDocumentRequest(
      { port: w.port, writeExclusive: (operation) => w.port.writeExclusive(operation) },
      { opsVersion: DOCUMENT_OPS_VERSION, ...request },
      { afterCommit: async () => ({ sync: 'not_linked' }) }
    );
    if ('created' in outcome) throw new Error('documentOps devolvió una creación');
    return outcome;
  };
}

function createWriter(w: World): CreateSheetWriter {
  return async (request) => {
    const outcome = await runDocumentRequest(
      { port: w.port, writeExclusive: (operation) => w.port.writeExclusive(operation) },
      { action: 'create', opsVersion: DOCUMENT_OPS_VERSION, ...request },
      { afterCommit: async () => ({ sync: 'not_linked' }) }
    );
    if ('created' in outcome) return { ok: true, created: outcome.created };
    if (!outcome.ok) return { ok: false, error: outcome.error };
    throw new Error('documentOps devolvió un lote');
  };
}

/** El SHA del fichero como lo ve la biblioteca (lo que el servicio da a `forDocument`). */
async function fileSha(w: World, fileId: string): Promise<string> {
  const row = await w.port.documentSource().port.fileRead(fileId);
  if (!row) throw new Error('sin fichero');
  return row.sha256.toLowerCase();
}

/** Lo que proyecta el MCP: la lectura común de hojas (`openSheetRead`). */
async function mcpModel(w: World, fileId: string): Promise<{ model: SheetModel; revision: string }> {
  const opened = await openSheetRead(w.port.documentSource(), { id: fileId, sha256: await fileSha(w, fileId) }, live, 'empty');
  try {
    return { model: opened.read.model, revision: opened.read.revision };
  } finally {
    await opened.close();
  }
}

/**
 * Lo que proyecta la app al abrir el documento (`openOdsDocument` de `editor.ts`): el fichero
 * BASE (`head.baseSha256`), el `Y.Doc` con segmentos, pendientes y `recent`, y el adaptador sobre
 * esa base. Sin cabecera, el fichero tal cual (lo que la app ve antes de su andamiaje).
 */
async function appModel(w: World, fileId: string): Promise<SheetModel> {
  const port = w.port.documentSource().port;
  const read = await port.docRead(fileId);
  const head = read.head;
  if (!head) {
    const bytes = await port.blobRead(await fileSha(w, fileId));
    return (await prepareSheetBase(bytes!, SHEET_ODS_READ_LIMITS)).model;
  }
  const base = await port.blobRead(head.baseSha256);
  if (!base) throw new Error('la app no tiene la base');
  const doc = new Y.Doc();
  try {
    for (const update of [...read.segments, ...read.pending]) Y.applyUpdateV2(doc, update);
    if (head.recent !== '') Y.applyUpdateV2(doc, new Uint8Array(Buffer.from(head.recent, 'base64')));
    const adapter = createSheetAdapter(await prepareSheetBase(base, SHEET_ODS_READ_LIMITS));
    return await adapter.project(base, doc, live);
  } finally {
    doc.destroy();
  }
}

/** El `.ods` que exporta el documento ahora (lo que escribiría un punto de control). */
async function exported(w: World, fileId: string): Promise<Uint8Array> {
  const source = w.port.documentSource();
  const { head } = await source.port.docRead(fileId);
  const out = await createSheetDocumentExporter({ engine })(
    { libraryId: source.libraryId, store: source.port, blobRead: (s) => source.port.blobRead(s) },
    fileId,
    head!
  );
  return out.bytes;
}

async function edit(w: World, fileId: string, operationId: string, ops: SheetCommand[]) {
  const { revision } = await mcpModel(w, fileId);
  return runEditSheet(w.ctx, { id: fileId, operationId, expectedRevision: revision, ops }, editWriter(w), { capacity });
}

async function checkpoint(w: World, fileId: string): Promise<void> {
  await w.wiring.checkpoints.ensureCheckpoint(fileId, 'close');
}

/** Duplica como el escritor (`looseFileWriteLocal`): punto de control al día y copia del fichero. */
async function duplicate(w: World, fileId: string, name: string, operationId: string): Promise<string> {
  const target = { port: w.port, writeExclusive: w.port.writeExclusive.bind(w.port) };
  await prepareDocumentCopy(target, fileId, CONFIG);
  const saved = await writeLooseFile(
    w.port as unknown as Parameters<typeof writeLooseFile>[0],
    { action: 'duplicateFile', id: fileId, name, operationId, privacy: CONFIG },
    null,
    () => undefined
  );
  return saved.result.id;
}

// ---------------------------------------------------------------------------------------------
// Vistas para comparar.

function letters(col: number): string {
  let out = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** Una celda sin ids: el valor o, si es fórmula, su texto con cada referencia por nombre de hoja y posición. */
function cellText(model: SheetModel, value: CellValue): string {
  if (value !== null && typeof value === 'object' && 'f' in value) {
    // Cada `#k` del texto canónico, por su referencia resuelta; una que ya no existe es `#REF!`,
    // como la escribe el fichero al guardar (`canon.ts`).
    const refs = value.f.refs.map((ref) => {
      const sheet = model.sheets.find((s) => s.id === ref.sheet);
      const row = ref.row === null ? '*' : sheet?.rows.indexOf(ref.row);
      const col = ref.col === null ? '*' : sheet?.cols.indexOf(ref.col);
      if (!sheet || row === null || row === undefined || col === null || col === undefined) return '#REF!';
      return `${sheet.name}!${row}:${col}`;
    });
    return `=${value.f.src.replace(/#(\d+)/g, (_, k: string) => refs[Number(k)] ?? '#REF!')}`;
  }
  return JSON.stringify(value);
}

/** El libro como lo ve una persona: hojas en orden y celdas por dirección A1, sin ids. */
function visible(model: SheetModel) {
  return model.sheets.map((sheet) => {
    const cells: Record<string, string> = {};
    for (const [key, value] of sheet.cells) {
      const [rowId, colId] = key.split(':') as [string, string];
      const row = sheet.rows.indexOf(rowId);
      const col = sheet.cols.indexOf(colId);
      // Una celda cuya fila o columna no existe no se pinta en ninguna parte.
      if (row === null || col === null || value === null) continue;
      cells[`${letters(col)}${row + 1}`] = cellText(model, value);
    }
    return { name: sheet.name, hidden: sheet.hidden === true, cells };
  });
}

/** Lo mismo, con los ids de hoja: dos proyecciones del mismo estado deben coincidir también en ellos. */
function withIds(model: SheetModel) {
  return { ids: model.sheets.map((sheet) => sheet.id), sheets: visible(model) };
}

async function expectToolError(promise: Promise<unknown>): Promise<ToolError | null> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error
  );
  if (outcome === null) return null;
  expect(outcome).toBeInstanceOf(ToolError);
  return outcome as ToolError;
}

const names = (model: SheetModel) => model.sheets.map((sheet) => sheet.name);
const set = (sheet: string, start: string, value: unknown): SheetCommand => ({ type: 'setCells', sheet, start, rows: [[value]] });

// ---------------------------------------------------------------------------------------------
// Parte 1: un test por síntoma.

describe('el MCP proyecta sobre la base, no sobre el punto de control', () => {
  it('síntoma 1: addSheet y un punto de control no dejan la hoja repetida «X (2)»', async () => {
    const w = await world();
    const id = await upload(w, 'gastos.ods', bookOds(['Datos']));
    await edit(w, id, 'op-1', [{ type: 'addSheet', sheet: 'Dic' }]);
    // El primer lote ya dejó el punto de control automático; este es otro, con ediciones nuevas.
    await edit(w, id, 'op-2', [set('Dic', 'A1', 'diciembre')]);
    await checkpoint(w, id);
    expect((await w.port.documentSource().port.docRead(id)).head!.checkpointSha256).not.toBeNull();
    expect(names((await mcpModel(w, id)).model)).toEqual(['Datos', 'Dic']);
    await edit(w, id, 'op-3', [{ type: 'addSheet', sheet: 'Ene' }]);
    expect(names((await mcpModel(w, id)).model)).toEqual(['Datos', 'Dic', 'Ene']);
    expect(withIds((await mcpModel(w, id)).model)).toEqual(withIds(await appModel(w, id)));
  });

  it('síntoma 2: deleteSheet de s2 en un libro leído de bytes no se lleva la hoja siguiente', async () => {
    const w = await world();
    const id = await upload(w, 'gastos.ods', bookOds(MONTHS));
    await edit(w, id, 'op-1', [{ type: 'deleteSheet', sheet: 'Marzo' }]);
    expect((await w.port.documentSource().port.docRead(id)).head!.checkpointSha256).not.toBeNull();
    const { model } = await mcpModel(w, id);
    expect(names(model)).toEqual(['Enero', 'Febrero', 'Abril']);
    expect(visible(model).find((sheet) => sheet.name === 'Abril')!.cells).toEqual({ A1: '"Abril"', B1: '4' });
    await edit(w, id, 'op-2', [set('Abril', 'C1', 'sigue')]);
    expect(names((await mcpModel(w, id)).model)).toEqual(['Enero', 'Febrero', 'Abril']);
    expect(withIds((await mcpModel(w, id)).model)).toEqual(withIds(await appModel(w, id)));
  });

  it('síntoma 3: duplicar saca un .ods con todos los lotes guardados', async () => {
    const w = await world();
    const id = await upload(w, 'gastos.ods', bookOds(['Datos']));
    await edit(w, id, 'op-1', [{ type: 'addSheet', sheet: 'Dic' }]);
    await edit(w, id, 'op-1b', [set('Dic', 'A1', 'uno')]);
    await edit(w, id, 'op-2', [set('Dic', 'A2', 'dos'), set('Datos', 'C1', 'tres')]);
    const copyId = await duplicate(w, id, 'gastos copia.ods', 'op-dup');
    const copy = await w.port.documentSource().port.blobRead(await fileSha(w, copyId));
    const view = visible((await prepareSheetBase(copy!, SHEET_ODS_READ_LIMITS)).model);
    expect(view.map((sheet) => sheet.name)).toEqual(['Datos', 'Dic']);
    expect(view[1]!.cells).toMatchObject({ A1: '"uno"', A2: '"dos"' });
    expect(view[0]!.cells).toMatchObject({ C1: '"tres"' });
  });

  it("síntoma 4: setCells con ='Hoja'!A1 a una hoja del fichero no da «Hoja desconocida»", async () => {
    const w = await world();
    const id = await upload(w, 'gastos.ods', bookOds(MONTHS));
    await edit(w, id, 'op-1', [{ type: 'deleteSheet', sheet: 'Enero' }]);
    const failure = await expectToolError(edit(w, id, 'op-2', [set('Abril', 'C1', "='Febrero'!B1")]));
    expect(failure?.code ?? null).toBeNull();
    const view = visible((await mcpModel(w, id)).model);
    expect(view.find((sheet) => sheet.name === 'Abril')!.cells.C1).toMatch(/Febrero!0:1/);
    expect(withIds((await mcpModel(w, id)).model)).toEqual(withIds(await appModel(w, id)));
  });
});

// ---------------------------------------------------------------------------------------------
// Parte 2: el invariante, sobre secuencias.

type Step =
  | { kind: 'lot'; ops: SheetCommand[] }
  | { kind: 'checkpoint' }
  | { kind: 'duplicate' };

/** El oráculo: hojas en orden y las celdas literales escritas, por hoja. */
interface Oracle {
  sheets: string[];
  cells: Map<string, Map<string, string>>;
}

function oracleOf(start: readonly string[]): Oracle {
  return {
    sheets: [...start],
    cells: new Map(start.map((name, index) => [name, new Map([['A1', JSON.stringify(name)], ['B1', String(index + 1)]])]))
  };
}

function applyOracle(oracle: Oracle, ops: readonly SheetCommand[]): void {
  for (const op of ops) {
    if (op.type === 'addSheet') {
      oracle.sheets.push(op.sheet);
      oracle.cells.set(op.sheet, new Map());
    } else if (op.type === 'deleteSheet') {
      oracle.sheets.splice(oracle.sheets.indexOf(op.sheet), 1);
      oracle.cells.delete(op.sheet);
    } else if (op.type === 'renameSheet') {
      oracle.sheets[oracle.sheets.indexOf(op.sheet)] = op.name!;
      oracle.cells.set(op.name!, oracle.cells.get(op.sheet)!);
      oracle.cells.delete(op.sheet);
    } else if (op.type === 'moveSheet') {
      oracle.sheets.splice(oracle.sheets.indexOf(op.sheet), 1);
      oracle.sheets.splice(op.to, 0, op.sheet);
    } else if (op.type === 'setCells') {
      const value = op.rows[0]![0];
      // Las fórmulas las juzga la comparación con la app y con el export; aquí, los literales.
      if (typeof value === 'string' && value.startsWith('=')) oracle.cells.get(op.sheet)!.delete(op.start);
      else oracle.cells.get(op.sheet)!.set(op.start, JSON.stringify(value));
    }
  }
}

/** Tras cada paso: MCP = app (con ids), export releído = app, y el oráculo se cumple. */
async function assertInvariant(w: World, fileId: string, oracle: Oracle, where: string): Promise<void> {
  const app = await appModel(w, fileId);
  expect(withIds((await mcpModel(w, fileId)).model), `${where}: MCP = app`).toEqual(withIds(app));
  if ((await w.port.documentSource().port.docRead(fileId)).head) {
    const reread = (await prepareSheetBase(await exported(w, fileId), SHEET_ODS_READ_LIMITS)).model;
    expect(visible(reread), `${where}: export releído = app`).toEqual(visible(app));
  }
  const view = visible(app);
  expect(view.map((sheet) => sheet.name), `${where}: hojas`).toEqual(oracle.sheets);
  for (const sheet of view) {
    expect(sheet.cells, `${where}: celdas de ${sheet.name}`).toMatchObject(Object.fromEntries(oracle.cells.get(sheet.name)!));
  }
}

async function runSequence(steps: readonly Step[], start: readonly string[], label: string): Promise<void> {
  const w = await world();
  let fileId = await upload(w, `${label}.ods`, bookOds(start));
  const oracle = oracleOf(start);
  await assertInvariant(w, fileId, oracle, `${label} al subir`);
  for (const [index, step] of steps.entries()) {
    const where = `${label} paso ${index} (${step.kind}${step.kind === 'lot' ? ` ${step.ops.map((op) => op.type).join(',')}` : ''})`;
    if (step.kind === 'lot') {
      const failure = await expectToolError(edit(w, fileId, `${label}-op-${index}`, step.ops));
      expect(failure ? `${failure.code} ${JSON.stringify(failure.extra ?? null)}` : null, where).toBeNull();
      applyOracle(oracle, step.ops);
    } else if (step.kind === 'checkpoint') {
      // Sin cabecera (un fichero recién subido o copiado) no hay nada que exportar.
      if ((await w.port.documentSource().port.docRead(fileId)).head) await checkpoint(w, fileId);
    } else {
      fileId = await duplicate(w, fileId, `${label} copia ${index}.ods`, `${label}-dup-${index}`);
    }
    await assertInvariant(w, fileId, oracle, where);
  }
}

const lot = (...ops: SheetCommand[]): Step => ({ kind: 'lot', ops });
const CHECKPOINT: Step = { kind: 'checkpoint' };
const DUPLICATE: Step = { kind: 'duplicate' };

/** Las secuencias de los fallos vistos, y las que mezclan los cinco comandos con puntos de control y copias. */
const FIXED: ReadonlyArray<{ label: string; start: readonly string[]; steps: readonly Step[] }> = [
  {
    label: 'gastos',
    start: ['Datos'],
    steps: [
      lot({ type: 'addSheet', sheet: 'Dic' }, { type: 'addSheet', sheet: 'Ene' }, { type: 'addSheet', sheet: 'Feb' }),
      lot(set('Ene', 'A1', 111), set('Feb', 'A1', 222)),
      CHECKPOINT,
      lot({ type: 'deleteSheet', sheet: 'Dic' }),
      lot(set('Feb', 'B1', "='Ene'!A1")),
      DUPLICATE,
      lot({ type: 'deleteSheet', sheet: 'Ene' }, set('Feb', 'C1', 3)),
      CHECKPOINT,
      lot(set('Datos', 'C2', "='Feb'!C1"))
    ]
  },
  {
    label: 'meses',
    start: MONTHS,
    steps: [
      lot({ type: 'moveSheet', sheet: 'Abril', to: 0 }),
      lot({ type: 'renameSheet', sheet: 'Febrero', name: 'Feb' }),
      lot(set('Marzo', 'C1', "='Feb'!B1")),
      CHECKPOINT,
      lot({ type: 'deleteSheet', sheet: 'Enero' }, set('Abril', 'C1', 'abril')),
      DUPLICATE,
      lot({ type: 'moveSheet', sheet: 'Marzo', to: 0 }, { type: 'addSheet', sheet: 'Mayo' }),
      CHECKPOINT,
      lot(set('Mayo', 'A1', "='Abril'!C1"), { type: 'renameSheet', sheet: 'Abril', name: 'Abr' }),
      DUPLICATE,
      lot({ type: 'deleteSheet', sheet: 'Feb' }, set('Mayo', 'B2', 5))
    ]
  }
];

/** PRNG con semilla (mulberry32): mismas secuencias en cada pasada. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Una secuencia generada: lotes de 1 a 3 comandos entre los cinco (addSheet, deleteSheet,
 * moveSheet, renameSheet, setCells con literal o con referencia a otra hoja), puntos de control y
 * copias. Lleva su propia lista de hojas para no pedir un comando imposible; una hoja a la que
 * apunta una fórmula no se borra (la fórmula pasaría a #REF y el oráculo no lo modela).
 */
function generated(seed: number, length: number): { label: string; start: readonly string[]; steps: Step[] } {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const start = MONTHS.slice(0, 2 + Math.floor(random() * 3));
  const sheets: string[] = [...start];
  const referenced = new Set<string>();
  let fresh = 0;
  const steps: Step[] = [];
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    if (roll < 0.15) {
      steps.push(CHECKPOINT);
      continue;
    }
    if (roll < 0.25) {
      steps.push(DUPLICATE);
      continue;
    }
    const ops: SheetCommand[] = [];
    // Un lote resuelve los nombres contra el libro de ANTES del lote (una hoja creada o renombrada
    // en él se nombra con `as` y `$alias`): las de este lote no se vuelven a nombrar en él.
    const touched = new Set<string>();
    const count = 1 + Math.floor(random() * 3);
    for (let n = 0; n < count; n += 1) {
      const kind = random();
      const stable = sheets.filter((name) => !touched.has(name));
      const deletable = stable.filter((name) => !referenced.has(name));
      if (kind < 0.2 || stable.length === 0) {
        const name = `H${seed}x${(fresh += 1)}`;
        sheets.push(name);
        touched.add(name);
        ops.push({ type: 'addSheet', sheet: name });
      } else if (kind < 0.35 && sheets.length > 1 && deletable.length > 0) {
        const name = pick(deletable);
        sheets.splice(sheets.indexOf(name), 1);
        ops.push({ type: 'deleteSheet', sheet: name });
      } else if (kind < 0.5 && sheets.length > 1) {
        const name = pick(stable);
        const to = Math.floor(random() * sheets.length);
        sheets.splice(sheets.indexOf(name), 1);
        sheets.splice(to, 0, name);
        ops.push({ type: 'moveSheet', sheet: name, to });
      } else if (kind < 0.6) {
        const name = pick(stable);
        const renamed = `R${seed}x${(fresh += 1)}`;
        sheets[sheets.indexOf(name)] = renamed;
        touched.add(renamed);
        if (referenced.delete(name)) referenced.add(renamed);
        ops.push({ type: 'renameSheet', sheet: name, name: renamed });
      } else {
        const sheet = pick(stable);
        const address = `${pick(['C', 'D'])}${1 + Math.floor(random() * 3)}`;
        const others = stable.filter((name) => name !== sheet);
        if (others.length > 0 && random() < 0.5) {
          const target = pick(others);
          referenced.add(target);
          ops.push(set(sheet, address, `='${target}'!B1`));
        } else {
          ops.push(set(sheet, address, Math.floor(random() * 1000)));
        }
      }
    }
    steps.push(lot(...ops));
  }
  return { label: `semilla-${seed}`, start, steps };
}

const SEEDS = [1, 2, 3, 4, 5, 6];

describe('invariante: tras cada paso, el MCP proyecta lo mismo que la app y el .ods se relee igual', () => {
  for (const sequence of FIXED) {
    it(`secuencia ${sequence.label}`, async () => {
      await runSequence(sequence.steps, sequence.start, sequence.label);
    }, 120_000);
  }

  it('las secuencias generadas cubren los cinco comandos, las referencias, los puntos de control y las copias', () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      for (const step of generated(seed, 8).steps) {
        if (step.kind !== 'lot') kinds.add(step.kind);
        else for (const op of step.ops) kinds.add(op.type === 'setCells' && String(op.rows[0]![0]).startsWith('=') ? 'ref' : op.type);
      }
    }
    expect([...kinds].sort()).toEqual(
      ['addSheet', 'checkpoint', 'deleteSheet', 'duplicate', 'moveSheet', 'ref', 'renameSheet', 'setCells'].sort()
    );
  });

  for (const seed of SEEDS) {
    it(`secuencia generada con semilla ${seed}`, async () => {
      const sequence = generated(seed, 8);
      await runSequence(sequence.steps, sequence.start, sequence.label);
    }, 120_000);
  }

  it('hebra_create_sheet: el libro creado y sus lotes de después cumplen el invariante', async () => {
    const w = await world();
    const created = await runCreateSheet(
      w.ctx,
      {
        name: 'Nuevo.ods',
        folderId: w.folderId,
        operationId: 'op-create',
        ops: [
          { type: 'renameSheet', sheet: DEFAULT_SHEET_NAME, name: 'Uno' },
          { type: 'addSheet', sheet: 'Dos' },
          { type: 'addSheet', sheet: 'Tres' },
          set('Dos', 'A1', 2)
        ]
      },
      createWriter(w)
    );
    const oracle: Oracle = { sheets: ['Uno', 'Dos', 'Tres'], cells: new Map([['Uno', new Map()], ['Dos', new Map([['A1', '2']])], ['Tres', new Map()]]) };
    await assertInvariant(w, created.id, oracle, 'creado');
    const steps: Step[] = [
      lot({ type: 'deleteSheet', sheet: 'Uno' }, set('Tres', 'A1', "='Dos'!A1")),
      CHECKPOINT,
      lot({ type: 'moveSheet', sheet: 'Tres', to: 0 }, set('Dos', 'B1', 7)),
      CHECKPOINT,
      lot({ type: 'deleteSheet', sheet: 'Dos' }),
    ];
    // Borrar `Dos` deja la fórmula de `Tres` en #REF: la compara la app y el export, no el oráculo.
    for (const [index, step] of steps.entries()) {
      if (step.kind === 'lot') {
        const failure = await expectToolError(edit(w, created.id, `create-op-${index}`, step.ops));
        expect(failure?.code ?? null).toBeNull();
        applyOracle(oracle, step.ops);
      } else await checkpoint(w, created.id);
      await assertInvariant(w, created.id, oracle, `creado paso ${index}`);
    }
  }, 120_000);
});
