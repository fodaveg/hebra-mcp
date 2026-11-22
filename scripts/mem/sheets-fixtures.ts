/**
 * Los `.ods` de la sonda de memoria de hojas (H-95c): `node sheets-fixtures.mjs <carpeta>` los
 * escribe como `<carpeta>/<caso>.ods`. Los lanza `scripts/mem/sheets-peak.mjs`.
 *
 * Los libros salen de la plantilla de pruebas de Hebra (`buildOds`) con otro `content.xml`: filas
 * de 8 celdas (4 números, 2 textos, 1 fecha y 1 fórmula) como las de H-95b, y lo que falta hasta
 * el tamaño pedido, en una entrada que no está en el manifiesto.
 *
 * - `foto`: el de `test/fixtures/photo-ods.ts` (4,07 MB con 4,3 MiB de imágenes), el que H-TOPES-MCP
 *   usó para ver que se lee y no se guardaba.
 * - `limite8`: 3,9 MiB de `content.xml` y el resto de relleno comprimible (hexadecimal) hasta
 *   8 MiB descomprimidos menos 64 KiB (`SHEET_ODS_INVENTORY_LIMITS`), con el `.ods` bajo 4 MiB.
 * - `libro39`: 3,9 MiB de `content.xml` y un relleno incompresible hasta unos 4 MiB de `.ods`: el
 *   libro de H-95b (4 MiB y 3,9 MiB de XML).
 * - `pintar200`: lo mismo con unas 200 filas, para separar el coste del libro del del PNG.
 * - `pintar`: 3,9 MiB de `content.xml` con filas de 64 celdas (texto, números y una fórmula), para
 *   pintar `A1:BH200` (el rango máximo) sobre un libro en el tope de lectura.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';
import { photoOds } from '../../test/fixtures/photo-ods';

const MIB = 1024 * 1024;
const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" office:version="1.3"';

const num = (v: number) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
const str = (v: string) => `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
const date = (d: string) =>
  `<table:table-cell office:value-type="date" office:date-value="${d}"><text:p>${d}</text:p></table:table-cell>`;
const formula = (f: string, v: number) =>
  `<table:table-cell table:formula="of:=${f}" office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;

/** Un `content.xml` de la hoja `Datos` con `cellsPerRow` celdas por fila y `bytes` de tamaño. */
function content(bytes: number, cellsPerRow: 8 | 64): string {
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}><office:body><office:spreadsheet>` +
    `<table:table table:name="Datos"><table:table-column table:number-columns-repeated="${cellsPerRow}"/>`;
  const tail = '</table:table></office:spreadsheet></office:body></office:document-content>';
  const rows: string[] = [];
  let size = head.length + tail.length;
  for (let r = 0; size < bytes - 4096; r += 1) {
    let cells = '';
    if (cellsPerRow === 8) {
      cells = num(r) + num(r * 3 + 1) + num(r % 97) + num(r / 7) + str(`texto ${r}`) + str(`otro ${r % 331}`) + date(`2026-0${(r % 9) + 1}-1${r % 9}`) + formula(`SUM([.A${r + 1}:.D${r + 1}])`, r + r * 3 + 1 + (r % 97) + r / 7);
    } else {
      for (let c = 0; c < 63; c += 1) cells += c % 3 === 0 ? str(`fila ${r} c${c}`) : num(r * 64 + c);
      cells += formula(`SUM([.B${r + 1}:.C${r + 1}])`, 1);
    }
    const row = `<table:table-row>${cells}</table:table-row>`;
    rows.push(row);
    size += row.length;
  }
  return head + rows.join('') + tail;
}

/** El `.ods` de la plantilla con ese `content.xml` y, si se pide, una entrada más. */
function book(xml: string, extras: Array<{ path: string; data: Uint8Array; level: 0 | 9 }> | { path: string; data: Uint8Array; level: 0 | 9 } = []): Uint8Array {
  const entries: Zippable = {};
  for (const [path, data] of Object.entries(unzipSync(buildOds(xml)))) entries[path] = [data, { level: path === 'mimetype' ? 0 : 9 }];
  for (const extra of Array.isArray(extras) ? extras : [extras]) {
    // Declarada en el manifiesto, como una imagen real: sin ello el guardado lanza `manifest_incoherent`.
    const manifest = new TextDecoder().decode((entries['META-INF/manifest.xml'] as [Uint8Array, unknown])[0]);
    const type = extra.path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    entries['META-INF/manifest.xml'] = [
      new TextEncoder().encode(manifest.replace('</manifest:manifest>', ` <manifest:file-entry manifest:full-path="${extra.path}" manifest:media-type="${type}"/>\n</manifest:manifest>`)),
      { level: 9 }
    ];
    entries[extra.path] = [extra.data, { level: extra.level }];
  }
  return zipSync(entries);
}

const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
const out = (name: string, bytes: Uint8Array): void => {
  writeFileSync(join(dir, `${name}.ods`), bytes);
  const entries = unzipSync(bytes);
  const total = Object.values(entries).reduce((n, e) => n + e.length, 0);
  console.log(JSON.stringify({ caso: name, odsBytes: bytes.length, descomprimidoBytes: total, contentXml: entries['content.xml']!.length }));
};

const XML = Math.floor(3.9 * MIB);
out('foto', photoOds());

const xml8 = content(XML, 8);
const base8 = book(xml8);
const rawBase = Object.values(unzipSync(base8)).reduce((n, e) => n + e.length, 0);
// Relleno comprimible hasta 8 MiB menos 64 KiB descomprimidos (el hexadecimal de bytes al azar baja a la
// mitad). En DOS entradas: cada una tiene que caber en `maxEntryBytes` (4 MiB).
const fill = 8 * MIB - 64 * 1024 - rawBase;
const half = Math.floor(fill / 4); // bytes al azar de cada entrada: el doble en caracteres
const fillEntry = (name: string) => ({ path: `Pictures/${name}.svg`, data: new TextEncoder().encode(randomBytes(half).toString('hex')), level: 9 as const });
out('limite8', book(xml8, [fillEntry('relleno-a'), fillEntry('relleno-b')]));

// Relleno incompresible hasta unos 4 MiB de .ods (el tope es 4 MiB: 4.194.304).
const padding = 4_150_000 - base8.length;
out('libro39', book(xml8, { path: 'Pictures/relleno.png', data: randomBytes(padding), level: 0 }));

out('pintar', book(content(XML, 64)));
out('pintar200', book(content(700 * 1024, 64))); // unas 200 filas: el rango máximo en un libro corto
