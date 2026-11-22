/**
 * Hilo de los trabajos de documentos (`.ods`, `.odp`): lo arranca `runDocumentJob`
 * (`./store/document-jobs.ts`) con `workerData = { kind, input }`, hace UN trabajo y responde
 * un solo mensaje:
 * - `{ ok: true, result }`
 * - `{ ok: false, code }`, con un código cerrado. Nunca viaja el texto de un error: podría
 *   repetir contenido del documento.
 *
 * Es un punto de entrada propio del empaquetado (`dist/document-worker.mjs`, B-I01). Cada
 * tipo de trabajo carga su módulo bajo demanda, así que un hilo de lectura no paga el coste
 * del motor de lectura o edición. Los módulos de lectura y edición los añaden sus paquetes.
 *
 * El render (`renderSvgToPng`, `../render/render.ts`) NO pasa por aquí (B-LR21): tiene un solo
 * camino de pintado, su propio hilo, y reserva su memoria en la misma compuerta.
 */
import { parentPort, workerData } from 'node:worker_threads';

/** Lo que un módulo de trabajo exporta: una función de entrada a resultado. */
type JobModule = { run(input: unknown): unknown | Promise<unknown> };

/** Cargadores por tipo (`read`, `edit`): los registran sus paquetes con un `import()` literal. */
const LOADERS: Record<string, (() => Promise<JobModule>) | undefined> = {
  // `hebra_read_sheet` (H-78). Solo sabe leer `.ods`: otro formato responde `op_unsupported`.
  // Cuando las presentaciones lean por aquí, este cargador tendrá que elegir por `input.format`.
  read: () => import('./server/tools/read-sheet-job')
};

/** Resultado de un trabajo; `code` es siempre uno de un conjunto cerrado de la capa de llamada. */
export type DocumentJobReply = { ok: true; result: unknown } | { ok: false; code: string };

/** Ejecuta un trabajo y lo convierte en respuesta. No rechaza nunca. */
export async function handleDocumentJob(kind: string, input: unknown): Promise<DocumentJobReply> {
  const load = LOADERS[kind];
  if (!load) return { ok: false, code: 'document_job_unknown_kind' };
  try {
    const module = await load();
    return { ok: true, result: await module.run(input) };
  } catch {
    return { ok: false, code: 'document_job_failed' };
  }
}

if (parentPort) {
  const { kind, input } = workerData as { kind: string; input: unknown };
  const port = parentPort;
  void handleDocumentJob(kind, input).then((reply) => port.postMessage(reply));
}
