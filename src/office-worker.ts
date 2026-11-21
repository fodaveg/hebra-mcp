/**
 * Hilo de la conversión de ofimática (C-27): lo arranca `runOfficeConversion`
 * (`./store/office-runner.ts`) con `workerData = { kind, input }`, hace UN trabajo y responde un
 * solo mensaje:
 * - `{ ok: true, result }`
 * - `{ ok: false, code, userMessage }`, con un `ConversionFailureCode` cerrado. Solo un
 *   `ConversionError` aporta su `userMessage` (el contrato lo define sin contenido del
 *   documento); cualquier otro fallo responde `internal` sin su texto.
 *
 * Es un punto de entrada propio del empaquetado (`dist/office-worker.mjs`, C-38). El
 * convertidor se carga por el registro de Hebra (`converter-table`), que hoy está vacío: cada
 * formato lo da de alta su paquete. El convertidor es quien pasa `OFFICE_ZIP_LIMITS` y un
 * `select` con solo las partes XML a `readSafeZip` (las imágenes se leen aparte, para que no
 * entren en el tope de 12 MiB de XML expandido).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { converterTable } from '../vendor/hebra/src/lib/office-import/converter-table';
import { createOfficeRegistry } from '../vendor/hebra/src/lib/office-import/registry';
import {
  ConversionError,
  type ConversionFailureCode,
  type OfficeConverter,
  type OfficeFormat
} from '../vendor/hebra/src/lib/office-import/types';
import { OFFICE_ZIP_LIMITS } from './server/tools/office-limits';
import type { OfficeJobData } from './store/office-runner';

/** Respuesta del hilo; `code` es siempre un código cerrado del contrato. */
export type OfficeJobReply =
  | { ok: true; result: unknown }
  | { ok: false; code: ConversionFailureCode; userMessage: string };

/** Quién da el convertidor de un formato. Los tests pasan el suyo. */
export type LoadConverter = (format: OfficeFormat) => Promise<OfficeConverter>;

const registry = createOfficeRegistry(converterTable);
const defaultLoad: LoadConverter = (format) => registry.load(format);

/** Ejecuta un trabajo y lo convierte en respuesta. No rechaza nunca. */
export async function handleOfficeJob(
  job: OfficeJobData,
  load: LoadConverter = defaultLoad
): Promise<OfficeJobReply> {
  try {
    const converter = await load(job.input.format);
    // El hilo muere con `terminate()`: no hay quien aborte esta señal, solo la pide el contrato.
    // `limits` es el presupuesto de memoria del MCP (C-07c): el convertidor lo pasa a `readSafeZip`.
    const input = { ...job.input, signal: new AbortController().signal, limits: OFFICE_ZIP_LIMITS };
    const result = job.kind === 'analyze' ? await converter.analyze(input) : await converter.convert(input);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof ConversionError) return { ok: false, code: error.code, userMessage: error.userMessage };
    return { ok: false, code: 'internal', userMessage: 'No se pudo convertir el documento.' };
  }
}

if (parentPort) {
  const port = parentPort;
  void handleOfficeJob(workerData as OfficeJobData).then((reply) => port.postMessage(reply));
}
