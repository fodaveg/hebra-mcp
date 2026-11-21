/**
 * Escritor de `hebra_import_office` (paquete C-26 del plan de importación común, D-3, D-4 y
 * R-04): `importOfficeLocal` convierte FUERA del turno y escribe DENTRO de un solo turno de
 * `writeExclusive`, con el orden de `commitImport` de Hebra (`vendor/hebra`) y la regla 2: si
 * la conversión falla, el original se guarda siempre.
 *
 * Fuera del turno (no se retiene la cola mientras corre el convertidor):
 * 1. Se valida la entrada sin tocar el almacén (nombre, extensión, tamaño, modo, `operationId`).
 * 2. `preview` solo analiza y vuelve: no abre turno ni escribe.
 * 3. Se convierte (`OfficeConversionRunner`: C-27 pone el hilo con corte duro y C-37 lo cablea)
 *    y se valida la salida con `validateConversion`. Un fallo no se lanza: es el motivo con el
 *    que se guardará el original.
 *
 * Dentro del turno, antes de escribir nada:
 * 4. Idempotencia (`hebra_mcp_operations`, huella propia): otro `operationId` con otra petición,
 *    `operation_id_reused`; uno terminado con la misma, lo anotado con `replayed` si lo que
 *    nombra se sigue viendo.
 * 5. `assertOfficeWritable` (C-29): carpeta y origen visibles y nota resultante no oculta por
 *    sus etiquetas, todo `not_found`. El rol de escritura del espacio de destino ya lo
 *    comprobó el turno (`NodeLibraryPort.writeExclusive`): un espacio de solo lectura rechaza
 *    con `client_outdated` y este callback ni corre.
 * 6. Los ficheros nuevos (el original y una conversión en forma de fichero) pasan las mismas
 *    comprobaciones que `./file-verbs.ts` al crear: un homónimo visible con otros bytes es
 *    `file_exists`, y un nombre o unos bytes que dejaría oculta una nota oculta,
 *    `file_name_unavailable`. Un homónimo con los MISMOS bytes se reutiliza.
 *
 * Reintento tras un corte (el turno no es atómico entre `blobPut`, `fileCreate`, `noteCreate`
 * y `noteSave`, que confirman cada uno su transacción), sin duplicar:
 * - Un fichero ya creado se reconoce por nombre y bytes en la carpeta (paso 6) y se reutiliza.
 * - La nota convertida tiene un id fijo, sacado del `operationId` (`importNoteId`), y entra con
 *   `libraryImportBatch` del turno: en la biblioteca personal es UNA transacción con el cuerpo
 *   entero (no hay nota vacía que se vea) y reintentar da `unchanged`; en un espacio, fila
 *   vacía y `noteSave`, y un reintento rellena la fila que dejó el corte.
 * - Con `convert-only` sobre un fichero de la biblioteca, el origen se manda a la papelera al
 *   final; si el corte llega después, el reintento lo ve en la papelera y no lo repite.
 *
 * Con un `sourceFileId` el original ya está en la biblioteca: nunca se copia. `convert-only`
 * lo manda a la papelera cuando la conversión sale bien; si falla, se queda donde está.
 */
