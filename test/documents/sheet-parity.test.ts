/**
 * H-82 (plan de hojas, S-05): paridad del motor de fórmulas entre la app y el MCP. El mismo lote
 * de `SheetOp`, sobre el mismo `.ods`, debe dar los mismos resultados en los dos.
 *
 * Los dos lados, con las piezas reales:
 * - App: `openSheetController` de `vendor/hebra` (el que abre el editor de `.ods`) con
 *   `createBrowserFormulaEngine` y la proyección de los ajustes del libro. El Worker es falso pero
 *   el módulo que corre dentro es `engine.worker.ts` tal cual: se evalúa uno nuevo por cada Worker,
 *   los mensajes pasan por `structuredClone` como por `postMessage`, y el wasm se carga por `fetch`
 *   con la URL que pone Vite, como en el navegador. Los cambios del documento salen por el puerto
 *   de la sesión, que es lo que guarda la app.
 * - MCP: lo que la app guardó (andamiaje y pendientes) leído como lo leen `hebra_read_sheet`
 *   (`runReadSheetJob`) y `hebra_edit_sheet` (`createNodeFormulaEngine` en su hilo, cargado con
 *   `createSheetEngineProjection(settings).book(modelo)` y los ajustes del libro). El hilo es
 *   `src/sheet-engine-worker.ts` empaquetado con esbuild, como `dist/sheet-engine-worker.mjs`.
 *
 * Qué se compara:
 * - Las 195 funciones de `FUNCTION_NAMES`, escritas en español (punto y coma, coma decimal) como
 *   las teclea la persona, en un libro `es-ES` y en uno `en-US`. Valor y tipo de cada celda; las
 *   volátiles (`RAND`, `NOW`...) por su forma y su margen.
 * - Casos de fórmula sueltos: errores, referencias entre hojas (con espacios y con un nombre que
 *   IronCalc no admite), fechas, región (decimales, `TEXT`, `VALUE`) y matrices que se derraman.
 * - Cada tipo de `SheetOp` (`SHEET_OP_TYPES`) con un lote propio o una exclusión escrita: la app
 *   lleva el motor al día con ediciones (`advance`) y el MCP carga el libro entero de después.
 *
 * Una diferencia de paridad solo se acepta escrita en `DIFERENCIAS` con lo medido en cada lado y
 * su motivo. Si deja de darse, el test falla para que se quite la nota.
 *
 * Pruebas negativas dentro del fichero: el libro en otra región solo en el MCP rompe la paridad
 * (exactamente en las funciones que dependen de la región), un tipo de operación nuevo sin caso
 * rompe la tabla y un valor alterado en un lado da diferencia. Las hechas a mano sobre el código
 * del MCP se cuentan en el informe de H-82.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { runReadSheetJob, type ReadCellValue, type ReadSheetJobInput } from '../../src/server/tools/read-sheet-job';
import { scopeOf } from '../../src/server/tools/sheet-read';
import {
  compileBatch,
  createNodeFormulaEngine,
  createSheetAdapter,
  createSheetEngineProjection,
  prepareSheetBase,
  SHEET_OP_TYPES,
  type BookEngineSettings,
  type CanonFormula,
  type EngineCell,
  type FormulaEngineWithValues,
  type GridRange,
  type SheetAdapter,
  type SheetModel,
  type SheetOp,
  type SheetOpType
} from '../../src/sheets';
import { createDocSession } from '../../vendor/hebra/src/lib/documents/session';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { createMemoryAtomicPort } from '../../vendor/hebra/src/lib/sheets/contracts/doubles';
import { isFormulaParseError } from '../../vendor/hebra/src/lib/sheets/contracts/locale';
import { openSheetController, type LiveSheetController } from '../../vendor/hebra/src/lib/sheets/controller';
import type { EngineRequest, EngineResponse } from '../../vendor/hebra/src/lib/sheets/engine/ironcalc-engine';
import { createFormulaLocale } from '../../vendor/hebra/src/lib/sheets/formula/locale';
import { FUNCTION_NAMES } from '../../vendor/hebra/src/lib/sheets/formula/names-es-en';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_DIR = join(ROOT, 'vendor', 'hebra', 'src', 'lib', 'sheets', 'engine');
const WASM_PATH = createRequire(import.meta.url).resolve('@ironcalc/wasm/wasm_bg.wasm');
const FILE_ID = 'libro-h82';
const GENERATION = 'g-h82';
const live = () => new AbortController().signal;
const huella = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// --- Libro de prueba --------------------------------------------------------------------------

/**
 * Partes del `.ods` de prueba de Hebra (`buildOds`): el libro de aquí conserva su paquete
 * (manifiesto, espacios de nombres, metadatos) y cambia el cuerpo y la lengua por defecto.
 */
const FIXTURE = unzipSync(buildOds());
const FILAS = 400;
const COLUMNAS = 24;

type Dato = number | string | null;
/** Datos de `Hoja1`, por columna desde la fila 1. Las fórmulas van en K, L y M. */
const DATOS: Record<string, readonly Dato[]> = {
  A: [3, 1, 4, 1, 5, 9],
  B: [2, 7, 1, 8, 2, 8],
  C: ['alfa', 'beta', 'gamma', 'alfa'],
  D: [45292, 45657, 46023],
  F: [1, 2, 3, 4],
  G: ['uno', 'dos', 'tres', 'cuatro'],
  J: [-100, 60, 60]
};
/** Hojas además de `Hoja1`: una con espacios y otra con un nombre que IronCalc 0.9.1 rechaza. */
const OTRAS: readonly { name: string; values: readonly number[] }[] = [
  { name: 'Hoja2', values: [7, 8, 9] },
  { name: 'Hoja con espacio', values: [11] },
  { name: 'Datos [2026]', values: [13] }
];

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function celda(v: Dato | undefined): string {
  if (v === null || v === undefined) return '<table:table-cell/>';
  const tipo = typeof v === 'number' ? `office:value-type="float" office:value="${v}"` : 'office:value-type="string"';
  return `<table:table-cell ${tipo}><text:p>${typeof v === 'number' ? v : xml(v)}</text:p></table:table-cell>`;
}

function tabla(name: string, rows: readonly (readonly Dato[])[]): string {
  const filas = rows.map((r) => `<table:table-row>${r.map(celda).join('')}</table:table-row>`).join('');
  const resto = `<table:table-row table:number-rows-repeated="${FILAS - rows.length}"><table:table-cell table:number-columns-repeated="${COLUMNAS}"/></table:table-row>`;
  return `<table:table table:name="${xml(name)}"><table:table-column table:number-columns-repeated="${COLUMNAS}"/>${filas}${resto}</table:table>`;
}

/** `.ods` con la lengua del estilo de celda por defecto (`es-ES`, `en-US`), la que lee `readBookSettings`. */
function libro(lengua: { language: string; country: string }): Uint8Array {
  const letras = Object.keys(DATOS).sort();
  const alto = Math.max(...letras.map((l) => DATOS[l].length));
  const hoja1 = Array.from({ length: alto }, (_, r) =>
    Array.from({ length: 10 }, (_, c) => DATOS[String.fromCharCode(65 + c)]?.[r] ?? null)
  );
  const tablas = tabla('Hoja1', hoja1) + OTRAS.map((o) => tabla(o.name, o.values.map((v) => [v]))).join('');
  const content = strFromU8(FIXTURE['content.xml']).replace(
    /<office:spreadsheet>[\s\S]*<\/office:spreadsheet>/,
    () => `<office:spreadsheet>${tablas}</office:spreadsheet>`
  );
  const porDefecto = `<style:default-style style:family="table-cell"><style:text-properties fo:language="${lengua.language}" fo:country="${lengua.country}"/></style:default-style>`;
  const styles = strFromU8(FIXTURE['styles.xml']).replace('<office:styles>', `<office:styles>${porDefecto}`);
  const mtime = Date.UTC(2020, 0, 1);
  const partes: Record<string, [Uint8Array, { level: 0 | 6; mtime: number }]> = {};
  for (const [ruta, bytes] of Object.entries(FIXTURE)) {
    const nuevo = ruta === 'content.xml' ? strToU8(content) : ruta === 'styles.xml' ? strToU8(styles) : bytes;
    partes[ruta] = [nuevo, { level: ruta === 'mimetype' ? 0 : 6, mtime }];
  }
  return zipSync(partes);
}

