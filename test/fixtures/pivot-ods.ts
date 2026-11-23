/**
 * Un `.ods` con una tabla dinámica (bloque PIV, H-171), como la guarda LibreOffice: la hoja `Datos`
 * con el origen en A1:C5 (cabeceras Región, Mes e Importe) y la tabla `Resumen` (Región en filas,
 * suma de Importe en datos) con su salida en E1:F4. La salida trae los valores que guardó el
 * fichero, a propósito distintos de los del origen (E3 dice 999): Hebra no los ha recalculado, así
 * que la lectura los da como no fiables (`from_file`).
 */
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"';
const str = (v: string) => `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
const num = (v: number) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
const blank = '<table:table-cell/>';

/** Las filas del origen (A:C) y de la salida guardada (E:F). */
const ROWS = [
  [str('Región'), str('Mes'), str('Importe'), blank, str('Región'), str('Suma - Importe')],
  [str('Norte'), str('Ene'), num(100), blank, str('Norte'), num(150)],
  [str('Sur'), str('Ene'), num(200), blank, str('Sur'), num(999)],
  [str('Norte'), str('Feb'), num(50), blank, str('Total Resultado'), num(1149)],
  [str('Sur'), str('Feb'), num(25), blank, blank, blank]
];

const PIVOTS =
  '<table:data-pilot-tables>' +
  '<table:data-pilot-table table:name="Resumen" table:application-data="" table:target-range-address="Datos.E1:Datos.F4" table:grand-total="column">' +
  '<table:source-cell-range table:cell-range-address="Datos.A1:Datos.C5"/>' +
  '<table:data-pilot-field table:source-field-name="Región" table:orientation="row" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level/></table:data-pilot-field>' +
  '<table:data-pilot-field table:source-field-name="" table:is-data-layout-field="true" table:orientation="column" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level/></table:data-pilot-field>' +
  '<table:data-pilot-field table:source-field-name="Importe" table:orientation="data" table:used-hierarchy="-1" table:function="sum"><table:data-pilot-level/></table:data-pilot-field>' +
  '</table:data-pilot-table>' +
  '</table:data-pilot-tables>';

export function pivotOds(): Uint8Array {
  const rows = ROWS.map((cells) => `<table:table-row>${cells.join('')}</table:table-row>`).join('');
  return buildOds(
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><office:body><office:spreadsheet>` +
      `<table:table table:name="Datos"><table:table-column table:number-columns-repeated="8"/>${rows}` +
      '<table:table-row table:number-rows-repeated="20"><table:table-cell table:number-columns-repeated="8"/></table:table-row></table:table>' +
      PIVOTS +
      '</office:spreadsheet></office:body></office:document-content>'
  );
}
