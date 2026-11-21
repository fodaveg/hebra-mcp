/**
 * C-26: el escritor de `hebra_import_office` con el motor real del MCP y un doble del
 * convertidor (el hilo es de C-27). Cubre el orden de escritura por modo, la regla 2, los
 * cortes entre pasos y su reintento, la privacidad (carpeta, origen, etiquetas, nombres
 * ocultos), un espacio de solo lectura y que en cada caso rechazado no se escribe nada.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import {
  importOfficeLocal,
  type OfficeConversionRunner,
  type OfficeImportInput,
  type OfficeImportSaved
} from '../../src/store/office-writes';
import { OFFICE_FILE_ID_MAX_BYTES } from '../../src/server/tools/office-limits';
import type { NoteWriteStore, NoteWriteTarget } from '../../src/store/writes';
import type { PrivacyConfig } from '../../src/privacy/config';
import type { SyncStorePort } from '../../src/store/sync-port';
import { ConversionError } from '../../vendor/hebra/src/lib/office-import/types';
import type {
  ConversionPreview,
  ConversionResult,
  OfficeFormat
} from '../../vendor/hebra/src/lib/office-import/types';
import { IDENTITY } from '../sync/devices';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
/** Sin carpetas privadas: el espacio de prueba no tiene la `Diario` de la configuración. */
const SPACE_CONFIG: PrivacyConfig = { privateFolders: [], privateTags: ['secreto'] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(shared = false) {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-office-writes-'));
  directories.push(directory);
  const spaceAccess = {
    spaceId: '955480b0-c2c3-471f-aa5d-3f37ed46fe68',
    scope: 'fixture',
    authorize: async () => {},
    assertActive: () => {}
  };
  const port = await openNodeLibraryPort({
    sqlitePath: join(directory, 'library.sqlite'),
    ...(shared ? { spaceAccess } : {})
  });
  ports.push(port);
  if (shared) {
    await port.syncStorePort().libraryConnect({
      binding: { ...IDENTITY, libraryInstance: 'office-writes-test' },
      relayHasRecords: true
    });
  }
  return port;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const XLSX = new TextEncoder().encode('PK-hoja-de-prueba');

interface Double extends OfficeConversionRunner {
  converts: number;
  analyzes: number;
}

type Output = ConversionResult['output'];

/** Un convertidor doble: devuelve `output`, o lanza `error`, o produce una salida inválida. */
function converter(options: { output?: Output; error?: unknown; preview?: ConversionPreview } = {}): Double {
  const output: Output = options.output ?? {
    kind: 'note',
    title: 'Hoja convertida',
    markdown: '# Hoja convertida\n\nTotal 42 #proyectos',
    assets: []
  };
  const double: Double = {
    converts: 0,
    analyzes: 0,
    async analyze(job) {
      double.analyzes += 1;
      return options.preview ?? { format: job.format, convertible: true, losses: [] };
    },
    async convert() {
      double.converts += 1;
      if (options.error) throw options.error;
      return { output, losses: [{ kind: 'format:font', count: 2, label: 'Fuentes' }] };
    }
  };
  return double;
}

/** Un fichero suelto de texto en `folderId`. */
async function addFile(port: NodeLibraryPort, folderId: string, name: string, bytes: Uint8Array) {
  return port.writeExclusive(async (store) => {
    await store.blobPut(bytes, { mime: 'application/octet-stream', expectedSha256: sha(bytes) });
    return store.fileCreate(folderId, name, sha(bytes));
  });
}

async function world() {
  const port = await open();
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  const enDiario = (await addFile(port, diario, 'privado.xlsx', XLSX)).id;
  const origen = (await addFile(port, publica, 'Origen.xlsx', XLSX)).id;
  return { port, publica, diario, enDiario, origen };
}

/** Lo que cambiaría una escritura: carpetas, ficheros (con papelera) y notas, tal cual. */
async function snapshot(port: NodeLibraryPort): Promise<string> {
  const notes = (await port.libraryOpen()).notesCount;
  return port.writeExclusive(async (store) =>
    JSON.stringify({ folders: store.foldersList(), files: store.filesIndex(), notes })
  );
}

async function liveFiles(port: NodeLibraryPort) {
  return port.writeExclusive(async (store) => store.filesIndex().files.filter((file) => file.trashedAt === null));
}

function input(folderId: string, extra: Partial<OfficeImportInput> = {}): OfficeImportInput {
  return {
    bytes: XLSX,
    fileName: 'Libro.xlsx',
    format: 'xlsx' as OfficeFormat,
    mode: 'convert-and-keep',
    preview: false,
    folderId,
    operationId: 'op-1',
    privacy: CONFIG,
    ...extra
  };
}

/**
 * El turno con un corte justo después de la llamada `nth` (desde 1) a `path`: el proceso
 * "muere", así que toda llamada posterior al almacén falla y nada más llega a escribirse
 * (`commitImport` trata un error del puerto como una conversión fallida y seguiría).
 */
function crashAfter(port: NodeLibraryPort, path: string, nth = 1): NoteWriteTarget {
  let calls = 0;
  let dead = false;
  const wrap = (target: object, owner: string): object =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property);
        const name = typeof property === 'string' ? (owner ? `${owner}.${property}` : property) : '';
        if (name === 'operations') return wrap(value as object, 'operations');
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (dead) throw new Error('corte');
          const result = Reflect.apply(value, object, args);
          if (name !== path) return result;
          const crash = () => {
            calls += 1;
            if (calls === nth) {
              dead = true;
              throw new Error('corte');
            }
          };
          if (result instanceof Promise) {
            return result.then((done) => {
              crash();
              return done;
            });
          }
          crash();
          return result;
        };
      }
    });
  return {
    writeExclusive: (operation) => port.writeExclusive((store) => operation(wrap(store, '') as NoteWriteStore))
  };
}

