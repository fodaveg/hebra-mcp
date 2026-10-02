/**
 * `WriteContext` (SPEC.md §5, L3b): lo que las herramientas de escritura
 * (`hebra_create_note`, `hebra_append_to_note`, `hebra_edit_note`) necesitan de la
 * instancia, sin acoplar `src/server` al tipo concreto `LibraryInstance`
 * (`src/sync/library-instance.ts`) — mismo patrón estructural que `InstanceStatusLike` de
 * `src/status/status-source.ts`.
 *
 * `requestRound` de `WriteContextSources` SIEMPRE está presente: en producción pide la
 * ronda al `SyncRunner` de la instancia (`localWriteContext` de `./serve.ts`), y sin
 * emparejar (L2) resuelve `null`; en tests sin motor de sync, una función que resuelve
 * ya. Así `buildWriteContext` no necesita saber si hay sync o no: lo deduce de lo que
 * resuelve la ronda (`RoundWait`).
 */
import type { NoteRow } from '../hebra';
import type {
  AppendToNoteInput,
  AppendToNoteResult,
  CreateNoteInput,
  CreateNoteResult,
  EditNoteInput,
  EditNoteSaved,
  OrganizeInput,
  OrganizeSaved,
  RestoreVersionInput,
  FetchAttachmentInput,
  LocalWrite
} from '../store/writes';
import type { SyncConflictCopy } from '../sync/runner';

export interface WriteContextSources {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult>;
  /** El guardado local de una edición (`NoteWriter.editNoteLocal`), sin esperar ronda.
   *  `wrote: false`: no escribió nada (sin cambios o reintento): no se pide ronda. */
  editNote(input: EditNoteInput): Promise<LocalWrite<EditNoteSaved>>;
  /** Anota en el registro de idempotencia la copia de conflicto que produjo la ronda. */
  recordEditConflict(operationId: string, id: string, copyId: string): Promise<void>;
  /** La organización local (`NoteWriter.organizeLocal`), sin esperar ronda. */
  organize(input: OrganizeInput): Promise<LocalWrite<OrganizeSaved>>;
  /** Restaurar una versión en local (`NoteWriter.restoreVersionLocal`), sin esperar ronda. */
  restoreVersion(input: RestoreVersionInput): Promise<LocalWrite<EditNoteSaved>>;
  /** Traer al disco los bytes de un adjunto (`LibraryInstance.fetchAttachment`). */
  fetchAttachment(input: FetchAttachmentInput): Promise<boolean>;
  /** Para saber si lo escrito ya subió (`dirty`). */
  noteRead(id: string): Promise<NoteRow | null>;
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void;
  /**
   * Si esta instancia tiene sync (está emparejada). Solo se consulta cuando una escritura
   * no escribió nada y por eso no pide ronda: con ronda, `not_linked` se deduce de que
   * `requestRound` resuelve `null`.
   */
  isLinked(): boolean;
  /**
   * Pide una ronda de sync (SPEC.md §8: «una ronda justo después de cada escritura») y
   * resuelve con su resultado: un objeto con `result` (código cerrado del motor,
   * `SyncRoundResult` de Hebra) o `null` si no hay sync configurado.
   */
  requestRound(): Promise<unknown>;
}

/** Cómo terminó la espera de la ronda de después de escribir. */
export type RoundWait =
  | { kind: 'done'; result: string }
  | { kind: 'timeout' }
  | { kind: 'no_sync' };

/**
 * Estado de sync de lo recién escrito (D2 ampliada, 28 sep 2026), para que el agente
 * distinga «guardado y subido» de «guardado, falta subir» y de «la ronda falló»:
 * - `uploaded`: la ronda terminó bien y la nota ya no está sucia.
 * - `pending`: guardado en local; la ronda no terminó a tiempo, o terminó y la nota sigue
 *   sucia (otra escritura entre medias, un registro con error). La ronda periódica lo
 *   subirá.
 * - `error`: la ronda terminó con un código distinto de `ok` (`syncError`: `offline`,
 *   `http_5xx`, `revoked`…). Lo guardado sigue en local y se reintenta en la siguiente.
 * - `not_linked`: esta instancia no está emparejada; lo guardado no sube hasta `pair`.
 */
export type SyncState = 'uploaded' | 'pending' | 'error' | 'not_linked';

export interface SyncFields {
  sync: SyncState;
  syncError?: string;
}

