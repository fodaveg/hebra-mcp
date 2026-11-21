/**
 * C-07: los límites de Office medidos con un fixture de 25 MiB. Sin Docker: los topes, `file_too_large`
 * y el escritor ZIP. Con `HEBRA_FFLATE` (ruta a `node_modules/fflate` 0.8.3, que `hebra-mcp` aún no
 * declara: C-38) se comprueba además que `OFFICE_ZIP_LIMITS` rechaza antes de expandir. La medición en
 * contenedor solo corre con `HEBRA_MEDIR_MEMORIA=1` y, sin Docker, falla:
 *
 *   HEBRA_FFLATE=<ruta> HEBRA_MEDIR_MEMORIA=1 npx vitest run --maxWorkers=1 test/store/office-25mib.node.test.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sin tipos
import { generaFixture, writeZip } from '../../scripts/mem/office-25mib.mjs';
import {
  OFFICE_CONVERSION_RESERVE_BYTES,
  OFFICE_DATA_MAX_BYTES,
  OFFICE_FILE_ID_MAX_BYTES,
  OFFICE_ZIP_LIMITS
} from '../../src/server/tools/office-limits';
import { runImportOffice } from '../../src/server/tools/import-office';

const MIB = 1024 * 1024;
/** Los de `DEFAULT_ZIP_LIMITS` de Hebra (`zip-read.ts`): el comprobador del script los lee del código real. */
const DEFECTO = { maxArchiveBytes: 512 * MIB, maxEntries: 20_000, maxFileBytes: 128 * MIB, maxExpandedBytes: 512 * MIB, maxCompressionRatio: 200 };

function ctxConEscritor() {
  return {
    write: {
      importOffice: async () => {
        throw new Error('no debe llegar al escritor');
      }
    }
  } as unknown as Parameters<typeof runImportOffice>[0];
}

describe('office-limits (C-07)', () => {
  it('fileId admite 25 MiB, dataBase64 los 5 MiB del socket; el ZIP expandido, 12 MiB', () => {
    expect(OFFICE_FILE_ID_MAX_BYTES).toBe(25 * MIB);
    expect(OFFICE_DATA_MAX_BYTES).toBe(5 * MIB);
    expect(OFFICE_ZIP_LIMITS.maxArchiveBytes).toBe(OFFICE_FILE_ID_MAX_BYTES);
    expect(OFFICE_ZIP_LIMITS.maxExpandedBytes).toBe(12 * MIB);
    expect(OFFICE_ZIP_LIMITS.maxFileBytes).toBeLessThanOrEqual(OFFICE_ZIP_LIMITS.maxExpandedBytes);
  });

  it('ningún tope de Office supera el de defecto del lector y los de memoria son más estrictos', () => {
    for (const k of Object.keys(DEFECTO) as (keyof typeof DEFECTO)[]) {
      expect(OFFICE_ZIP_LIMITS[k], k).toBeLessThanOrEqual(DEFECTO[k]);
    }
    expect(OFFICE_ZIP_LIMITS.maxExpandedBytes).toBeLessThan(DEFECTO.maxExpandedBytes);
    expect(OFFICE_ZIP_LIMITS.maxFileBytes).toBeLessThan(DEFECTO.maxFileBytes);
  });

  it('la reserva por conversión es el peor caso medido: 451 MiB de RSS menos la base de 333', () => {
    expect(OFFICE_CONVERSION_RESERVE_BYTES).toBeGreaterThanOrEqual((451 - 333) * MIB);
    expect(333 * MIB + OFFICE_CONVERSION_RESERVE_BYTES).toBeLessThanOrEqual(460 * MIB);
  });

  it('un dataBase64 por encima del tope da file_too_large con el tope efectivo', async () => {
    const big = 'A'.repeat((Math.ceil(OFFICE_DATA_MAX_BYTES / 3) + 4) * 4);
    await expect(
      runImportOffice(ctxConEscritor(), { name: 'Libro.xlsx', dataBase64: big, operationId: 'op-1' })
    ).rejects.toMatchObject({ code: 'file_too_large', extra: { maxBytes: OFFICE_DATA_MAX_BYTES } });
  });
});

describe('escritor ZIP del fixture', () => {
  it('escribe un ZIP válido y determinista que mide lo pedido', () => {
    const zip = writeZip([
      { path: 'a.xml', data: Buffer.from('<a/>') },
      { path: 'b.bin', data: Buffer.from([1, 2, 3]), store: true }
    ]);
    // Fin de directorio central: dos entradas; la primera, deflate, se descomprime a su contenido.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const comprimido = zip.subarray(30 + 5, 30 + 5 + zip.readUInt32LE(18));
    expect(inflateRawSync(comprimido).toString()).toBe('<a/>');
    const fixture = generaFixture(1);
    expect(Math.abs(fixture.length - MIB)).toBeLessThan(1024);
    expect(generaFixture(1).equals(fixture)).toBe(true);
    const comprimible = generaFixture(1, 8);
    expect(Math.abs(comprimible.length - MIB)).toBeLessThan(1024);
    expect(generaFixture(1, 8).equals(comprimible)).toBe(true);
  });
});

describe.runIf(process.env.HEBRA_FFLATE !== undefined)('OFFICE_ZIP_LIMITS con el lector real', () => {
  it('rechaza antes de expandir un XML de 40 MiB que los topes de defecto aceptan', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hebra-mcp-c07-lim-'));
    try {
      const r = spawnSync(
        process.execPath,
        ['scripts/mem/office-25mib.mjs', 'comprobar-limites', '--tmp', tmp, '--fflate', process.env.HEBRA_FFLATE!],
        { encoding: 'utf8', cwd: process.cwd() }
      );
      expect(r.status, r.stderr).toBe(0);
      const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
      expect(res.derivados).toBe(true);
      expect(res.conOffice).toBe('El ZIP supera los límites de descompresión segura');
      expect(res.conDefecto).toBe('acepta'); // la negativa: con DEFAULT_ZIP_LIMITS no se rechaza
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.runIf(process.env.HEBRA_MEDIR_MEMORIA === '1')('medición en contenedor de 512 MiB', () => {
  it('un ZIP de 25 MiB con 12 MiB de XML: tres corridas sin OOM y maxRSS de 460 MiB o menos', () => {
    expect(spawnSync('docker', ['version'], { encoding: 'utf8' }).status, 'hace falta Docker').toBe(0);
    const fflate = process.env.HEBRA_FFLATE ?? '';
    expect(fflate, 'HEBRA_FFLATE: ruta a node_modules/fflate 0.8.3').not.toBe('');
    const tmp = mkdtempSync(join(tmpdir(), 'hebra-mcp-c07-'));
    try {
      const r = spawnSync(
        process.execPath,
        ['scripts/mem/office-25mib.mjs', 'medir', '--mib', '25', '--expandido-mib', String(OFFICE_ZIP_LIMITS.maxExpandedBytes / MIB),
          '--lista', '1', '--repite', '3', '--tmp', tmp, '--fflate', fflate],
        { encoding: 'utf8', cwd: process.cwd() }
      );
      const filas = r.stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l) as { codigo: number; maxRssMiB: number });
      expect(filas).toHaveLength(3);
      for (const f of filas) {
        expect(f.codigo).toBe(0);
        expect(f.maxRssMiB).toBeLessThanOrEqual(460);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 600_000);
});
