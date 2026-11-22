/**
 * H-79, "Hecho cuando: el fichero abre en LibreOffice". Oráculo con LibreOffice real por UNO
 * (`vendor/hebra/scripts/hojas/oraculo-uno.py`, el de H-06): abre el `.ods` que escribe
 * `hebra_create_sheet` con perfil propio, sin interfaz y sin macros, y vuelca lo que ve.
 *
 * Solo corre con `HEBRA_ORACULO=1`. Con la variable puesta, si falta `soffice`, `python3` o el
 * módulo `uno`, el test FALLA: no se omite. El script cierra LibreOffice también si falla, y el
 * perfil temporal se borra siempre.
 *
 * Prueba negativa del propio oráculo: un `.ods` con `content.xml` truncado no debe abrir, o el
 * oráculo no distingue un fichero roto de uno bueno.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSheetFile, DEFAULT_SHEET_NAME } from '../../src/server/tools/create-sheet';
import type { SheetCommand } from '../../src/sheets';

const ORACULO = process.env.HEBRA_ORACULO === '1';
const SCRIPT_UNO = join(process.cwd(), 'vendor/hebra/scripts/hojas/oraculo-uno.py');
const raiz = ORACULO ? mkdtempSync(join(tmpdir(), 'create-sheet-oraculo-')) : '';

afterAll(() => {
  if (raiz) rmSync(raiz, { recursive: true, force: true });
});

type Celda = { tipo: string; valor: unknown; formula?: string; mostrado: string };
type Volcado = { hojas: Record<string, { celdas: Record<string, Celda> }> };

/** Abre los bytes con LibreOffice y devuelve su volcado. Lanza si no abre. */
function abrir(nombre: string, bytes: Uint8Array): Volcado {
  const fichero = join(raiz, nombre);
  writeFileSync(fichero, bytes);
  const perfil = join(raiz, `perfil-${nombre}`);
  try {
    const salida = execFileSync('python3', ['-I', '-B', SCRIPT_UNO, fichero, '--perfil', perfil], {
      timeout: 180_000,
      encoding: 'utf8'
    });
    return JSON.parse(salida) as Volcado;
  } finally {
    rmSync(perfil, { recursive: true, force: true });
  }
}

const LOTE: SheetCommand[] = [
  { type: 'renameSheet', sheet: DEFAULT_SHEET_NAME, name: 'Ventas' },
  { type: 'setCells', sheet: 'Ventas', start: 'A1', rows: [['Mes', 'Importe'], ['Enero', 1200], ['Febrero', 1350], ['Total', '=SUM(B2:B3)']] },
  { type: 'setFormat', sheet: 'Ventas', range: 'B2:B4', format: { bold: 'true' } },
  { type: 'merge', sheet: 'Ventas', range: 'D1:E1', expect: { 'D1:E1': null } },
  { type: 'freeze', sheet: 'Ventas', rows: 1, cols: 0 },
  { type: 'addSheet', sheet: 'Resumen', as: 'resumen' },
  { type: 'setCells', sheet: '$resumen', start: 'A1', rows: [['Total ventas', '=Ventas!B4']] }
];

describe.runIf(ORACULO)('hebra_create_sheet contra LibreOffice', () => {
  it('el libro creado abre y LibreOffice ve sus hojas, valores y fórmulas calculadas', async () => {
    const built = await buildSheetFile(LOTE, new AbortController().signal);
    if ('code' in built) throw new Error(`el lote no compiló: ${built.code}`);
    const { hojas } = abrir('creado.ods', built.bytes);
    // El volcado de oraculo-uno.py sale con `sort_keys`: da qué hojas hay, no su orden.
    expect(Object.keys(hojas)).toEqual(['Resumen', 'Ventas']);
    expect(hojas.Ventas!.celdas.A1).toMatchObject({ tipo: 'texto', valor: 'Mes' });
    expect(hojas.Ventas!.celdas.B3).toMatchObject({ tipo: 'numero', valor: 1350 });
    // Sin caché: LibreOffice calcula al abrir (sonda S1 de H-06).
    expect(hojas.Ventas!.celdas.B4).toMatchObject({ tipo: 'formula', valor: 2550 });
    expect(hojas.Resumen!.celdas.B1).toMatchObject({ tipo: 'formula', valor: 2550 });
  }, 240_000);

  it('el libro vacío también abre', async () => {
    const built = await buildSheetFile([], new AbortController().signal);
    if ('code' in built) throw new Error('el libro vacío no se escribió');
    expect(Object.keys(abrir('vacio.ods', built.bytes).hojas)).toEqual([DEFAULT_SHEET_NAME]);
  }, 240_000);

  it('negativa: un .ods con content.xml truncado no abre', async () => {
    const { unzipSync, zipSync } = await import('fflate');
    const built = await buildSheetFile(LOTE, new AbortController().signal);
    if ('code' in built) throw new Error('el lote no compiló');
    const partes = unzipSync(built.bytes);
    const content = partes['content.xml']!;
    const roto = zipSync({
      mimetype: [partes['mimetype']!, { level: 0 }],
      'content.xml': content.subarray(0, Math.floor(content.length / 2)),
      'styles.xml': partes['styles.xml']!,
      'meta.xml': partes['meta.xml']!,
      'settings.xml': partes['settings.xml']!,
      'META-INF/manifest.xml': partes['META-INF/manifest.xml']!
    });
    expect(() => abrir('roto.ods', roto)).toThrow();
  }, 240_000);
});