const LIBRO_ES = libro({ language: 'es', country: 'ES' });
const LIBRO_EN = libro({ language: 'en', country: 'US' });

// --- Las 195 funciones, en español ------------------------------------------------------------

/** [función de `FUNCTION_NAMES` en inglés, fórmula como la escribe la persona en español]. */
type Caso = readonly [fn: string, es: string];

/**
 * Una fila por función. Las que devuelven una matriz se reducen a un valor (`INDICE`, `SUMA`), para
 * que cada caso ocupe su celda. `ESFORMULA` mira K1, la celda del primer caso.
 */
const CASOS: readonly Caso[] = [
  ['SUM', '=SUMA(A1:A6;10)'],
  ['SUMIF', '=SUMAR.SI(A1:A6;">=4")'],
  ['SUMIFS', '=SUMAR.SI.CONJUNTO(B1:B6;A1:A6;">2";B1:B6;"<=8")'],
  ['SUMPRODUCT', '=SUMAPRODUCTO(A1:A6;B1:B6)'],
  ['PRODUCT', '=PRODUCTO(A1:A4)'],
  ['ABS', '=ABS(-3,25)'],
  ['ROUND', '=REDONDEAR(3,14159;3)'],
  ['ROUNDUP', '=REDONDEAR.MAS(3,141;1)'],
  ['ROUNDDOWN', '=REDONDEAR.MENOS(3,149;2)'],
  ['INT', '=ENTERO(-7,2)'],
  ['TRUNC', '=TRUNCAR(-7,29;1)'],
  ['MOD', '=RESIDUO(17;-5)'],
  ['POWER', '=POTENCIA(1,5;3)'],
  ['SQRT', '=RAIZ(2)'],
  ['RAND', '=ALEATORIO()'],
  ['RANDBETWEEN', '=ALEATORIO.ENTRE(5;9)'],
  ['SUBTOTAL', '=SUBTOTALES(1;A1:A6)'],
  ['IF', '=SI(B2>5;"mucho";"poco")'],
  ['IFS', '=SI.CONJUNTO(A6<5;"bajo";A6<10;"medio")'],
  ['AND', '=Y(A1>1;B1<3)'],
  ['OR', '=O(A1>5;B1>5)'],
  ['NOT', '=NO(A2=1)'],
  ['IFERROR', '=SI.ERROR(RAIZ(-4);"sin raiz")'],
  ['IFNA', '=SI.ND(COINCIDIR(42;A1:A6;0);"falta")'],
  ['SWITCH', '=CAMBIAR(A3;1;"uno";4;"cuatro";"otro")'],
  ['TRUE', '=VERDADERO()'],
  ['FALSE', '=FALSO()'],
  ['VLOOKUP', '=BUSCARV(2;F1:G4;2;FALSO)'],
  ['HLOOKUP', '=BUSCARH(45292;A1:F3;3;FALSO)'],
  ['XLOOKUP', '=BUSCARX("tres";G1:G4;F1:F4)'],
  ['INDEX', '=INDICE(A1:B6;4;2)'],
  ['MATCH', '=COINCIDIR(9;A1:A6;0)'],
  ['CHOOSE', '=ELEGIR(3;"a";"b";"c")'],
  ['ROW', '=FILA(B7)'],
  ['ROWS', '=FILAS(A2:C9)'],
  ['COLUMN', '=COLUMNA(E1)'],
  ['COLUMNS', '=COLUMNAS(B1:F1)'],
  ['HYPERLINK', '=HIPERVINCULO("https://hebra.example/";"Hebra")'],
  ['CONCAT', '=CONCAT(C1;"-";A6)'],
  ['CONCATENATE', '=CONCATENAR("x";C2;"y")'],
  ['TEXTJOIN', '=UNIRCADENAS(", ";VERDADERO;C1:C6)'],
  ['LEFT', '=IZQUIERDA("hojas de calculo";5)'],
  ['RIGHT', '=DERECHA("hojas de calculo";6)'],
  ['MID', '=EXTRAE("hojas de calculo";7;2)'],
  ['LEN', '=LARGO("año")'],
  ['LOWER', '=MINUSC("ÁRBOL Ñ")'],
  ['UPPER', '=MAYUSC("árbol ñ")'],
  ['PROPER', '=NOMPROPIO("josé de la peña")'],
  ['TRIM', '=ESPACIOS("   hola    mundo ")'],
  ['FIND', '=ENCONTRAR("a";"banana";3)'],
  ['SEARCH', '=HALLAR("N";"banana")'],
  ['REPLACE', '=REEMPLAZAR("2026-11-22";5;1;"/")'],
  ['SUBSTITUTE', '=SUSTITUIR("1.234.567";".";"")'],
  ['TEXT', '=TEXTO(1234,567;"0.0")'],
  ['VALUE', '=VALOR("42")'],
  ['DATE', '=FECHA(2026;11;22)'],
  ['TIME', '=NSHORA(18;45;30)'],
  ['TODAY', '=HOY()'],
  ['NOW', '=AHORA()'],
  ['YEAR', '=AÑO(D2)'],
  ['MONTH', '=MES(D3)'],
  ['DAY', '=DIA(D3)'],
  ['HOUR', '=HORA(0,6)'],
  ['MINUTE', '=MINUTO(0,6)'],
  ['SECOND', '=SEGUNDO(NSHORA(1;2;3))'],
  ['WEEKDAY', '=DIASEM(D2;2)'],
  ['EDATE', '=FECHA.MES(D1;-2)'],
  ['EOMONTH', '=FIN.MES(D1;1)'],
  ['DATEDIF', '=SIFECHA(D1;D3;"m")'],
  ['DAYS', '=DIAS(D3;D1)'],
  ['NETWORKDAYS', '=DIAS.LAB(D1;D1+30)'],
  ['WORKDAY', '=DIA.LAB(D1;10)'],
  ['AVERAGE', '=PROMEDIO(B1:B6)'],
  ['AVERAGEIF', '=PROMEDIO.SI(B1:B6;">5")'],
  ['AVERAGEIFS', '=PROMEDIO.SI.CONJUNTO(A1:A6;B1:B6;">2";A1:A6;"<9")'],
  ['COUNT', '=CONTAR(A1:D6)'],
  ['COUNTA', '=CONTARA(A1:D6)'],
  ['COUNTBLANK', '=CONTAR.BLANCO(C1:C6)'],
  ['COUNTIF', '=CONTAR.SI(C1:C6;"alfa")'],
  ['COUNTIFS', '=CONTAR.SI.CONJUNTO(A1:A6;"<5";B1:B6;">1")'],
  ['MAX', '=MAX(A1:A6;B1:B6)'],
  ['MIN', '=MIN(B1:B6)'],
  ['MAXIFS', '=MAX.SI.CONJUNTO(A1:A6;B1:B6;">5")'],
  ['MINIFS', '=MIN.SI.CONJUNTO(B1:B6;A1:A6;">3")'],
  ['MEDIAN', '=MEDIANA(B1:B6)'],
  ['LARGE', '=K.ESIMO.MAYOR(B1:B6;3)'],
  ['SMALL', '=K.ESIMO.MENOR(B1:B6;3)'],
  ['ISBLANK', '=ESBLANCO(C5)'],
  ['ISNUMBER', '=ESNUMERO(C1)'],
  ['ISTEXT', '=ESTEXTO(G2)'],
  ['ISERROR', '=ESERROR(A1/0)'],
  ['ISNA', '=ESNOD(BUSCARV(99;F1:G4;2;FALSO))'],
  ['NA', '=NOD()'],
  ['PMT', '=PAGO(0,04/12;24;-5000)'],
  ['PV', '=VA(0,03;5;-200)'],
  ['FV', '=VF(0,03;5;-200)'],
  ['NPV', '=VNA(0,08;J1:J3)'],
  ['IRR', '=TIR(J1:J3)'],
  ['RATE', '=TASA(10;-100;800)'],
  ['NPER', '=NPER(0,05;-100;800)'],
  ['MROUND', '=REDOND.MULT(17;5)'],
  ['CEILING', '=MULTIPLO.SUPERIOR(7,3;0,5)'],
  ['FLOOR', '=MULTIPLO.INFERIOR(7,3;0,5)'],
  ['EXP', '=EXP(2,5)'],
  ['LN', '=LN(2)'],
  ['LOG', '=LOG(81;3)'],
  ['LOG10', '=LOG10(0,001)'],
  ['PI', '=PI()*2'],
  ['SIGN', '=SIGNO(-0,5)'],
  ['QUOTIENT', '=COCIENTE(-17;5)'],
  ['GCD', '=M.C.D(48;180)'],
  ['LCM', '=M.C.M(4;6;10)'],
  ['FACT', '=FACT(10)'],
  ['COMBIN', '=COMBINAT(10;3)'],
  ['AGGREGATE', '=AGREGAR(4;6;A1:A6)'],
  ['SIN', '=SENO(1)'],
  ['COS', '=COS(1)'],
  ['TAN', '=TAN(1)'],
  ['ASIN', '=ASENO(0,5)'],
  ['ACOS', '=ACOS(0,5)'],
  ['ATAN', '=ATAN(2)'],
  ['ATAN2', '=ATAN2(-1;1)'],
  ['DEGREES', '=GRADOS(1)'],
  ['RADIANS', '=RADIANES(90)'],
  ['EVEN', '=REDONDEA.PAR(-2,5)'],
  ['ODD', '=REDONDEA.IMPAR(2,5)'],
  ['XOR', '=XO(VERDADERO;VERDADERO;VERDADERO)'],
  ['LET', '=LET(base;A6;base*base+1)'],
  ['FILTER', '=SUMA(FILTRAR(B1:B6;A1:A6<4))'],
  ['SORT', '=INDICE(ORDENAR(B1:B6);2)'],
  ['SORTBY', '=INDICE(ORDENARPOR(C1:C4;F1:F4;-1);1)'],
  ['UNIQUE', '=FILAS(UNICOS(C1:C4))'],
  ['SEQUENCE', '=SUMA(SECUENCIA(3;2;10;5))'],
  ['TRANSPOSE', '=FILAS(TRANSPONER(A1:F1))'],
  ['LOOKUP', '=BUSCAR(3;F1:F4;G1:G4)'],
  ['XMATCH', '=COINCIDIRX(8;B1:B6;0;-1)'],
  ['OFFSET', '=SUMA(DESREF(A1;1;1;2;1))'],
  ['INDIRECT', '=INDIRECTO("B"&2)'],
  ['ADDRESS', '=DIRECCION(3;4;4)'],
  ['CLEAN', '=LARGO(LIMPIAR("x"&CARACTER(10)&"y"))'],
  ['REPT', '=REPETIR("-=";3)'],
  ['EXACT', '=IGUAL("Hoja";"hoja")'],
  ['CHAR', '=CARACTER(97)'],
  ['CODE', '=CODIGO("z")'],
  ['UNICHAR', '=UNICAR(241)'],
  ['UNICODE', '=UNICODE("ñ")'],
  ['FIXED', '=DECIMAL(9876,543;2)'],
  ['DOLLAR', '=MONEDA(-9876,5;1)'],
  ['NUMBERVALUE', '=VALOR.NUMERO("2.500,75";",";".")'],
  ['TEXTBEFORE', '=TEXTOANTES("clave=valor";"=")'],
  ['TEXTAFTER', '=TEXTODESPUES("clave=valor";"=")'],
  ['TEXTSPLIT', '=INDICE(DIVIDIRTEXTO("a;b;c";";");1;3)'],
  ['WEEKNUM', '=NUM.DE.SEMANA(D2)'],
  ['ISOWEEKNUM', '=ISO.NUM.DE.SEMANA(D2)'],
  ['DAYS360', '=DIAS360(D1;D2)'],
  ['NETWORKDAYS.INTL', '=DIAS.LAB.INTL(D1;D1+13;"0000011")'],
  ['WORKDAY.INTL', '=DIA.LAB.INTL(D1;3;7)'],
  ['YEARFRAC', '=FRAC.AÑO(D1;D2;1)'],
  ['DATEVALUE', '=FECHANUMERO("2026-11-22")'],
  ['TIMEVALUE', '=HORANUMERO("18:45:30")'],
  ['MODE.SNGL', '=MODA.UNO(B1:B6)'],
  ['RANK.EQ', '=JERARQUIA.EQV(7;B1:B6;1)'],
  ['PERCENTILE.INC', '=PERCENTIL.INC(B1:B6;0,9)'],
  ['QUARTILE.INC', '=CUARTIL.INC(B1:B6;3)'],
  ['STDEV.S', '=DESVEST.M(B1:B6)'],
  ['STDEV.P', '=DESVEST.P(B1:B6)'],
  ['VAR.S', '=VAR.S(B1:B6)'],
  ['VAR.P', '=VAR.P(B1:B6)'],
  ['CORREL', '=COEF.DE.CORREL(B1:B6;A1:A6)'],
  ['SLOPE', '=PENDIENTE(A1:A6;B1:B6)'],
  ['INTERCEPT', '=INTERSECCION.EJE(A1:A6;B1:B6)'],
  ['FORECAST.LINEAR', '=PRONOSTICO.LINEAL(10;A1:A6;B1:B6)'],
  ['NORM.DIST', '=DISTR.NORM.N(1;0;1;FALSO)'],
  ['NORM.INV', '=INV.NORM(0,975;0;1)'],
  ['ISERR', '=ESERR(NOD())'],
  ['ISLOGICAL', '=ESLOGICO(A1>1)'],
  ['ISFORMULA', '=ESFORMULA(K1)'],
  ['ISEVEN', '=ES.PAR(A6)'],
  ['ISODD', '=ES.IMPAR(A6)'],
  ['ISNONTEXT', '=ESNOTEXTO(C1)'],
  ['ISREF', '=ESREF(Hoja2!A1)'],
  ['N', '=N(VERDADERO)'],
  ['TYPE', '=TIPO(C1)'],
  ['ERROR.TYPE', '=TIPO.DE.ERROR(NOD())'],
  ['SHEET', '=HOJA()'],
  ['SHEETS', '=HOJAS()'],
  ['IPMT', '=PAGOINT(0,05;2;4;-1000)'],
  ['PPMT', '=PAGOPRIN(0,05;2;4;-1000)'],
  ['XNPV', '=VNA.NO.PER(0,08;J1:J3;D1:D3)'],
  ['XIRR', '=TIR.NO.PER(J1:J3;D1:D3)'],
  ['SLN', '=SLN(5000;500;6)'],
  ['DB', '=DB(5000;500;6;2)'],
  ['DDB', '=DDB(5000;500;6;2)'],
  ['EFFECT', '=INT.EFECTIVO(0,06;12)'],
  ['NOMINAL', '=TASA.NOMINAL(0,0617;12)']
];

