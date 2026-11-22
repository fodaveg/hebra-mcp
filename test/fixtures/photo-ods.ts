/**
 * Un `.ods` legal que se lee con `SHEET_ODS_READ_LIMITS` pero que, descomprimido entero, pasa de
 * sus 4 MiB (H-TOPES-MCP): el libro del fixture del adaptador (`Datos`, A1 = 1) con una foto
 * guardada sin comprimir de 3,3 MiB y un SVG de 1 MiB de texto hexadecimal que deflate deja en la
 * mitad, los dos en el manifiesto. El `.ods` queda bajo `SHEET_DOCUMENT_MAX_BYTES` (unos
 * 4.071.600 bytes) y sus partes XML son pequeñas, así que se lee; el guardado (`exportOds`), que
 * descomprime todas las entradas, solo cabe en `SHEET_ODS_INVENTORY_LIMITS`.
 */
import { randomBytes } from 'node:crypto';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { buildOds } from '../../vendor/hebra/src/lib/sheets/adapter/sheet-adapter.fixture';

const MIB = 1024 * 1024;

/** Bytes descomprimidos de la foto y del SVG, para comprobar que el total pasa del tope de lectura. */
export const PHOTO_ODS_MEDIA_BYTES = Math.floor(3.3 * MIB) + MIB;

/** El `.ods` de la cabecera; cada llamada lleva otra foto y otro SVG al azar. */
export function photoOds(): Uint8Array {
  const entries: Zippable = {};
  for (const [path, data] of Object.entries(unzipSync(buildOds()))) {
    entries[path] = [data, { level: path === 'mimetype' ? 0 : 9 }];
  }
  const manifest = new TextDecoder().decode((entries['META-INF/manifest.xml'] as [Uint8Array, unknown])[0]);
  entries['META-INF/manifest.xml'] = [
    new TextEncoder().encode(
      manifest.replace(
        '</manifest:manifest>',
        ' <manifest:file-entry manifest:full-path="Pictures/foto.png" manifest:media-type="image/png"/>\n' +
          ' <manifest:file-entry manifest:full-path="Pictures/b.svg" manifest:media-type="image/svg+xml"/>\n' +
          '</manifest:manifest>'
      )
    ),
    { level: 9 }
  ];
  entries['Pictures/foto.png'] = [randomBytes(Math.floor(3.3 * MIB)), { level: 0 }];
  entries['Pictures/b.svg'] = [new TextEncoder().encode(randomBytes(MIB / 2).toString('hex')), { level: 9 }];
  return zipSync(entries);
}