/** Lo que devuelve `hebra_edit_note`: el guardado y su estado de sync. */
export type EditNoteOutcome = EditNoteSaved & SyncFields;

/** Lo que devuelven las herramientas de organización antes de poner rutas. */
export type OrganizeOutcome = OrganizeSaved & SyncFields;

export interface WriteContext {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult>;
  /**
   * Edición completa: guarda, espera la ronda como mucho `AWAIT_ROUND_TIMEOUT_MS` y
   * devuelve el estado de sync. Si la ronda produce una copia de conflicto PARA ESTA nota,
   * `conflict_copy` con su id (sin reintento automático). En un lector, todo esto ocurre
   * en el escritor (`./forward.ts`).
   */
  editNote(input: EditNoteInput): Promise<EditNoteOutcome>;
  /** Organización completa: escribe, espera la ronda y devuelve el estado de sync. En un
   *  lector, todo ocurre en el escritor (`./forward.ts`). */
  organize(input: OrganizeInput): Promise<OrganizeOutcome>;
  /** Restaurar una versión: lo mismo que `editNote` (ronda, estado de sync y copia de
   *  conflicto de la ronda anotada en el registro), con la versión en vez de las
   *  sustituciones. */
  restoreVersion(input: RestoreVersionInput): Promise<EditNoteOutcome>;
  /** Adjuntos en solo lectura: que los bytes estén en el disco compartido (los baja el
   *  escritor si hace falta; un lector se lo pide por `writer.sock`). No los devuelve:
   *  los lee la herramienta con su filtro. `available: false` si no se pudieron traer. */
  fetchAttachment(input: FetchAttachmentInput): Promise<{ available: boolean }>;
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void;
  /**
   * Pide una ronda y espera a que termine, como mucho `timeoutMs` (SPEC.md §5,
   * `hebra_append_to_note`: 10 s). Nunca rechaza: un timeout o un fallo de la ronda no
   * deshacen una escritura que ya está confirmada en disco, la ronda periódica la
   * subirá más tarde.
   */
  awaitRound(timeoutMs: number): Promise<RoundWait>;
}

/** Cuánto espera una escritura a la ronda de después de guardar (SPEC.md §5). */
export const AWAIT_ROUND_TIMEOUT_MS = 10_000;

/**
 * Añadir y esperar la ronda (SPEC.md §5, §8), sin filtro de privados ni límites: eso es
 * de la herramienta. Lo usan `hebra_append_to_note` en el escritor y el socket del
 * escritor cuando se lo reenvía un lector (`./forward.ts`), para que las dos vías den
 * el mismo `outcome`.
 *
 * Se suscribe a `onConflictCopy` ANTES de escribir, para no perderse una copia que la
 * ronda produzca mientras el guardado ya está en marcha.
 * - Si el propio guardado sale `conflict_copy` (`redirected` del almacén), se devuelve
 *   ya, sin esperar ronda.
 * - Si sale `saved`, se pide una ronda y se espera hasta `timeoutMs` (`awaitRound`): si
 *   durante esa espera llega una copia de conflicto PARA ESTA nota (otro dispositivo la
 *   editó a la vez), el resultado es igual `conflict_copy` con esa copia.
 * El listener se da de baja siempre, gane o pierda la carrera.
 */
export async function appendAndAwaitRound(
  write: WriteContext,
  input: AppendToNoteInput,
  timeoutMs = AWAIT_ROUND_TIMEOUT_MS
): Promise<AppendToNoteResult> {
  let raceCopyId: string | undefined;
  const unsubscribe = write.onConflictCopy((copy) => {
    if (copy.recordId === input.id && raceCopyId === undefined) raceCopyId = copy.copyId;
  });
  try {
    const saved = await write.appendToNote(input);
    if (saved.outcome === 'conflict_copy') return saved;
    await write.awaitRound(timeoutMs);
    return raceCopyId === undefined
      ? saved
      : { id: input.id, outcome: 'conflict_copy', copyId: raceCopyId };
  } finally {
    unsubscribe();
  }
}

/** `RoundWait` de lo que resolvió `requestRound`: un resultado del motor, o nada. */
function roundWaitOf(value: unknown): RoundWait {
  const result = (value as { result?: unknown } | null | undefined)?.result;
  return typeof result === 'string' ? { kind: 'done', result } : { kind: 'no_sync' };
}