/** Las que cambian en cada cálculo: se comparan por su forma, no por su valor. */
const VOLATILES: Record<string, (app: number, mcp: number) => boolean> = {
  RAND: (a, b) => [a, b].every((v) => v >= 0 && v < 1),
  RANDBETWEEN: (a, b) => [a, b].every((v) => Number.isInteger(v) && v >= 5 && v <= 9),
  // Un minuto de margen: los dos cálculos se hacen con segundos de diferencia, y una zona horaria
  // distinta en un lado lo pasaría de largo.
  NOW: (a, b) => Math.abs(a - b) < 1 / 1440,
  // Dos cálculos a ambos lados de la medianoche UTC dan días seguidos.
  TODAY: (a, b) => Number.isInteger(a) && Number.isInteger(b) && Math.abs(a - b) <= 1
};

/** Casos de fórmula sueltos, en la columna L. `CIRCULAR` se mira a sí misma (L1). */
const SUELTOS: readonly Caso[] = [
  ['CIRCULAR', '=L1+1'],
  ['DIV0', '=1/0'],
  ['VALOR_ERR', '="a"+1'],
  ['REF_ERR', '=INDIRECTO("NoExiste!A1")'],
  ['NOMBRE_ERR', '=NOEXISTE(1)'],
  ['NUM_ERR', '=RAIZ(-1)'],
  ['ND_ERR', '=BUSCARV(99;F1:G4;2;FALSO)'],
  ['ERROR_LITERAL', '=#¡REF!'],
  ['ERROR_PROPAGADO', '=SUMA(A1:A6)+1/0'],
  ['HOJA2', '=Hoja2!A1*2'],
  ['HOJA2_RANGO', '=SUMA(Hoja2!A1:A3)'],
  ['HOJA_ESPACIO', "='Hoja con espacio'!A1+1"],
  ['HOJA_NOMBRE_RARO', "='Datos [2026]'!A1*3"],
  ['HOJA_INDIRECTA', '=INDIRECTO("Hoja2!A2")'],
  ['HOJA_MEZCLA', '=Hoja2!A3+A6+K1'],
  ['FECHA_BISIESTA', '=FECHA(2024;2;29)'],
  ['FECHA_DESBORDA', '=FECHA(2024;13;1)'],
  ['FECHA_TEXTO_ES', '=FECHANUMERO("29/02/2024")'],
  ['FECHA_TEXTO_ISO', '=FECHANUMERO("2024-02-29")'],
  ['FECHA_FORMATO', '=TEXTO(FECHA(2024;2;29);"dd/mm/yyyy")'],
  ['FECHA_MES_LARGO', '=TEXTO(D1;"mmmm")'],
  ['FECHA_SEMANA', '=DIASEM(FECHA(2024;2;29);2)'],
  ['FECHA_FIN_FEBRERO', '=FIN.MES(FECHA(2024;1;31);1)'],
  ['HORA_DESBORDA', '=NSHORA(25;0;0)'],
  ['HORA_TEXTO', '=HORANUMERO("18:30")'],
  ['FECHA_RESTA', '=D2-D1'],
  ['DECIMAL_COMA', '=1,5+2'],
  ['VALOR_COMA', '=VALOR("1,5")'],
  ['VALOR_PUNTO', '=VALOR("1.5")'],
  ['TEXTO_MILES_ES', '=TEXTO(1234,5;"#.##0,00")'],
  ['TEXTO_MILES_EN', '=TEXTO(1234,5;"#,##0.00")'],
  ['TEXTO_PORCIENTO', '=TEXTO(0,125;"0,0%")'],
  ['NUMERO_A_TEXTO', '=1,5&""'],
  ['PUNTO_Y_COMA_EN_CADENA', '=CONCAT("a;b";"c")'],
  ['MATRIZ_EN_LINEA', '=SUMA({1\\2\\3;4\\5\\6})'],
  ['COMPARA_TEXTO', '="a"<"B"'],
  ['LOGICO_A_NUMERO', '=VERDADERO+1'],
  ['VACIA', '=C6'],
  ['VACIA_TEXTO', '=C6&""']
];