describe('importOfficeLocal (C-26)', () => {
  it('convert-and-keep: el original como fichero y la conversión como nota, en ese orden', async () => {
    const w = await world();
    const fake = converter();
    const { result, wrote } = await importOfficeLocal(w.port, input(w.publica), { converter: fake });
    expect(wrote).toBe(true);
    expect(result).toMatchObject({ outcome: 'converted', convertible: true });
    expect(result.original).toMatchObject({ name: 'Libro.xlsx', sha256: sha(XLSX) });
    expect(result.note?.title).toBe('Hoja convertida');
    expect(result.losses).toEqual([{ kind: 'format:font', count: 2, label: 'Fuentes' }]);
    const note = await w.port.noteRead(result.note!.id);
    expect(note?.body).toContain('Total 42');
    expect(note?.folderId).toBe(w.publica);
    expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.xlsx')).toHaveLength(1);
  });

  it('convert-only: solo la nota; keep-only: solo el original, y repetirlo con otro id es already', async () => {
    const w = await world();
    const only = await importOfficeLocal(w.port, input(w.publica, { mode: 'convert-only' }), { converter: converter() });
    expect(only.result.original).toBeUndefined();
    expect(only.result.note).toBeDefined();
    expect((await liveFiles(w.port)).some((file) => file.name === 'Libro.xlsx')).toBe(false);

    const fake = converter();
    const keep = await importOfficeLocal(w.port, input(w.publica, { mode: 'keep-only', operationId: 'op-k' }), { converter: fake });
    expect(keep.result).toMatchObject({ outcome: 'kept_original', convertible: false });
    expect(keep.result.note).toBeUndefined();
    expect(fake.converts).toBe(0);
    const again = await importOfficeLocal(w.port, input(w.publica, { mode: 'keep-only', operationId: 'op-k2' }), { converter: fake });
    expect(again.result.outcome).toBe('already');
    expect(again.wrote).toBe(false);
    expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.xlsx')).toHaveLength(1);
  });

  it('una conversión en forma de fichero se guarda como fichero suelto', async () => {
    const w = await world();
    const ods = new TextEncoder().encode('ods-bytes');
    const fake = converter({ output: { kind: 'file', name: 'Libro.ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', bytes: ods } });
    const { result } = await importOfficeLocal(w.port, input(w.publica), { converter: fake });
    expect(result.convertedFile).toMatchObject({ name: 'Libro.ods', sha256: sha(ods) });
    expect(result.note).toBeUndefined();
    expect(result.original?.name).toBe('Libro.xlsx');
  });

  it('regla 2: si la conversión falla, el original se guarda siempre, en los dos modos', async () => {
    for (const mode of ['convert-and-keep', 'convert-only'] as const) {
      const w = await world();
      const fake = converter({ error: new ConversionError('encrypted', 'Cifrado.') });
      const { result } = await importOfficeLocal(w.port, input(w.publica, { mode }), { converter: fake });
      expect(result).toMatchObject({ outcome: 'kept_original', convertible: false, reason: 'encrypted', losses: [] });
      expect(result.note).toBeUndefined();
      expect(result.original).toMatchObject({ name: 'Libro.xlsx', sha256: sha(XLSX) });
      expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.xlsx')).toHaveLength(1);
    }
  });

  it('una salida inválida o un error ajeno cuentan como fallo: original guardado, sin motivo de bloqueo', async () => {
    const w = await world();
    const vacia = converter({ output: { kind: 'note', title: 'x', markdown: '   ', assets: [] } });
    const first = await importOfficeLocal(w.port, input(w.publica), { converter: vacia });
    expect(first.result).toMatchObject({ outcome: 'kept_original', convertible: false });
    expect(first.result.reason).toBeUndefined();
    const roto = converter({ error: new Error('boom: contenido secreto del documento') });
    const second = await importOfficeLocal(w.port, input(w.publica, { operationId: 'op-2' }), { converter: roto });
    expect(second.result.outcome).toBe('kept_original');
    expect(JSON.stringify(second.result)).not.toContain('secreto');
  });

  it('una nota por encima de 2 MiB no se escribe y el original se guarda', async () => {
    const w = await world();
    const grande = converter({ output: { kind: 'note', title: 'G', markdown: 'a'.repeat(2 * 1024 * 1024 + 10), assets: [] } });
    const { result } = await importOfficeLocal(w.port, input(w.publica), { converter: grande });
    expect(result.outcome).toBe('kept_original');
    expect((await w.port.libraryOpen()).notesCount).toBe(0);
  });

  describe('con un fichero de la biblioteca como origen', () => {
    it('convert-and-keep deja el origen donde está y no lo copia', async () => {
      const w = await world();
      const { result } = await importOfficeLocal(
        w.port,
        input(w.publica, { fileName: 'Origen.xlsx', sourceFileId: w.origen }),
        { converter: converter() }
      );
      expect(result.original).toMatchObject({ id: w.origen });
      expect(result.original?.trashed).toBeUndefined();
      expect((await liveFiles(w.port)).filter((file) => file.name === 'Origen.xlsx')).toHaveLength(1);
    });

    it('convert-only lo manda a la papelera al convertir, y si falla lo deja', async () => {
      const w = await world();
      const { result } = await importOfficeLocal(
        w.port,
        input(w.publica, { fileName: 'Origen.xlsx', sourceFileId: w.origen, mode: 'convert-only' }),
        { converter: converter() }
      );
      expect(result.original).toMatchObject({ id: w.origen, trashed: true });
      expect((await liveFiles(w.port)).some((file) => file.id === w.origen)).toBe(false);

      const v = await world();
      const failed = await importOfficeLocal(
        v.port,
        input(v.publica, { fileName: 'Origen.xlsx', sourceFileId: v.origen, mode: 'convert-only' }),
        { converter: converter({ error: new ConversionError('corrupt', 'Corrupto.') }) }
      );
      expect(failed.result).toMatchObject({ outcome: 'kept_original', reason: 'corrupt' });
      expect(failed.wrote).toBe(false);
      expect((await liveFiles(v.port)).some((file) => file.id === v.origen)).toBe(true);
    });

    it('keep-only sobre un fichero de la biblioteca no escribe nada', async () => {
      const w = await world();
      const before = await snapshot(w.port);
      const { result, wrote } = await importOfficeLocal(
        w.port,
        input(w.publica, { fileName: 'Origen.xlsx', sourceFileId: w.origen, mode: 'keep-only' }),
        { converter: converter() }
      );
      expect(result.outcome).toBe('already');
      expect(wrote).toBe(false);
      expect(await snapshot(w.port)).toBe(before);
    });
  });

  describe('idempotencia', () => {
    it('el mismo operationId y la misma petición devuelve lo anotado con replayed y no duplica', async () => {
      const w = await world();
      const first = await importOfficeLocal(w.port, input(w.publica), { converter: converter() });
      const before = await snapshot(w.port);
      const fake = converter();
      const second = await importOfficeLocal(w.port, input(w.publica), { converter: fake });
      expect(second.result).toEqual({ ...first.result, replayed: true });
      expect(second.wrote).toBe(false);
      expect(await snapshot(w.port)).toBe(before);
    });

    it('el mismo operationId con otra petición es operation_id_reused y no escribe', async () => {
      const w = await world();
      await importOfficeLocal(w.port, input(w.publica), { converter: converter() });
      const before = await snapshot(w.port);
      await expect(
        importOfficeLocal(w.port, input(w.publica, { mode: 'keep-only' }), { converter: converter() })
      ).rejects.toMatchObject({ code: 'operation_id_reused' });
      expect(await snapshot(w.port)).toBe(before);
    });

    const cuts: Array<[string, string, number]> = [
      ['tras guardar el original', 'fileCreate', 1],
      ['tras crear la nota', 'libraryImportBatch', 1],
      ['antes de cerrar el registro', 'operations.finish', 1]
    ];
    it.each(cuts)('un corte %s y su reintento no duplican', async (_label, path, nth) => {
      const w = await world();
      const filesBefore = (await liveFiles(w.port)).length;
      await expect(
        importOfficeLocal(crashAfter(w.port, path, nth), input(w.publica), { converter: converter() })
      ).rejects.toThrow('corte');
      const retry = await importOfficeLocal(w.port, input(w.publica), { converter: converter() });
      expect(retry.result.outcome).toBe('converted');
      // Una nota visible con el cuerpo y un solo original; ninguna nota vacía suelta.
      expect((await w.port.libraryOpen()).notesCount).toBe(1);
      expect((await w.port.noteRead(retry.result.note!.id))?.body).toContain('Total 42');
      expect(await liveFiles(w.port)).toHaveLength(filesBefore + 1);
    });

    it('un corte entre crear la nota y anotarla, y su reintento, deja exactamente una nota con la conversión', async () => {
      const w = await world();
      await expect(
        importOfficeLocal(crashAfter(w.port, 'libraryImportBatch'), input(w.publica), { converter: converter() })
      ).rejects.toThrow('corte');
      const retry = await importOfficeLocal(w.port, input(w.publica), { converter: converter() });
      expect((await w.port.noteRead(retry.result.note!.id))?.body).toContain('Total 42');
      expect((await w.port.libraryOpen()).notesCount).toBe(1);
      expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.xlsx')).toHaveLength(1);
    });

    it('en un espacio, un corte tras crear la fila vacía y su reintento dejan una sola nota con el cuerpo', async () => {
      const port = await open(true);
      await expect(
        importOfficeLocal(crashAfter(port, 'libraryImportBatch'), input('root', { privacy: SPACE_CONFIG }), {
          converter: converter()
        })
      ).rejects.toThrow('corte');
      const retry = await importOfficeLocal(port, input('root', { privacy: SPACE_CONFIG }), { converter: converter() });
      expect((await port.noteRead(retry.result.note!.id))?.body).toContain('Total 42');
      expect((await port.libraryOpen()).notesCount).toBe(1);
    });

    it('un corte tras mandar el origen a la papelera y su reintento no repiten la papelera', async () => {
      const w = await world();
      const args = input(w.publica, { fileName: 'Origen.xlsx', sourceFileId: w.origen, mode: 'convert-only' });
      await expect(
        importOfficeLocal(crashAfter(w.port, 'fileTrash'), args, { converter: converter() })
      ).rejects.toThrow('corte');
      const retry = await importOfficeLocal(w.port, args, { converter: converter() });
      expect(retry.result).toMatchObject({ outcome: 'converted', original: { id: w.origen, trashed: true } });
      expect((await w.port.libraryOpen()).notesCount).toBe(1);
    });

    it('un corte tras crear la conversión en forma de fichero y su reintento no duplican', async () => {
      const w = await world();
      const ods = new TextEncoder().encode('ods-bytes');
      const output: Output = { kind: 'file', name: 'Libro.ods', mime: 'x/ods', bytes: ods };
      await expect(
        importOfficeLocal(crashAfter(w.port, 'fileCreate', 2), input(w.publica), { converter: converter({ output }) })
      ).rejects.toThrow('corte');
      await importOfficeLocal(w.port, input(w.publica), { converter: converter({ output }) });
      expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.ods')).toHaveLength(1);
      expect((await liveFiles(w.port)).filter((file) => file.name === 'Libro.xlsx')).toHaveLength(1);
    });
  });

  describe('privacidad y permisos (R-04)', () => {
    it('una carpeta de destino privada da not_found, igual que una inexistente, y no escribe', async () => {
      const w = await world();
      const before = await snapshot(w.port);
      for (const folderId of [w.diario, 'no-existe']) {
        await expect(
          importOfficeLocal(w.port, input(folderId), { converter: converter() })
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un fichero de origen privado o inexistente da not_found y no escribe', async () => {
      const w = await world();
      const before = await snapshot(w.port);
      for (const sourceFileId of [w.enDiario, 'no-existe']) {
        await expect(
          importOfficeLocal(w.port, input(w.publica, { sourceFileId }), { converter: converter() })
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      expect(await snapshot(w.port)).toBe(before);
    });

    it('una nota resultante con una etiqueta privada da not_found, sin escribir ni el original', async () => {
      const w = await world();
      const before = await snapshot(w.port);
      const privada = converter({ output: { kind: 'note', title: 'P', markdown: '# P\n\n#secreto', assets: [] } });
      await expect(importOfficeLocal(w.port, input(w.publica), { converter: privada })).rejects.toMatchObject({
        code: 'not_found'
      });
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un homónimo visible con otros bytes es file_exists y no escribe', async () => {
      const w = await world();
      const homonimo = await addFile(w.port, w.publica, 'Libro.xlsx', new TextEncoder().encode('otro'));
      const before = await snapshot(w.port);
      await expect(importOfficeLocal(w.port, input(w.publica), { converter: converter() })).rejects.toMatchObject({
        code: 'file_exists',
        existingId: homonimo.id
      });
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un homónimo de la conversión en forma de fichero se rechaza ANTES de guardar el original', async () => {
      const w = await world();
      await addFile(w.port, w.publica, 'Libro.ods', new TextEncoder().encode('otro'));
      const before = await snapshot(w.port);
      const output: Output = { kind: 'file', name: 'Libro.ods', mime: 'x/ods', bytes: new TextEncoder().encode('ods') };
      await expect(
        importOfficeLocal(w.port, input(w.publica), { converter: converter({ output }) })
      ).rejects.toMatchObject({ code: 'file_exists' });
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un nombre que enlaza una nota oculta es file_name_unavailable y no escribe', async () => {
      const w = await world();
      await w.port.writeExclusive(async (store) => {
        const note = await store.noteCreate(w.publica);
        const body = '# Oculta\n\n#secreto ![[Libro.xlsx]]';
        const { deriveNote } = await import('../../src/hebra');
        const { saveInputFor } = await import('../../src/store/writes');
        await store.noteSave(saveInputFor(note, body, note, deriveNote(body)));
      });
      const before = await snapshot(w.port);
      await expect(importOfficeLocal(w.port, input(w.publica), { converter: converter() })).rejects.toMatchObject({
        code: 'file_name_unavailable'
      });
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un espacio de solo lectura como destino se rechaza con client_outdated sin escribir', async () => {
      const port = await open(true);
      await port.syncStorePort().syncApplyPage([
        {
          id: 'shared-note',
          rev: 1,
          minClient: 3,
          deleted: false,
          plaintextHash: 'fixture-1',
          fields: {
            kind: 'note', folderId: 'root', body: '# Compartida', favorite: false,
            createdAt: 1, updatedAt: 1, trashedAt: null, conflictOf: null,
            conflictAt: null, conflictDevice: null
          }
        }
      ] as Parameters<SyncStorePort['syncApplyPage']>[0]);
      const before = await port.libraryOpen();
      await expect(
        importOfficeLocal(port, input('root', { privacy: SPACE_CONFIG }), { converter: converter() })
      ).rejects.toMatchObject({ code: 'client_outdated' });
      const after = await port.libraryOpen();
      expect(after.notesCount).toBe(before.notesCount);
      expect(after.foldersCount).toBe(before.foldersCount);
    });

    it('el mismo espacio con escritura importa y escribe la nota con su cuerpo', async () => {
      const port = await open(true);
      const { result } = await importOfficeLocal(port, input('root', { privacy: SPACE_CONFIG }), {
        converter: converter()
      });
      expect(result.outcome).toBe('converted');
      expect((await port.noteRead(result.note!.id))?.body).toContain('Total 42');
    });
  });

  describe('entrada y preview', () => {
    it('preview solo analiza: no abre turno ni escribe, y no exige operationId', async () => {
      const w = await world();
      let turns = 0;
      const target: NoteWriteTarget = {
        writeExclusive: (operation) => {
          turns += 1;
          return w.port.writeExclusive(operation);
        }
      };
      const before = await snapshot(w.port);
      const fake = converter({ preview: { format: 'xlsx', convertible: true, losses: [{ kind: 'content:macro', count: 1, label: 'Macros' }] } });
      const { result, wrote } = await importOfficeLocal(target, input(w.publica, { preview: true, operationId: undefined }), { converter: fake });
      expect(result).toEqual({ outcome: 'preview', convertible: true, losses: [{ kind: 'content:macro', count: 1, label: 'Macros' }] });
      expect(wrote).toBe(false);
      expect(turns).toBe(0);
      expect(fake.converts).toBe(0);
      expect(await snapshot(w.port)).toBe(before);
    });

    it('un preview bloqueado da el motivo', async () => {
      const w = await world();
      const fake = converter({ preview: { format: 'xlsx', convertible: false, reason: 'encrypted', losses: [] } });
      const { result } = await importOfficeLocal(w.port, input(w.publica, { preview: true }), { converter: fake });
      expect(result).toMatchObject({ outcome: 'preview', convertible: false, reason: 'encrypted' });
    });

    it('rechaza sin tocar el almacén ni el convertidor una entrada que no vale', async () => {
      const w = await world();
      const fake = converter();
      const before = await snapshot(w.port);
      const bad: Array<[Partial<OfficeImportInput>, string]> = [
        [{ operationId: undefined }, 'invalid_input'],
        [{ operationId: '' }, 'invalid_input'],
        [{ operationId: 'x'.repeat(201) }, 'invalid_input'],
        [{ fileName: 'Libro.docx' }, 'invalid_input'],
        [{ fileName: 'a/b.xlsx' }, 'invalid_input'],
        [{ folderId: '' }, 'invalid_input'],
        [{ bytes: new Uint8Array(0) }, 'invalid_input'],
        [{ mode: 'otro' as never }, 'invalid_input'],
        [{ bytes: new Uint8Array(OFFICE_FILE_ID_MAX_BYTES + 1) }, 'file_too_large']
      ];
      for (const [extra, code] of bad) {
        await expect(importOfficeLocal(w.port, input(w.publica, extra), { converter: fake })).rejects.toMatchObject({ code });
      }
      expect(fake.converts + fake.analyzes).toBe(0);
      expect(await snapshot(w.port)).toBe(before);
    });
  });

  it('llama a onWritten solo si escribió algo', async () => {
    const w = await world();
    let calls = 0;
    await importOfficeLocal(w.port, input(w.publica), { converter: converter() }, () => (calls += 1));
    expect(calls).toBe(1);
    await importOfficeLocal(w.port, input(w.publica), { converter: converter() }, () => (calls += 1));
    expect(calls).toBe(1);
  });

  it('el resultado no lleva el contenido del documento en un fallo ni el hash de más', async () => {
    const w = await world();
    const fake = converter({ error: new ConversionError('corrupt', 'Archivo corrupto.') });
    const { result } = await importOfficeLocal(w.port, input(w.publica), { converter: fake });
    const out: OfficeImportSaved = result;
    expect(Object.keys(out).sort()).toEqual(['convertible', 'losses', 'original', 'outcome', 'reason']);
  });
});