/** `SyncFields` de la espera y de si la fila escrita sigue sucia (`null`: no se sabe). */
export function syncFieldsOf(wait: RoundWait, dirty: boolean | null): SyncFields {
  switch (wait.kind) {
    case 'no_sync':
      return { sync: 'not_linked' };
    case 'timeout':
      return { sync: 'pending' };
    case 'done':
      if (wait.result !== 'ok') return { sync: 'error', syncError: wait.result };
      return { sync: dirty === false ? 'uploaded' : 'pending' };
  }
}

export interface WriteContextOptions {
  /** Tests: espera más corta a la ronda. */
  roundTimeoutMs?: number;
}

export function buildWriteContext(
  sources: WriteContextSources,
  options: WriteContextOptions = {}
): WriteContext {
  const roundTimeoutMs = options.roundTimeoutMs ?? AWAIT_ROUND_TIMEOUT_MS;

  function awaitRound(timeoutMs: number): Promise<RoundWait> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<RoundWait>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      timer.unref?.();
    });
    const round = sources.requestRound().then(roundWaitOf, (): RoundWait => ({
      kind: 'done',
      result: 'unknown'
    }));
    return Promise.race([round, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function dirtyOf(id: string): Promise<boolean | null> {
    try {
      const row = await sources.noteRead(id);
      return row ? row.dirty : null;
    } catch {
      return null;
    }
  }

  /** Guardado con revisión (`editNote`, `restoreVersion`): guarda, espera la ronda y,
   *  si la ronda produjo una copia de conflicto PARA ESTA nota, la devuelve y la anota
   *  en el registro de idempotencia. */
  /** `SyncFields` de una escritura que no escribió nada: sin ronda ni espera. */
  async function syncFieldsWithoutRound(id: string): Promise<SyncFields> {
    if (!sources.isLinked()) return { sync: 'not_linked' };
    return { sync: (await dirtyOf(id)) === false ? 'uploaded' : 'pending' };
  }

  async function saveAndAwaitRound(
    input: { id: string; operationId: string },
    save: () => Promise<LocalWrite<EditNoteSaved>>
  ): Promise<EditNoteOutcome> {
    let raceCopyId: string | undefined;
    const unsubscribe = sources.onConflictCopy((copy) => {
      if (copy.recordId === input.id && raceCopyId === undefined) raceCopyId = copy.copyId;
    });
    try {
      const { result: saved, wrote } = await save();
      if (!wrote) {
        // Sin cambios o reintento: nada que subir, ni ronda ni espera. Un reintento de una
        // edición que acabó en copia de conflicto ya la trae del registro (`saved`).
        const target = saved.outcome === 'conflict_copy' ? saved.copyId : saved.id;
        return { ...saved, ...(await syncFieldsWithoutRound(target)) };
      }
      const wait = await awaitRound(roundTimeoutMs);
      let result: EditNoteSaved = saved;
      if (saved.outcome === 'saved' && raceCopyId !== undefined) {
        // Otro dispositivo editó la misma nota: el motor dejó el texto de la edición en
        // una copia visible. Sin reintento automático; queda anotado para un reintento
        // con el mismo `operationId`.
        result = { id: saved.id, outcome: 'conflict_copy', copyId: raceCopyId };
        if (saved.replayed) result.replayed = true;
        await sources
          .recordEditConflict(input.operationId, input.id, raceCopyId)
          .catch(() => undefined);
      }
      const target = result.outcome === 'conflict_copy' ? result.copyId : result.id;
      return { ...result, ...syncFieldsOf(wait, await dirtyOf(target)) };
    } finally {
      unsubscribe();
    }
  }

  return {
    createNote: (input) => sources.createNote(input),
    appendToNote: (input) => sources.appendToNote(input),
    onConflictCopy: (listener) => sources.onConflictCopy(listener),
    awaitRound,
    editNote: (input: EditNoteInput) => saveAndAwaitRound(input, () => sources.editNote(input)),
    restoreVersion: (input: RestoreVersionInput) =>
      saveAndAwaitRound(input, () => sources.restoreVersion(input)),
    fetchAttachment: async (input: FetchAttachmentInput) => ({
      available: await sources.fetchAttachment(input)
    }),
    async organize(input: OrganizeInput): Promise<OrganizeOutcome> {
      const { result: saved, wrote } = await sources.organize(input);
      if (!wrote) return { ...saved, ...(await syncFieldsWithoutRound(saved.id)) };
      const wait = await awaitRound(roundTimeoutMs);
      return { ...saved, ...syncFieldsOf(wait, await dirtyOf(saved.id)) };
    }
  };
}