/** Matrices que se derraman, en la columna N: el ancla en la fila de su caso y lo derramado debajo. */
const DERRAMES: readonly Caso[] = [
  ['SECUENCIA', '=SECUENCIA(3)'],
  ['ORDENAR', '=ORDENAR(A1:A3)']
];
const FILA_DERRAME = (i: number) => i * 4;

// --- Diferencias de paridad escritas -----------------------------------------------------------

/** Una diferencia medida entre app y MCP, con lo que da cada lado (texto de `describir`) y por qué. */
type Diferencia = { app: string; mcp: string; motivo: string };
/**
 * Por etiqueta de caso o por `celda@caso`. No queda ninguna: las cuatro celdas derramadas
 * (`N2`, `N3`, `N6` y `N7`) que el MCP leía como vacías las arregló H-SPILL. Una nueva va aquí
 * con lo medido en cada lado y su motivo.
 */
const DIFERENCIAS: Record<string, Diferencia> = {};

// --- Valores comparables ------------------------------------------------------------------------

type Valor = null | boolean | number | string | { error: string };

function describir(v: Valor | undefined): string {
  if (v === undefined) return 'sin celda';
  if (v === null) return 'vacía';
  if (typeof v === 'object') return `error ${v.error}`;
  if (typeof v === 'number') return `num ${v}`;
  if (typeof v === 'string') return `str ${JSON.stringify(v)}`;
  return `bool ${v}`;
}

/** Valor de una celda leída del motor: el error va por `shown`, como lo enseña la rejilla. */
function valorDeCelda(cell: EngineCell | undefined): Valor {
  if (!cell || cell.kind === 'empty') return null;
  if (cell.kind === 'error') return { error: cell.shown };
  return cell.value ?? null;
}

const valorDeLectura = (v: ReadCellValue | undefined): Valor => (v === undefined ? null : v);

/** Diferencias entre dos medidas, salvo las escritas. Una escrita que ya no se da también falla. */
function diferencias(
  etiquetas: readonly string[],
  app: readonly Valor[],
  mcp: readonly Valor[],
  escritas: Record<string, Diferencia> = DIFERENCIAS
): string[] {
  const fallos: string[] = [];
  etiquetas.forEach((etiqueta, i) => {
    const a = app[i];
    const b = mcp[i];
    const volatil = VOLATILES[etiqueta] as ((app: number, mcp: number) => boolean) | undefined;
    const iguales =
      volatil && typeof a === 'number' && typeof b === 'number'
        ? volatil(a, b)
        : describir(a) === describir(b);
    const nota = escritas[etiqueta];
    if (iguales) {
      if (nota) fallos.push(`${etiqueta}: tiene diferencia escrita pero ya coincide (${describir(a)})`);
      return;
    }
    if (nota && nota.app === describir(a) && nota.mcp === describir(b)) return;
    fallos.push(`${etiqueta}: app ${describir(a)}, MCP ${describir(b)}`);
  });
  return fallos;
}

// --- Lado de la app ----------------------------------------------------------------------------

/** Lo mínimo de un `Worker` del navegador que usa `createBrowserFormulaEngine`. */
interface WorkerLike {
  postMessage(message: EngineRequest): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: Event) => void): void;
  terminate(): void;
}
type BrowserClient = {
  createBrowserFormulaEngine(options: { createWorker: () => WorkerLike }): FormulaEngineWithValues;
};

/** Los `import()` de `engine.worker.ts` van de uno en uno: cada uno lee el `self` de su Worker. */
let workerImports: Promise<unknown> = Promise.resolve();
/** URLs que ha pedido el wasm por `fetch`, para comprobar que entra por el camino del navegador. */
const wasmFetches: string[] = [];

/**
 * Worker del navegador en el proceso del test. Dentro corre `engine.worker.ts`, evaluado de nuevo
 * para este Worker con su propio `self`. Como un Worker real, encola los mensajes hasta que el
 * módulo escucha y entrega cada uno en otra vuelta del bucle, clonado.
 */
class WorkerDeNavegador implements WorkerLike {
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();
  private handler: ((event: { data: EngineRequest }) => void) | null = null;
  private readonly inbox: EngineRequest[] = [];
  private terminated = false;

  constructor() {
    const scope = {
      addEventListener: (_type: 'message', listener: (event: { data: EngineRequest }) => void) => {
        this.handler = listener;
        for (const message of this.inbox.splice(0)) this.deliver(message);
      },
      postMessage: (response: EngineResponse) => {
        const copy = structuredClone(response);
        setTimeout(() => this.emit('message', { data: copy } as unknown as Event), 0);
      }
    };
    const load = workerImports.then(async () => {
      vi.resetModules();
      const g = globalThis as { self?: unknown };
      const before = g.self;
      g.self = scope;
      try {
        await import(/* @vite-ignore */ join(ENGINE_DIR, 'engine.worker.ts'));
      } finally {
        g.self = before;
      }
    });
    workerImports = load.catch(() => {});
    load.catch(() => this.emit('error', new Event('error')));
  }

