/**
 * `hebra_import_office` (C-25) contra un doble del escritor: esquema, base64, formatos
 * retirados, `preview`, privacidad de origen y destino, y que nada llega al escritor (ni al
 * almacén) si la entrada no vale. Los tipos del contrato son los del doble; C-36 los cambia.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../src/server/errors';
import {
  runImportOffice,
  type ImportOfficeInput,
  type OfficeImportOutcome,
  type OfficeImportWriteInput
} from '../../src/server/tools/import-office';
import { OFFICE_DATA_MAX_BYTES } from '../../src/server/tools/office-limits';
import { BAIT_FOLDER } from '../fixtures/test-library';
import { startLooseFiles, type LooseFilesHarness } from '../fixtures/loose-files';
import type { ToolContext } from '../../src/server/context';

const ZIP = Buffer.from('PK\u0003\u0004contenido-de-prueba');
const B64 = ZIP.toString('base64');

const CONVERTED: OfficeImportOutcome = {
  outcome: 'converted',
  convertible: true,
  losses: [{ kind: 'format:font', count: 2, label: 'Fuentes' }],
  convertedFile: { id: 'f-nuevo', name: 'Libro.ods', sha256: 'a'.repeat(64) },
  original: { id: 'f-orig', name: 'Libro.xlsx', sha256: 'b'.repeat(64) },
  sync: 'not_linked'
};

describe('hebra_import_office (C-25)', () => {
  let harness: LooseFilesHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** El contexto de prueba con un escritor de importación doble que registra lo recibido. */
  async function setup(outcome: OfficeImportOutcome | Error = CONVERTED) {
    harness = await startLooseFiles();
    const calls: OfficeImportWriteInput[] = [];
    const importOffice = vi.fn(async (input: OfficeImportWriteInput) => {
      calls.push(input);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const ctx = { ...harness.test.ctx, write: { ...harness.test.ctx.write!, importOffice } } as ToolContext;
    return { ctx, calls, importOffice };
  }

  /** El mismo contexto con un almacén que lanza al primer acceso: prueba que nada lo toca. */
  function untouched(ctx: ToolContext): ToolContext {
    const port = new Proxy({} as ToolContext['port'], {
      get() {
        throw new Error('el almacén no se toca');
      }
    });
    return { ...ctx, port };
  }

  async function expectCode(promise: Promise<unknown>, code: string): Promise<ToolError> {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe(code);
    return error as ToolError;
  }

  const valid: ImportOfficeInput = { name: 'Libro.xlsx', dataBase64: B64, operationId: 'op-1' };

  it('un xlsx en base64: llega al escritor con el modo por defecto y devuelve el contrato', async () => {
    const { ctx, calls } = await setup();
    const out = await runImportOffice(ctx, valid);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fileName: 'Libro.xlsx',
      format: 'xlsx',
      mode: 'convert-and-keep',
      preview: false,
      folderId: 'root',
      operationId: 'op-1'
    });
    expect(Buffer.from(calls[0]!.bytes).equals(ZIP)).toBe(true);
    expect(out).toEqual({ format: 'xlsx', mode: 'convert-and-keep', ...CONVERTED });
  });

  it('acepta pptx y docx, sin distinguir mayúsculas, y espacios y saltos en el base64', async () => {
    const { ctx, calls } = await setup();
    await runImportOffice(ctx, { ...valid, name: 'A.PPTX', dataBase64: `${B64.slice(0, 8)}\n ${B64.slice(8)}` });
    await runImportOffice(ctx, { ...valid, name: 'B.docx', mode: 'keep-only', operationId: 'op-2' });
    expect(calls.map((call) => [call.format, call.mode])).toEqual([
      ['pptx', 'convert-and-keep'],
      ['docx', 'keep-only']
    ]);
  });

  describe('la entrada se valida antes de tocar el almacén', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['ni dataBase64 ni fileId', { dataBase64: undefined }, 'invalid_input'],
      ['dataBase64 y fileId a la vez', { fileId: 'x' }, 'invalid_input'],
      ['sin name con dataBase64', { name: undefined }, 'invalid_input'],
      ['name con barra', { name: 'a/b.xlsx' }, 'invalid_input'],
      ['sin operationId', { operationId: undefined }, 'invalid_input'],
      ['operationId vacío', { operationId: '' }, 'invalid_input'],
      ['folder y folderId', { folder: 'Proyectos', folderId: 'root' }, 'invalid_input'],
      ['mode desconocido', { mode: 'otro' }, 'invalid_input'],
      ['base64 mal formado', { dataBase64: 'no es base64!' }, 'invalid_input'],
      ['base64 vacío', { dataBase64: '' }, 'invalid_input'],
      ['base64 con relleno raro', { dataBase64: 'QUJD=' }, 'invalid_input'],
      ['.doc retirado', { name: 'a.doc' }, 'unsupported_format'],
      ['.xls retirado', { name: 'a.xls' }, 'unsupported_format'],
      ['.ppt retirado', { name: 'a.ppt' }, 'unsupported_format'],
      ['otra extensión', { name: 'a.pdf' }, 'unsupported_format'],
      ['sin extensión', { name: 'a' }, 'unsupported_format']
    ];
    it.each(cases)('%s', async (_label, patch, code) => {
      const { ctx, importOffice } = await setup();
      await expectCode(runImportOffice(untouched(ctx), { ...valid, ...patch } as ImportOfficeInput), code);
      expect(importOffice).not.toHaveBeenCalled();
    });

    it('sin eco: el error no lleva la entrada', async () => {
      const { ctx } = await setup();
      const error = await expectCode(
        runImportOffice(ctx, { ...valid, name: 'secreto-no-eco.doc' }),
        'unsupported_format'
      );
      expect(JSON.stringify([error.message, error.extra])).not.toContain('secreto');
    });

    it('más del tope: file_too_large con tamaño y tope, antes de decodificar', async () => {
      const { ctx, importOffice } = await setup();
      const big = 'A'.repeat((Math.ceil(OFFICE_DATA_MAX_BYTES / 3) + 4) * 4);
      const error = await expectCode(
        runImportOffice(untouched(ctx), { ...valid, dataBase64: big }),
        'file_too_large'
      );
      expect(error.extra).toMatchObject({ maxBytes: OFFICE_DATA_MAX_BYTES });
      expect(importOffice).not.toHaveBeenCalled();
    });

    it('sin escritor de importación: invalid_input', async () => {
      harness = await startLooseFiles();
      await expectCode(runImportOffice(harness.test.ctx, valid), 'invalid_input');
    });
  });

  describe('preview', () => {
    it('no pide operationId ni escribe: se lo pasa al escritor como preview', async () => {
      const { ctx, calls } = await setup({
        outcome: 'preview',
        convertible: false,
        reason: 'encrypted',
        losses: []
      });
      const out = await runImportOffice(ctx, { name: 'Libro.xlsx', dataBase64: B64, preview: true });
      expect(calls[0]).toMatchObject({ preview: true });
      expect(calls[0]).not.toHaveProperty('operationId');
      expect(out).toEqual({
        format: 'xlsx',
        mode: 'convert-and-keep',
        outcome: 'preview',
        convertible: false,
        reason: 'encrypted',
        losses: []
      });
    });

    it('un operationId inválido sigue rechazándose', async () => {
      const { ctx } = await setup();
      await expectCode(
        runImportOffice(ctx, { name: 'L.xlsx', dataBase64: B64, preview: true, operationId: '' }),
        'invalid_input'
      );
    });
  });

  describe('destino y origen', () => {
    it('una carpeta pública por ruta o por id llega como folderId', async () => {
      const { ctx, calls } = await setup();
      const proyectos = harness!.test.library.folders.proyectos;
      await runImportOffice(ctx, { ...valid, folder: 'Proyectos' });
      await runImportOffice(ctx, { ...valid, folderId: proyectos, operationId: 'op-2' });
      expect(calls.map((call) => call.folderId)).toEqual([proyectos, proyectos]);
    });

    it('carpeta privada, inexistente o ruta desconocida: not_found sin llegar al escritor', async () => {
      const { ctx, importOffice } = await setup();
      const { folders } = harness!.test.library;
      await expectCode(runImportOffice(ctx, { ...valid, folderId: folders.diario }), 'not_found');
      await expectCode(runImportOffice(ctx, { ...valid, folderId: folders.diario2026 }), 'not_found');
      await expectCode(runImportOffice(ctx, { ...valid, folderId: 'no-existe' }), 'not_found');
      await expectCode(runImportOffice(ctx, { ...valid, folder: 'Diario' }), 'not_found');
      expect(importOffice).not.toHaveBeenCalled();
    });

    it('fileId visible: sus bytes y su carpeta llegan al escritor', async () => {
      const { ctx, calls } = await setup();
      const id = await harness!.engineFile(harness!.test.library.folders.proyectos, 'Plan.xlsx', ZIP);
      await runImportOffice(ctx, { fileId: id, operationId: 'op-f' });
      expect(calls[0]).toMatchObject({
        fileName: 'Plan.xlsx',
        format: 'xlsx',
        sourceFileId: id,
        folderId: harness!.test.library.folders.proyectos
      });
      expect(Buffer.from(calls[0]!.bytes).equals(ZIP)).toBe(true);
    });

    it('fileId oculto, de la papelera o inexistente: not_found sin eco del cebo', async () => {
      const { ctx, importOffice } = await setup();
      const { files } = harness!.test.library;
      for (const id of [files.privateFolder, files.referencedByHash, files.trashed, files.tombstone, 'no-existe']) {
        const error = await expectCode(runImportOffice(ctx, { fileId: id, operationId: 'op-f' }), 'not_found');
        expect(JSON.stringify(error.extra ?? {})).not.toContain(BAIT_FOLDER);
      }
      expect(importOffice).not.toHaveBeenCalled();
    });

    it('fileId visible que no es Office: unsupported_format', async () => {
      const { ctx, importOffice } = await setup();
      await expectCode(
        runImportOffice(ctx, { fileId: harness!.test.library.files.acta, operationId: 'op-f' }),
        'unsupported_format'
      );
      expect(importOffice).not.toHaveBeenCalled();
    });
  });

  describe('errores del escritor', () => {
    it('un ToolError del escritor sale tal cual (p. ej. espacio de solo lectura)', async () => {
      const { ctx } = await setup(new ToolError('space_access_denied'));
      await expectCode(runImportOffice(ctx, valid), 'space_access_denied');
    });

    it('not_found del escritor dentro del turno', async () => {
      const { ctx } = await setup(new ToolError('not_found'));
      await expectCode(runImportOffice(ctx, valid), 'not_found');
    });

    it('un reintento (replayed) y el estado de sync salen en la respuesta', async () => {
      const { ctx } = await setup({ ...CONVERTED, replayed: true, sync: 'pending' });
      expect(await runImportOffice(ctx, valid)).toMatchObject({ replayed: true, sync: 'pending' });
    });
  });

  it('el log no lleva nombre, hash ni contenido', async () => {
    const { ctx } = await setup();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await runImportOffice(ctx, valid);
    } finally {
      spy.mockRestore();
    }
    const log = lines.join('');
    expect(log).toContain('import.office');
    expect(log).not.toContain('Libro');
    expect(log).not.toContain('a'.repeat(64));
    expect(log).not.toContain(B64);
  });
});