import { createHash } from 'node:crypto';
import { commitImport, type ConversionAttempt } from '../../vendor/hebra/src/lib/office-import/commit';
import type { OfficeCommitPort } from '../../vendor/hebra/src/lib/office-import/flow-types';
import { importNoteId } from '../../vendor/hebra/src/lib/office-import/ids';
import {
  composeNoteBody,
  personalNoteCreator,
  spaceNoteCreator
} from '../../vendor/hebra/src/lib/office-import/note-creators';
import {
  ConversionError,
  type ConversionBlockReason,
  type ConversionLoss,
  type ConversionPreview,
  type ConversionResult,
  type OfficeFormat,
  type OfficeImportMode
} from '../../vendor/hebra/src/lib/office-import/types';
import { validateConversion } from '../../vendor/hebra/src/lib/office-import/validate-output';
import { MAX_NOTE_MARKDOWN_BYTES, markdownByteLength } from '../../vendor/hebra/src/lib/notes/limits';
import type { PrivacyConfig } from '../privacy/config';
import { OFFICE_FILE_ID_MAX_BYTES } from '../server/tools/office-limits';
import { existingFileRejected, writeRejected } from './errors';
import { nameExtension, validFileName } from './file-content';
import { assertOfficeWritable } from './office-guards';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import {
  hiddenOperationTarget,
  looseFilesFilterInTurn,
  priorOperation,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Lo que el convertidor recibe: sin señal ni plazo, que pone quien lo ejecuta (C-27). */
export interface OfficeConversionJob {
  bytes: Uint8Array;
  fileName: string;
  format: OfficeFormat;
}

/**
 * El convertidor, fuera del turno. En producción es el hilo de C-27 (`runOfficeConversion`, con
 * reserva de memoria y corte duro); en los tests, un doble. Un fallo se lanza como
 * `ConversionError`; cualquier otro error cuenta como `internal`.
 */
export interface OfficeConversionRunner {
  analyze(job: OfficeConversionJob): Promise<ConversionPreview>;
  convert(job: OfficeConversionJob): Promise<ConversionResult>;
}

/** Lo que recibe el escritor (el `OfficeImportWriteInput` de `hebra_import_office`). */
export interface OfficeImportInput {
  bytes: Uint8Array;
  fileName: string;
  format: OfficeFormat;
  mode: OfficeImportMode;
  preview: boolean;
  /** Carpeta de destino, por id (`"root"` es la raíz). */
  folderId: string;
  /** El fichero de la biblioteca de que parte la importación, si lo hay. */
  sourceFileId?: string;
  /** Obligatorio salvo con `preview`. */
  operationId?: string;
  /** La configuración de privados de quien pide. */
  privacy: PrivacyConfig;
}

/** Lo que queda escrito, con la prueba leída del almacén. */
export interface OfficeImportSaved {
  /** `converted`: hay conversión; `kept_original`: solo el original; `already`: `keep-only`
   *  sin nada que escribir (el original ya estaba); `preview`: solo se analizó. */
  outcome: 'converted' | 'kept_original' | 'already' | 'preview';
  /** `true` si la conversión salió bien o el análisis dice que se puede. En `keep-only` no se
   *  analiza y es `false`, sin `reason`. */
  convertible: boolean;
  reason?: ConversionBlockReason;
  losses: ConversionLoss[];
  note?: { id: string; title: string };
  convertedFile?: { id: string; name: string; sha256: string };
  original?: { id: string; name: string; sha256: string; trashed?: boolean };
  replayed?: true;
}

export interface OfficeImportDeps {
  converter: OfficeConversionRunner;
}

const BLOCK_REASONS: readonly string[] = ['encrypted', 'corrupt', 'too_large', 'unsupported_version'];
const MODES: readonly OfficeImportMode[] = ['convert-and-keep', 'convert-only', 'keep-only'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Tipo con que se guarda el original, por formato. */
const ORIGINAL_MIME: Record<OfficeFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Nombre para comparar sin distinguir mayúsculas ni la forma de una tilde (NFC), como
 *  `./file-verbs.ts`. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function blockReasonOf(code: string): ConversionBlockReason | undefined {
  return BLOCK_REASONS.includes(code) ? (code as ConversionBlockReason) : undefined;
}

/** Lo que se valida sin el almacén, otra vez aunque la herramienta ya lo mirara (la petición
 *  puede llegar de un lector por `writer.sock`). */
function validate(input: OfficeImportInput): void {
  if (!MODES.includes(input.mode)) throw writeRejected('invalid_input');
  if (input.folderId.length === 0) throw writeRejected('invalid_input');
  if (input.sourceFileId !== undefined && input.sourceFileId.length === 0) {
    throw writeRejected('invalid_input');
  }
  const name = validFileName(input.fileName);
  if (name === null || name !== input.fileName || nameExtension(name) !== input.format) {
    throw writeRejected('invalid_input');
  }
  if (input.bytes.length === 0) throw writeRejected('invalid_input');
  if (input.bytes.length > OFFICE_FILE_ID_MAX_BYTES) throw writeRejected('file_too_large');
  if (!input.preview) {
    const id = input.operationId;
    if (id === undefined || id.length === 0 || id.length > OPERATION_ID_MAX_LENGTH) {
      throw writeRejected('invalid_input');
    }
  }
}

/** Huella de la petición (comparte registro con las demás escrituras): la acción va en ella,
 *  así que un `operationId` de otra operación da `operation_id_reused`. Los bytes, por su hash. */
function fingerprintOf(input: OfficeImportInput): string {
  const parts = [
    'officeImport',
    input.mode,
    input.folderId,
    input.sourceFileId ?? null,
    input.fileName,
    sha256Of(input.bytes)
  ];
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Un `OfficeImportSaved` del registro (no se fía de su forma). */
export function isOfficeImportSaved(value: unknown): value is OfficeImportSaved {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const file = (entry: unknown): boolean =>
    entry === undefined ||
    (typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).id === 'string' &&
      typeof (entry as Record<string, unknown>).name === 'string' &&
      SHA256_HEX.test(String((entry as Record<string, unknown>).sha256)));
  const note = record.note as Record<string, unknown> | undefined;
  return (
    (record.outcome === 'converted' || record.outcome === 'kept_original' || record.outcome === 'already') &&
    typeof record.convertible === 'boolean' &&
    Array.isArray(record.losses) &&
    (note === undefined || (typeof note.id === 'string' && typeof note.title === 'string')) &&
    file(record.convertedFile) &&
    file(record.original)
  );
}

/** El intento de conversión, con el motivo de bloqueo si lo hay (cifrado, corrupto...). */
type Attempt = ConversionAttempt & { reason?: ConversionBlockReason };

/** Convierte y valida la salida. Nunca lanza: un fallo es el motivo con que se guarda el original. */
async function attemptConversion(
  job: OfficeConversionJob,
  runner: OfficeConversionRunner
): Promise<Attempt> {
  let result: ConversionResult;
  try {
    result = await runner.convert(job);
  } catch (error) {
    if (error instanceof ConversionError) {
      const reason = blockReasonOf(error.code);
      return {
        ok: false,
        failure: error.code,
        userMessage: error.userMessage,
        ...(reason ? { reason } : {})
      };
    }
    return { ok: false, failure: 'internal', userMessage: 'No se pudo convertir el archivo.' };
  }
  const checked = await validateConversion(result);
  if (!checked.ok) {
    return {
      ok: false,
      failure: 'invalid_output',
      userMessage: 'La conversión no produjo un resultado válido.'
    };
  }
  return { ok: true, result };
}

/** `preview`: el análisis, sin escribir. Un fallo del análisis es "no convertible". */
async function previewOf(input: OfficeImportInput, runner: OfficeConversionRunner): Promise<OfficeImportSaved> {
  const job = { bytes: input.bytes, fileName: input.fileName, format: input.format };
  try {
    const preview = await runner.analyze(job);
    return preview.convertible
      ? { outcome: 'preview', convertible: true, losses: [...preview.losses] }
      : { outcome: 'preview', convertible: false, reason: preview.reason, losses: [] };
  } catch (error) {
    const reason = error instanceof ConversionError ? blockReasonOf(error.code) : undefined;
    return { outcome: 'preview', convertible: false, ...(reason ? { reason } : {}), losses: [] };
  }
}

/** El nombre y los bytes de un fichero nuevo, ya vistos. */
interface NewFile {
  name: string;
  sha256: string;
}

/**
 * Importa un `.xlsx`, `.pptx` o `.docx` en local (ver la cabecera). `onWritten` pide la ronda
 * de después; solo se llama si se escribió algo.
 */
export async function importOfficeLocal(
  target: NoteWriteTarget,
  input: OfficeImportInput,
  deps: OfficeImportDeps,
  onWritten: () => void = () => {}
): Promise<LocalWrite<OfficeImportSaved>> {
  validate(input);
  if (input.preview) {
    return { result: await previewOf(input, deps.converter), wrote: false };
  }
  const operationId = input.operationId!;
  const fingerprint = fingerprintOf(input);
  const originalSha = sha256Of(input.bytes);
  const job = { bytes: input.bytes, fileName: input.fileName, format: input.format };

  // 3. Convertir, fuera del turno. `keep-only` no convierte.
  const attempt: Attempt =
    input.mode === 'keep-only'
      ? { ok: false, failure: 'internal' }
      : await attemptConversion(job, deps.converter);

  const outcome = await target.writeExclusive(async (store): Promise<LocalWrite<OfficeImportSaved>> => {
    const now = Date.now();
    const log = store.operations;
    const { live } = looseFilesFilterInTurn(store, input.privacy, store.filesIndex());
    const hidden = hiddenOperationTarget(store, live, input.privacy);
    const previous = priorOperation(log, operationId, fingerprint, now, hidden);

    // 4. Un reintento ya terminado.
    if (previous?.state === 'done' && isOfficeImportSaved(previous.result)) {
      const saved = previous.result;
      for (const id of [saved.note?.id, saved.convertedFile?.id, saved.original?.id]) {
        if (id !== undefined && hidden(id)) throw writeRejected('not_found');
      }
      return { result: { ...saved, replayed: true }, wrote: false };
    }

    /** Los ficheros del turno, tal como están ahora (cada escritura los cambia). */
    const filesNow = () => looseFilesFilterInTurn(store, input.privacy, store.filesIndex()).files;

    // La nota de esta importación: su id sale del `operationId`, así que un reintento la reconoce.
    const noteId = await importNoteId(operationId);
    const createNoteRow = store.isSpaceLibrary?.()
      ? spaceNoteCreator(store as never)
      : personalNoteCreator(store);

    // El origen ya en la papelera con la nota de esta importación creada: `convert-only` lo
    // mandó antes del corte y no se repite.
    let sourceTrashed = false;
    if (input.sourceFileId !== undefined && input.mode === 'convert-only') {
      const content = filesNow().contentOf(input.sourceFileId);
      sourceTrashed =
        content !== undefined && content.file.trashedAt !== null && (await store.noteRead(noteId)) !== null;
    }

    // Lo que se escribiría, decidido ya: la nota (con su cuerpo y etiquetas) o un fichero.
    const output = attempt.ok ? attempt.result.output : undefined;
    const composed = output?.kind === 'note' ? composeNoteBody(output.title, output.markdown) : undefined;
    // Demasiado grande para una nota: el original se guarda (regla 2) y no se escribe la nota.
    const effective: Attempt =
      composed && markdownByteLength(composed.body) > MAX_NOTE_MARKDOWN_BYTES
        ? { ok: false, failure: 'invalid_output', userMessage: 'La nota convertida supera los 2 MiB de Markdown.' }
        : attempt;
    const writesConversion = effective.ok;

    // 5. Guardas de privacidad (C-29), antes de escribir.
    assertOfficeWritable(
      { store, privacy: input.privacy },
      {
        folderId: input.folderId,
        ...(input.sourceFileId !== undefined && !sourceTrashed ? { sourceFileId: input.sourceFileId } : {}),
        ...(composed && writesConversion
          ? { resultTags: (composed.derived.tags ?? []).map(({ tag }) => tag) }
          : {})
      }
    );

    // 6. Los ficheros nuevos, comprobados antes de escribir el primero.
    const needsOriginal =
      input.sourceFileId === undefined && (input.mode !== 'convert-only' || !writesConversion);
    if (needsOriginal) checkNewFile(store, input, filesNow(), { name: input.fileName, sha256: originalSha });
    if (writesConversion && output?.kind === 'file') {
      checkNewFile(store, input, filesNow(), { name: output.name, sha256: sha256Of(output.bytes) });
    }

    // 7. Escribir con `commitImport`, sobre un puerto que reconoce lo ya escrito.
    const saved = new Map<string, { id: string; name: string; sha256: string }>();
    const notes = new Map<string, string>();
    let wrote = false;
    let lastError: unknown;
    const guarded = <A extends unknown[], R>(step: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        try {
          return await step(...args);
        } catch (error) {
          lastError = error;
          throw error;
        }
      };

    const port: OfficeCommitPort = {
      blobPut: guarded(async (bytes, options) => {
        wrote = true;
        return store.blobPut(bytes, options);
      }),
      saveFile: guarded(async (name, bytes, mime) => {
        const sha256 = sha256Of(bytes);
        // El original de un fichero de la biblioteca ya está: no se copia.
        if (input.sourceFileId !== undefined && name === input.fileName && sha256 === originalSha) {
          const content = filesNow().contentOf(input.sourceFileId);
          if (content && content.sha256.toLowerCase() === sha256) {
            const found = { id: input.sourceFileId, name: content.file.name, sha256 };
            saved.set(found.id, found);
            return found;
          }
        }
        const existing = checkNewFile(store, input, filesNow(), { name, sha256 });
        if (existing) {
          saved.set(existing.id, existing);
          return existing;
        }
        const put = await store.blobPut(bytes, { mime, expectedSha256: sha256 });
        wrote = true;
        const row = await store.fileCreate(input.folderId, name, put.sha256);
        const found = { id: row.id, name: row.name, sha256: row.sha256.toLowerCase() };
        saved.set(found.id, found);
        return found;
      }),
      // Con el id fijado por el `operationId`, un reintento encuentra siempre la misma nota:
      // `libraryImportBatch` ve el mismo id y responde `unchanged` (personal, una transacción) y
      // en un espacio rellena la fila vacía que dejó un corte (D-4).
      createNote: guarded(async ({ folderId, markdown, title }) => {
        const made = await createNoteRow({ id: noteId, folderId, markdown, title });
        wrote = true;
        notes.set(made.id, made.title);
        return made;
      })
    };

    const item = await commitImport({
      port,
      mode: input.mode,
      fileName: input.fileName,
      mime: ORIGINAL_MIME[input.format],
      bytes: input.bytes,
      folderId: input.folderId,
      conversion: effective,
      originalAs: 'file'
    });

    // Sin original ni conversión no se escribió nada que contar: el motivo es el del puerto.
    if (item.original === undefined && item.converted === undefined) {
      throw lastError ?? writeRejected('invalid_input');
    }

    // El original de un fichero de la biblioteca es el propio origen, haya o no pasado por el puerto.
    const source =
      input.sourceFileId === undefined ? undefined : filesNow().contentOf(input.sourceFileId);

    // 8. Con `convert-only`, el origen de la biblioteca a la papelera tras convertir.
    let trashed = sourceTrashed;
    if (
      input.mode === 'convert-only' &&
      input.sourceFileId !== undefined &&
      item.converted !== undefined &&
      !sourceTrashed
    ) {
      await store.fileTrash(input.sourceFileId);
      wrote = true;
      trashed = true;
    }

    const original =
      input.sourceFileId !== undefined
        ? source && { id: input.sourceFileId, name: source.file.name, sha256: source.sha256.toLowerCase() }
        : item.original?.id === undefined
          ? undefined
          : saved.get(item.original.id);
    const convertedId = item.converted?.id;
    const convertedFile =
      item.converted?.kind === 'file' && convertedId !== undefined ? saved.get(convertedId) : undefined;
    const noteTitle = item.converted?.kind === 'note' && convertedId !== undefined ? notes.get(convertedId) : undefined;
    const reason = item.converted ? undefined : effective.reason;
    const result: OfficeImportSaved = {
      outcome: item.converted ? 'converted' : input.mode === 'keep-only' && !wrote ? 'already' : 'kept_original',
      convertible: item.converted !== undefined,
      ...(reason ? { reason } : {}),
      losses: item.converted ? [...item.losses] : [],
      ...(item.converted?.kind === 'note' && convertedId !== undefined && noteTitle !== undefined
        ? { note: { id: convertedId, title: noteTitle } }
        : {}),
      ...(convertedFile ? { convertedFile } : {}),
      ...(original ? { original: { ...original, ...(trashed ? { trashed: true } : {}) } } : {})
    };
    const primary = result.note?.id ?? result.convertedFile?.id ?? result.original?.id ?? '';
    log.begin({ operationId, fingerprint, noteId: primary, targetBodySha256: originalSha, now });
    log.finish(operationId, result);
    return { result, wrote };
  });
  if (outcome.wrote) {
    try {
      onWritten();
    } catch {
      // Ya está en disco; la ronda periódica lo subirá.
    }
  }
  return outcome;
}

/**
 * Las comprobaciones de `./file-verbs.ts` al crear un fichero, para el original o la
 * conversión en forma de fichero. Devuelve el fichero ya existente con esos mismos bytes (se
 * reutiliza); si no hay, `undefined`. Un homónimo visible con otros bytes es `file_exists`, y
 * un nombre o unos bytes que dejaría oculta una nota oculta, `file_name_unavailable`.
 */
function checkNewFile(
  store: NoteWriteStore,
  input: Pick<OfficeImportInput, 'folderId' | 'privacy'>,
  files: ReturnType<typeof looseFilesFilterInTurn>['files'],
  file: NewFile
): { id: string; name: string; sha256: string } | undefined {
  const key = nameKey(file.name);
  for (const visible of files.visibleFiles()) {
    if (visible.trashedAt !== null || visible.folderId !== input.folderId || nameKey(visible.name) !== key) continue;
    const content = files.contentOf(visible.id);
    if (content && content.sha256.toLowerCase() === file.sha256) {
      return { id: visible.id, name: visible.name, sha256: file.sha256 };
    }
    throw existingFileRejected(visible.id);
  }
  // Las notas que enlazan el nombre o los bytes se juzgan con un filtro que también las lleva.
  const refs = [...store.notesLinkingFileName(file.name), ...store.notesLinkingBlob(file.sha256)];
  const judged = looseFilesFilterInTurn(
    store,
    input.privacy,
    store.filesIndex(),
    refs.map((ref) => ref.noteId)
  ).files;
  if (judged.wouldHide(file.name, refs)) throw writeRejected('file_name_unavailable');
  return undefined;
}