  postMessage(message: EngineRequest): void {
    if (this.terminated) return;
    const clon = structuredClone(message);
    if (this.handler) this.deliver(clon);
    else this.inbox.push(clon);
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  private deliver(message: EngineRequest): void {
    setTimeout(() => {
      if (!this.terminated) this.handler?.({ data: message });
    }, 0);
  }

  private emit(type: string, event: Event): void {
    if (this.terminated) return;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** `fetch` del navegador para el wasm: solo sirve `@ironcalc/wasm/wasm_bg.wasm`, sin red. */
async function fetchDelWasm(input: unknown): Promise<Response> {
  const url = String(input);
  wasmFetches.push(url);
  if (!url.endsWith('/@ironcalc/wasm/wasm_bg.wasm')) throw new Error(`fetch inesperado: ${url}`);
  return new Response(readFileSync(WASM_PATH), { headers: { 'content-type': 'application/wasm' } });
}

let client: BrowserClient;

interface App {
  controller: LiveSheetController;
  adapter: SheetAdapter;
  doc: Y.Doc;
  scaffold: Uint8Array;
  port: ReturnType<typeof createMemoryAtomicPort>;
  loads: { locale: string; timezone: string; bookLocale: string; bookTimezone: string }[];
  engineErrors: unknown[];
  close(): void;
}

/** El `.ods` abierto en la app, como `openOdsDocument`: andamiaje, sesión, controlador y motor. */
async function abrirEnLaApp(bytes: Uint8Array): Promise<App> {
  const ajustes = (await prepareSheetBase(bytes)).engineSettings;
  if (!ajustes) throw new Error('el libro de prueba no tiene región admitida');
  const engine = client.createBrowserFormulaEngine({ createWorker: () => new WorkerDeNavegador() });
  const loads: App['loads'] = [];
  const recorded: FormulaEngineWithValues = {
    ...engine,
    load(book, opts, signal) {
      loads.push({ ...opts, bookLocale: book.locale, bookTimezone: book.timezone });
      return engine.load(book, opts, signal);
    }
  };
  const doc = new Y.Doc();
  doc.clientID = 82;
  const puerto = createMemoryAtomicPort();
  const engineErrors: unknown[] = [];
  let scaffold: Uint8Array | null = null;
  let adapterOf: SheetAdapter | null = null;
  const controlador = await openSheetController({
    base: bytes,
    engine: recorded,
    projection: createSheetEngineProjection(ajustes),
    onEngineError: (error) => engineErrors.push(error),
    async openSession(adapter) {
      adapterOf = adapter;
      adapter.scaffold(bytes, doc);
      scaffold = Y.encodeStateAsUpdateV2(doc);
      return createDocSession<SheetModel, SheetOp>({ fileId: FILE_ID, doc, generation: GENERATION, adapter, port: puerto, base: bytes });
    }
  });
  return {
    controller: controlador,
    adapter: adapterOf!,
    doc,
    scaffold: scaffold!,
    port: puerto,
    loads,
    engineErrors,
    close() {
      controlador.dispose();
      engine.dispose();
    }
  };
}

async function despachar(app: App, ops: readonly SheetOp[], seed: string): Promise<void> {
  if (ops.length === 0) return;
  const result = await app.controller.dispatch(ops, 'user', { seed });
  if (!result.ok) throw new Error(`la app rechazó el lote ${seed}: ${JSON.stringify(result)}`);
}

// --- Lado del MCP ------------------------------------------------------------------------------

let engineWorkerUrl: URL;
const directories: string[] = [];

/** Lo que guardó la app, como lo manda `hebra_read_sheet` al hilo de documentos. */
function entradaDeLectura(bytes: Uint8Array, app: Pick<App, 'scaffold' | 'port'>, range: string): ReadSheetJobInput {
  const baseSha256 = huella(bytes);
  return {
    format: 'ods',
    fileId: FILE_ID,
    head: newDocumentHead('ods', GENERATION, baseSha256),
    base: bytes,
    baseSha256,
    segments: [app.scaffold],
    pending: [...app.port.updates],
    request: { sheet: 'Hoja1', range, include: ['values'], maxCells: 20_000, offset: 0 }
  };
}

/** Valores de una columna leída con `runReadSheetJob`, de la fila 1 a la `filas`. */
async function leerEnElMcp(bytes: Uint8Array, app: Pick<App, 'scaffold' | 'port'>, columna: string, filas: number): Promise<Valor[]> {
  const result = await runReadSheetJob(structuredClone(entradaDeLectura(bytes, app, `${columna}1:${columna}${filas}`)), { engineWorkerUrl });
  if (!result.ok || !('page' in result) || !result.page) throw new Error(`lectura del MCP fallida: ${JSON.stringify(result)}`);
  if (!result.page.calculated) throw new Error('el MCP no calculó las fórmulas');
  return result.page.rows.map((row) => valorDeLectura(row.values[0]));
}

/** El modelo que ve el MCP con lo que guardó la app. */
async function modeloDelMcp(bytes: Uint8Array, app: Pick<App, 'scaffold' | 'port'>): Promise<{ model: SheetModel; settings: BookEngineSettings }> {
  const preparada = await prepareSheetBase(bytes);
  const doc = new Y.Doc();
  for (const update of [app.scaffold, ...app.port.updates]) Y.applyUpdateV2(doc, update);
  const model = await createSheetAdapter(preparada).project(bytes, doc, live());
  return { model, settings: preparada.engineSettings! };
}

/** El motor del MCP cargado como en `hebra_edit_sheet` (`formulaReport`): el libro entero de después. */
async function motorDelMcp(model: SheetModel, settings: BookEngineSettings): Promise<FormulaEngineWithValues> {
  const engine = createNodeFormulaEngine({ workerUrl: engineWorkerUrl });
  await engine.load(createSheetEngineProjection(settings).book(model), settings, live());
  return engine;
}

// --- Lotes ------------------------------------------------------------------------------------

const idioma = createFormulaLocale();

/** Canon de una fórmula en español en la celda (fila, columna) de `Hoja1`, como la teclea la persona. */
function canonEs(model: SheetModel, texto: string, row: number, col: number): CanonFormula {
  const canon = idioma.toCanon(texto, scopeOf(model, model.sheets[0].id), { row, col }, 'es');
  if (isFormulaParseError(canon)) throw new Error(`${texto}: ${canon.error}`);
  return canon;
}

/** `cell.set` en `Hoja1` por posición, con los ids del modelo de base. */
function setEn(model: SheetModel, row: number, col: number, value: SheetOp & { type: 'cell.set' } extends { value: infer V } ? V : never): SheetOp {
  const sheet = model.sheets[0];
  return { type: 'cell.set', sheet: sheet.id, row: sheet.rows.idAt(row), col: sheet.cols.idAt(col), value, replaces: [] };
}

function loteDeColumna(model: SheetModel, casos: readonly Caso[], col: number, fila: (i: number) => number = (i) => i): SheetOp[] {
  return casos.map(([, es], i) => setEn(model, fila(i), col, { f: canonEs(model, es, fila(i), col) }));
}

const COL_K = 10;
const COL_L = 11;
const COL_N = 13;

type Medida = { app: Valor[]; mcp: Valor[]; appShown: string[]; mcpShown: string[] };

/** Abre el libro en la app, despacha el lote de una columna y lee la columna en los dos lados. */
async function medirColumna(
  appBytes: Uint8Array,
  mcpBytes: Uint8Array,
  casos: readonly Caso[],
  col: number,
  letra: string
): Promise<Medida> {
  const app = await abrirEnLaApp(appBytes);
  try {
    const base = (await prepareSheetBase(appBytes)).model;
    await despachar(app, loteDeColumna(base, casos, col), `lote-${letra}`);
    const range: GridRange = { from: { row: 0, col }, to: { row: casos.length - 1, col } };
    const leidas = await app.controller.read(base.sheets[0].id, range);
    const porFila = new Map(leidas.map((c) => [c.row, c]));
    const appValores = casos.map((_, i) => valorDeCelda(porFila.get(i)));
    const appShown = casos.map((_, i) => porFila.get(i)?.shown ?? '');
    const mcp = await leerEnElMcp(mcpBytes, app, letra, casos.length);
    const { model, settings } = await modeloDelMcp(mcpBytes, app);
    const engine = await motorDelMcp(model, settings);
    try {
      const nodo = new Map((await engine.read(0, range)).map((c) => [c.row, c]));
      return { app: appValores, mcp, appShown, mcpShown: casos.map((_, i) => nodo.get(i)?.shown ?? '') };
    } finally {
      engine.dispose();
    }
  } finally {
    app.close();
  }
}

const cache = new Map<string, Promise<Medida>>();
function medida(clave: string, run: () => Promise<Medida>): Promise<Medida> {
  let found = cache.get(clave);
  if (!found) cache.set(clave, (found = run()));
  return found;
}
const funcionesEs = () => medida('k-es', () => medirColumna(LIBRO_ES, LIBRO_ES, CASOS, COL_K, 'K'));
const funcionesEn = () => medida('k-en', () => medirColumna(LIBRO_EN, LIBRO_EN, CASOS, COL_K, 'K'));
/** La prueba negativa: la app abre el libro `es-ES` y el MCP lee lo mismo sobre el `en-US`. */
const funcionesCruzadas = () => medida('k-cruce', () => medirColumna(LIBRO_ES, LIBRO_EN, CASOS, COL_K, 'K'));
const sueltosEs = () => medida('l-es', () => medirColumna(LIBRO_ES, LIBRO_ES, SUELTOS, COL_L, 'L'));
const sueltosEn = () => medida('l-en', () => medirColumna(LIBRO_EN, LIBRO_EN, SUELTOS, COL_L, 'L'));

// --- Arnés ------------------------------------------------------------------------------------

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-h82-'));
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
  engineWorkerUrl = pathToFileURL(outfile);
  vi.stubGlobal('fetch', fetchDelWasm);
  // Sin literal: tsc no sigue el `?worker&url` de Vite que importa el cliente del navegador.
  const clientPath = join(ENGINE_DIR, 'engine-client.ts');
  client = (await import(/* @vite-ignore */ clientPath)) as BrowserClient;
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// --- Tests ------------------------------------------------------------------------------------

describe('tabla de casos', () => {
  it('hay un caso por cada una de las 195 funciones, sin repetidos ni sobrantes', () => {
    expect(CASOS.map((c) => c[0]).sort()).toEqual(FUNCTION_NAMES.map((f) => f[0]).sort());
  });

  it('cada caso está escrito con el nombre español de su función', () => {
    const sinNombre = CASOS.filter(([fn, es]) => {
      const nombre = FUNCTION_NAMES.find((f) => f[0] === fn)?.[1] ?? '?';
      return !es.toUpperCase().includes(`${nombre.toUpperCase()}(`);
    }).map((c) => c[0]);
    expect(sinNombre).toEqual([]);
  });

  it('el lote del MCP (inglés, compileBatch) es el mismo que el de la app (español, FormulaLocale)', async () => {
    const { model } = await prepareSheetBase(LIBRO_ES);
    const app = loteDeColumna(model, CASOS, COL_K);
    const scope = scopeOf(model, model.sheets[0].id);
    const ingles = app.map((op) => (op.type === 'cell.set' && op.value && typeof op.value === 'object' && 'f' in op.value ? `=${idioma.toText(op.value.f, scope, 'en')}` : ''));
    const compilado = compileBatch(model, {
      ops: [{ type: 'setCells', sheet: 'Hoja1', start: 'K1', rows: ingles.map((f) => [f]) }],
      expectedRevision: 'cualquiera'
    });
    if ('error' in compilado) throw new Error(compilado.reason);
    const valores = (ops: readonly SheetOp[]) => ops.map((op) => (op.type === 'cell.set' ? JSON.stringify([op.row, op.col, op.value]) : op.type));
    expect(valores(compilado.ops)).toEqual(valores(app));
  });

  it('el comparador ve un valor alterado en un solo lado', () => {
    expect(diferencias(['SUM'], [33], [34])).toEqual(['SUM: app num 33, MCP num 34']);
  });

  it('el comparador ve un error donde el otro lado da valor', () => {
    expect(diferencias(['SUM'], [{ error: '#DIV/0!' }], [33])).toHaveLength(1);
  });

  it('una diferencia escrita que ya no se da hace fallar', () => {
    expect(diferencias(['SUM'], [33], [33], { SUM: { app: 'num 33', mcp: 'num 34', motivo: 'prueba' } })).toHaveLength(1);
  });

  it('una volátil fuera de su margen da diferencia', () => {
    expect(diferencias(['NOW'], [46000], [46000 + 1 / 24])).toHaveLength(1);
  });
});

describe('las 195 funciones en la app y en el MCP', () => {
  it('el wasm de la app entra por fetch con la URL de Vite, como en el navegador', async () => {
    await funcionesEs();
    expect(wasmFetches.length > 0 && wasmFetches.every((u) => u.endsWith('/@ironcalc/wasm/wasm_bg.wasm'))).toBe(true);
  });

  it('la app carga el motor con la región y la zona del libro: es y UTC', async () => {
    const app = await abrirEnLaApp(LIBRO_ES);
    app.close();
    expect(app.loads).toEqual([{ locale: 'es', timezone: 'UTC', bookLocale: 'es', bookTimezone: 'UTC' }]);
  });

  it('el MCP lee los mismos ajustes del mismo libro', async () => {
    expect((await prepareSheetBase(LIBRO_ES)).engineSettings).toEqual({ locale: 'es', timezone: 'UTC' });
  });

  it('libro es-ES: hebra_read_sheet da en cada función el valor de la app', async () => {
    const m = await funcionesEs();
    expect(diferencias(CASOS.map((c) => c[0]), m.app, m.mcp)).toEqual([]);
  });

  it('libro es-ES: el motor de hebra_edit_sheet muestra cada celda igual que la rejilla', async () => {
    const m = await funcionesEs();
    const distintas = CASOS.filter(([fn], i) => !VOLATILES[fn] && m.appShown[i] !== m.mcpShown[i]).map(([fn], i) => `${fn}: ${m.appShown[i]} / ${m.mcpShown[i]}`);
    expect(distintas).toEqual([]);
  });

  it('libro en-US: hebra_read_sheet da en cada función el valor de la app', async () => {
    const m = await funcionesEn();
    expect(diferencias(CASOS.map((c) => c[0]), m.app, m.mcp)).toEqual([]);
  });

  it('libro en-US: el motor de hebra_edit_sheet muestra cada celda igual que la rejilla', async () => {
    const m = await funcionesEn();
    const distintas = CASOS.filter(([fn], i) => !VOLATILES[fn] && m.appShown[i] !== m.mcpShown[i]).map(([fn]) => fn);
    expect(distintas).toEqual([]);
  });

  it('ninguna función se queda sin calcular: solo dan error las que lo dan a propósito', async () => {
    const m = await funcionesEs();
    const errores = CASOS.flatMap(([fn], i) => (describir(m.app[i]).startsWith('error') ? [`${fn} ${describir(m.app[i])}`] : []));
    expect(errores).toEqual(['NA error #N/A']);
  });

  it('la región del libro cambia el resultado de TEXT y de ninguna otra (medido en la app)', async () => {
    const es = await funcionesEs();
    const en = await funcionesEn();
    const cambian = CASOS.flatMap(([fn], i) =>
      !VOLATILES[fn] && describir(es.app[i]) !== describir(en.app[i]) ? [`${fn}: es ${describir(es.app[i])}, en ${describir(en.app[i])}`] : []
    );
    expect(cambian).toEqual(['TEXT: es str "1234,6", en str "1234.6"']);
  });

  it('prueba negativa: con la región cambiada solo en el MCP la paridad falla justo en TEXT', async () => {
    const m = await funcionesCruzadas();
    expect(diferencias(CASOS.map((c) => c[0]), m.app, m.mcp)).toEqual(['TEXT: app str "1234,6", MCP str "1234.6"']);
  });
});

describe('casos de fórmula sueltos en la app y en el MCP', () => {
  it('libro es-ES: errores, referencias entre hojas, fechas y región dan lo mismo', async () => {
    const m = await sueltosEs();
    expect(diferencias(SUELTOS.map((c) => c[0]), m.app, m.mcp)).toEqual([]);
  });

  it('libro en-US: los mismos casos dan lo mismo', async () => {
    const m = await sueltosEn();
    expect(diferencias(SUELTOS.map((c) => c[0]), m.app, m.mcp)).toEqual([]);
  });

  it('valores medidos de los casos sueltos (es y en)', async () => {
    const es = await sueltosEs();
    const en = await sueltosEn();
    expect(SUELTOS.map(([etiqueta], i) => `${etiqueta}: es ${describir(es.app[i])}, en ${describir(en.app[i])}`)).toEqual([
      'CIRCULAR: es error #CIRC!, en error #CIRC!',
      'DIV0: es error #DIV/0!, en error #DIV/0!',
      'VALOR_ERR: es error #VALUE!, en error #VALUE!',
      'REF_ERR: es error #REF!, en error #REF!',
      'NOMBRE_ERR: es error #NAME?, en error #NAME?',
      'NUM_ERR: es error #NUM!, en error #NUM!',
      'ND_ERR: es error #N/A, en error #N/A',
      'ERROR_LITERAL: es error #REF!, en error #REF!',
      'ERROR_PROPAGADO: es error #DIV/0!, en error #DIV/0!',
      'HOJA2: es num 14, en num 14',
      'HOJA2_RANGO: es num 24, en num 24',
      'HOJA_ESPACIO: es num 12, en num 12',
      'HOJA_NOMBRE_RARO: es num 39, en num 39',
      'HOJA_INDIRECTA: es num 8, en num 8',
      'HOJA_MEZCLA: es num 18, en num 18',
      'FECHA_BISIESTA: es num 45351, en num 45351',
      'FECHA_DESBORDA: es num 45658, en num 45658',
      'FECHA_TEXTO_ES: es num 45351, en num 45351',
      'FECHA_TEXTO_ISO: es num 45351, en num 45351',
      'FECHA_FORMATO: es str "29/02/2024", en str "29/02/2024"',
      'FECHA_MES_LARGO: es str "enero", en str "January"',
      'FECHA_SEMANA: es num 4, en num 4',
      'FECHA_FIN_FEBRERO: es num 45351, en num 45351',
      'HORA_DESBORDA: es num 0.041666666666666664, en num 0.041666666666666664',
      'HORA_TEXTO: es num 0.7708333333333334, en num 0.7708333333333334',
      'FECHA_RESTA: es num 365, en num 365',
      'DECIMAL_COMA: es num 3.5, en num 3.5',
      'VALOR_COMA: es num 1.5, en error #VALUE!',
      'VALOR_PUNTO: es error #VALUE!, en num 1.5',
      'TEXTO_MILES_ES: es str "1.234,5000", en str "1,234.5000"',
      'TEXTO_MILES_EN: es str "1.234,50", en str "1,234.50"',
      'TEXTO_PORCIENTO: es str "12%", en str "12%"',
      'NUMERO_A_TEXTO: es str "1.5", en str "1.5"',
      'PUNTO_Y_COMA_EN_CADENA: es str "a;bc", en str "a;bc"',
      'MATRIZ_EN_LINEA: es num 21, en num 21',
      'COMPARA_TEXTO: es bool true, en bool true',
      'LOGICO_A_NUMERO: es num 2, en num 2',
      'VACIA: es num 0, en num 0',
      'VACIA_TEXTO: es str "", en str ""'
    ]);
  });

  it('prueba negativa: con la región cambiada solo en el MCP los casos que dependen de ella fallan', async () => {
    const m = await medida('l-cruce', () => medirColumna(LIBRO_ES, LIBRO_EN, SUELTOS, COL_L, 'L'));
    expect(diferencias(SUELTOS.map((c) => c[0]), m.app, m.mcp).map((f) => f.split(':')[0])).toEqual([
      'FECHA_MES_LARGO',
      'VALOR_COMA',
      'VALOR_PUNTO',
      'TEXTO_MILES_ES',
      'TEXTO_MILES_EN'
    ]);
  });

  it('una matriz que se derrama: la app y el MCP leen las mismas celdas', async () => {
    const app = await abrirEnLaApp(LIBRO_ES);
    try {
      const base = (await prepareSheetBase(LIBRO_ES)).model;
      await despachar(app, loteDeColumna(base, DERRAMES, COL_N, FILA_DERRAME), 'derrames');
      const filas = FILA_DERRAME(DERRAMES.length);
      const range: GridRange = { from: { row: 0, col: COL_N }, to: { row: filas - 1, col: COL_N } };
      const porFila = new Map((await app.controller.read(base.sheets[0].id, range)).map((c) => [c.row, c]));
      const appValores = Array.from({ length: filas }, (_, r) => valorDeCelda(porFila.get(r)));
      const mcp = await leerEnElMcp(LIBRO_ES, app, 'N', filas);
      const etiquetas = Array.from({ length: filas }, (_, r) => `N${r + 1}@${DERRAMES[Math.floor(r / 4)][0]}`);
      expect(diferencias(etiquetas, appValores, mcp)).toEqual([]);
    } finally {
      app.close();
    }
  });
});

// --- Cada SheetOp ------------------------------------------------------------------------------

/** Lo que necesita un lote de operaciones: los ids del libro de base y la app ya abierta. */
interface Contexto {
  base: SheetModel;
  app: App;
  s0: string;
  s1: string;
  fila(i: number): string;
  col(i: number): string;
  /** Modelo de ahora en la app, para sacar ids que nacen con un lote (combinadas). */
  modelo(): Promise<SheetModel>;
}

/** Un lote con su preparación (otro lote antes, si lo necesita) o una exclusión escrita. */
type CasoDeOp = { preparar?: (c: Contexto) => SheetOp[] | Promise<SheetOp[]>; lote: (c: Contexto) => SheetOp[] | Promise<SheetOp[]> } | { excluida: string };

const nombre = (id: string, name: string, expr: string): SheetOp => ({ type: 'rule.put', kind: 'name', id, body: JSON.stringify({ name, expr }) });

/**
 * Fórmulas que dependen de lo que tocan las operaciones: rangos que se mueven con los ejes, otra
 * hoja, un nombre, lo oculto (`SUBTOTALES(109)`), la posición (`FILA`), una referencia opaca
 * (`INDIRECTO`) y un derrame. Van en `Hoja1!K1:S2` y en `Hoja2!A4`.
 */
function preparacion(c: Contexto): SheetOp[] {
  const en = (col: number, es: string, row = 0) => setEn(c.base, row, col, { f: canonEs(c.base, es, row, col) });
  const hoja2 = c.base.sheets[1];
  const scope2 = scopeOf(c.base, hoja2.id);
  const canon2 = idioma.toCanon('=Hoja1!K1*2', scope2, { row: 3, col: 0 }, 'es');
  if (isFormulaParseError(canon2)) throw new Error(canon2.error);
  return [
    nombre('total', 'Total', 'Hoja1!$A$1:$A$3'),
    en(10, '=SUMA(A1:A3)'),
    en(10, '=A2*10', 1),
    en(11, '=Hoja2!A1+1'),
    en(12, '=SUMA(Total)'),
    en(13, '=SUBTOTALES(109;A1:A3)'),
    en(14, '=FILA(A3)'),
    en(15, '=INDIRECTO("A2")'),
    en(16, '=SECUENCIA(2)'),
    en(17, '=Otro*2'),
    en(18, "='Hoja con espacio'!A1+Hoja2!A2"),
    { type: 'cell.set', sheet: hoja2.id, row: hoja2.rows.idAt(3), col: hoja2.cols.idAt(0), value: { f: canon2 }, replaces: [] }
  ];
}

/**
 * Un caso por cada `SHEET_OP_TYPES`. Las cuatro que solo genera una inversa (`cell.unset`,
 * `axis.restore`, `axis.runs`, `range.restore`) también van: la app las despacha al deshacer.
 */
const CASOS_DE_OP: Record<SheetOpType, CasoDeOp> = {
  'cell.set': { lote: (c) => [setEn(c.base, 0, 0, 30)] },
  'cell.unset': {
    preparar: (c) => [setEn(c.base, 0, 0, 30)],
    lote: (c) => [{ type: 'cell.unset', sheet: c.s0, row: c.fila(0), col: c.col(0), replaces: c.app.controller.replaces(c.s0, c.fila(0), c.col(0)) }]
  },
  'cell.style': { lote: (c) => [{ type: 'cell.style', sheet: c.s0, row: c.fila(0), col: c.col(10), patch: { bold: 'true', fill: '#ffee00' } }] },
  'axis.insert': { lote: (c) => [{ type: 'axis.insert', sheet: c.s0, axis: 'row', after: c.fila(0), ids: ['h82a', 'h82b'] }] },
  'axis.delete': { lote: (c) => [{ type: 'axis.delete', sheet: c.s0, axis: 'row', ids: [c.fila(2)] }] },
  'axis.restore': {
    preparar: (c) => [{ type: 'axis.delete', sheet: c.s0, axis: 'row', ids: [c.fila(2)] }],
    lote: (c) => [{ type: 'axis.restore', sheet: c.s0, axis: 'row', ids: [c.fila(2)] }]
  },
  'axis.hide': { lote: (c) => [{ type: 'axis.hide', sheet: c.s0, axis: 'row', ids: [c.fila(1)] }] },
  'axis.show': {
    preparar: (c) => [{ type: 'axis.hide', sheet: c.s0, axis: 'row', ids: [c.fila(1)] }],
    lote: (c) => [{ type: 'axis.show', sheet: c.s0, axis: 'row', ids: [c.fila(1)] }]
  },
  'axis.size': { lote: (c) => [{ type: 'axis.size', sheet: c.s0, axis: 'row', id: c.fila(0), px: 40 }] },
  'axis.sizeRun': { lote: (c) => [{ type: 'axis.sizeRun', sheet: c.s0, axis: 'col', from: c.col(0), to: c.col(2), px: 90 }] },
  'axis.hideRun': { lote: (c) => [{ type: 'axis.hideRun', sheet: c.s0, axis: 'row', from: c.fila(0), to: c.fila(1), hidden: true }] },
  'axis.runs': {
    preparar: (c) => [{ type: 'axis.hideRun', sheet: c.s0, axis: 'row', from: c.fila(0), to: c.fila(1), hidden: true }],
    lote: (c) => [{ type: 'axis.runs', sheet: c.s0, axis: 'row', prop: 'hidden', runs: [] }]
  },
  'sheet.add': { lote: () => [{ type: 'sheet.add', sheet: 'h82-nueva', name: 'Nueva' }] },
  'sheet.delete': { lote: (c) => [{ type: 'sheet.delete', sheet: c.s1 }] },
  'sheet.rename': { lote: (c) => [{ type: 'sheet.rename', sheet: c.s1, name: 'Otra hoja' }] },
  'sheet.move': { lote: (c) => [{ type: 'sheet.move', sheet: c.s1, to: 0 }] },
  'sheet.hide': { lote: (c) => [{ type: 'sheet.hide', sheet: c.s1, hidden: true }] },
  'sheet.freeze': { lote: (c) => [{ type: 'sheet.freeze', sheet: c.s0, rows: 1, cols: 1 }] },
  // A1:K1 tapa fórmulas de la fila 1: la combinada se lleva lo que había debajo de la esquina.
  'range.merge': { lote: (c) => [{ type: 'range.merge', sheet: c.s0, from: [c.fila(0), c.col(9)], to: [c.fila(0), c.col(10)] }] },
  'range.unmerge': {
    preparar: (c) => [{ type: 'range.merge', sheet: c.s0, from: [c.fila(0), c.col(9)], to: [c.fila(0), c.col(10)] }],
    lote: (c) => [{ type: 'range.unmerge', sheet: c.s0, from: [c.fila(0), c.col(9)], to: [c.fila(0), c.col(10)] }]
  },
  'range.restore': {
    preparar: (c) => [{ type: 'range.merge', sheet: c.s0, from: [c.fila(0), c.col(9)], to: [c.fila(0), c.col(10)] }],
    lote: async (c) => {
      const merges = (await c.modelo()).sheets[0].merges.map((m) => m.id);
      if (merges.length === 0) throw new Error('la combinada de la preparación no está en el modelo');
      return [{ type: 'range.restore', sheet: c.s0, kill: merges, revive: [] }];
    }
  },
  'rule.put': { lote: () => [nombre('otro', 'Otro', 'Hoja2!$A$1')] },
  'rule.delete': { lote: () => [{ type: 'rule.delete', kind: 'name', id: 'total' }] }
};

/** Tipos de operación sin caso ni exclusión. Vacío si la tabla cubre la lista. */
function sinCaso(tipos: readonly string[], tabla: Partial<Record<string, CasoDeOp>> = CASOS_DE_OP): string[] {
  return tipos.filter((t) => !tabla[t]);
}

/** Lo que enseña cada hoja en `A1:X20`, por nombre de hoja y celda, con su texto mostrado. */
async function fotoDeLaApp(c: Contexto): Promise<string[]> {
  const model = await c.modelo();
  const out: string[] = [];
  for (const hoja of model.sheets) {
    for (const cell of await c.app.controller.read(hoja.id, AREA)) out.push(linea(hoja.name, cell));
  }
  return out.sort();
}

async function fotoDelMcp(app: App): Promise<string[]> {
  const { model, settings } = await modeloDelMcp(LIBRO_ES, app);
  const engine = await motorDelMcp(model, settings);
  try {
    const out: string[] = [];
    for (const [index, sheet] of model.sheets.entries()) {
      for (const cell of await engine.read(index, AREA)) out.push(linea(sheet.name, cell));
    }
    return out.sort();
  } finally {
    engine.dispose();
  }
}

const AREA: GridRange = { from: { row: 0, col: 0 }, to: { row: 19, col: COLUMNAS - 1 } };
const linea = (hoja: string, cell: EngineCell) =>
  `${hoja}!${String.fromCharCode(65 + cell.col)}${cell.row + 1}: ${describir(valorDeCelda(cell))} [${cell.shown}]`;

/** Abre la app, despacha preparación y lote, y devuelve lo que ve cada lado. */
async function medirOp(caso: Exclude<CasoDeOp, { excluida: string }>): Promise<{ app: string[]; mcp: string[] }> {
  const app = await abrirEnLaApp(LIBRO_ES);
  try {
    const base = (await prepareSheetBase(LIBRO_ES)).model;
    const c: Contexto = {
      base,
      app,
      s0: base.sheets[0].id,
      s1: base.sheets[1].id,
      fila: (i) => base.sheets[0].rows.idAt(i),
      col: (i) => base.sheets[0].cols.idAt(i),
      modelo: () => app.adapter.project(LIBRO_ES, app.doc, live())
    };
    await despachar(app, preparacion(c), 'preparacion');
    if (caso.preparar) await despachar(app, await caso.preparar(c), 'preparar');
    await despachar(app, await caso.lote(c), 'lote');
    const enApp = await fotoDeLaApp(c);
    if (app.engineErrors.length > 0) throw new Error(`el motor de la app falló: ${String(app.engineErrors[0])}`);
    return { app: enApp, mcp: await fotoDelMcp(app) };
  } finally {
    app.close();
  }
}

describe('cada SheetOp: la app al día por ediciones y el MCP con el libro entero de después', () => {
  it('cada tipo de SHEET_OP_TYPES tiene caso o exclusión escrita', () => {
    expect(sinCaso(SHEET_OP_TYPES)).toEqual([]);
  });

  it('prueba negativa: un tipo de operación nuevo sin caso hace fallar la tabla', () => {
    expect(sinCaso([...SHEET_OP_TYPES, 'cell.prueba'])).toEqual(['cell.prueba']);
  });

  it('prueba negativa: quitar el caso de un tipo hace fallar la tabla', () => {
    const { 'axis.insert': _quitado, ...sinUno } = CASOS_DE_OP;
    expect(sinCaso(SHEET_OP_TYPES, sinUno)).toEqual(['axis.insert']);
  });

  const medidas = new Map<string, Promise<{ app: string[]; mcp: string[] }>>();
  const medir = (clave: string, caso: Exclude<CasoDeOp, { excluida: string }>) => {
    let found = medidas.get(clave);
    if (!found) medidas.set(clave, (found = medirOp(caso)));
    return found;
  };
  const soloPreparacion = () => medir('preparación', { lote: () => [] });

  it('la preparación calcula en los dos lados (la comparación no es de hojas vacías)', async () => {
    const { app } = await soloPreparacion();
    expect(app.filter((l) => /^Hoja1!(K1|M1|R1|S1): /.test(l))).toEqual([
      'Hoja1!K1: num 8 [8]',
      'Hoja1!M1: num 8 [8]',
      'Hoja1!R1: error #NAME? [#NAME?]',
      'Hoja1!S1: num 19 [19]'
    ]);
  });

  for (const tipo of SHEET_OP_TYPES) {
    const caso = CASOS_DE_OP[tipo];
    if ('excluida' in caso) {
      it.skip(`${tipo}: ${caso.excluida}`, () => {});
      continue;
    }
    it(`${tipo}: la app y el MCP calculan lo mismo después del lote`, async () => {
      const { app, mcp } = await medir(tipo, caso);
      expect(mcp).toEqual(app);
    });
  }

  it('los lotes que tocan el cálculo lo cambian de verdad (medido contra la preparación sola)', async () => {
    const antes = (await soloPreparacion()).app.join('\n');
    const cambian: string[] = [];
    for (const tipo of SHEET_OP_TYPES) {
      const caso = CASOS_DE_OP[tipo];
      if ('excluida' in caso) continue;
      if ((await medir(tipo, caso)).app.join('\n') !== antes) cambian.push(tipo);
    }
    // El resto deja lo calculado igual: lo deshacen (`cell.unset`, `axis.restore`, `axis.show`,
    // `axis.runs`), no lo ve el motor (tamaños, estilo, inmovilizar, ocultar hoja, combinar) o no
    // cambia ningún valor de las hojas que ya había (`sheet.add`, `sheet.move`). Ocultar filas no
    // cambia `SUBTOTALES(109)` en ninguno de los dos lados: el motor no recibe lo oculto.
    expect(cambian).toEqual(['cell.set', 'axis.insert', 'axis.delete', 'sheet.delete', 'sheet.rename', 'rule.put', 'rule.delete']);
  });
});
