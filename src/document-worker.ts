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
 * del motor de render. Los módulos de lectura y edición los añaden sus paquetes.
 */
import { parentPort, workerData } from 'node:worker_threads';

/** Lo que un módulo de trabajo exporta: una función de entrada a resultado. */
type JobModule = { run(input: unknown): unknown | Promise<unknown> };

/**
 * Cargadores por tipo. El especificador de `render` va en una constante para que la
 * comprobación de tipos no exija el módulo antes de que exista (`B-LR20`); el empaquetado
 * lo resuelve en `B-I01`.
 */
const RENDER_MODULE = './render/resvg-job.js';
const LOADERS: Record<string, (() => Promise<JobModule>) | undefined> = {
  render: () => import(RENDER_MODULE) as Promise<JobModule>
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
