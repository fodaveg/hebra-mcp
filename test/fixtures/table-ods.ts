/**
 * Un `.ods` con una tabla estructurada (bloque TAB, H-171): la hoja `Ventas` con la tabla
 * `Ventas2026` en A1:B4 (cabecera Mes e Importe), guardada como la guarda LibreOffice, un
 * `table:database-range` con nombre y botones de filtro.
 */
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"';
const str = (v: string) => `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
const num = (v: number) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;

export function tableOds(): Uint8Array {
  const rows = [str('Mes') + str('Importe'), str('Ene') + num(100), str('Feb') + num(300), str('Mar') + num(200)]
    .map((cells) => `<table:table-row>${cells}</table:table-row>`)
    .join('');
  return buildOds(
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><office:body><office:spreadsheet>` +
      `<table:table table:name="Ventas"><table:table-column table:number-columns-repeated="6"/>${rows}</table:table>` +
      '<table:database-ranges><table:database-range table:name="Ventas2026" table:target-range-address="Ventas.A1:Ventas.B4" table:display-filter-buttons="true"/></table:database-ranges>' +
      '</office:spreadsheet></office:body></office:document-content>'
  );
}
