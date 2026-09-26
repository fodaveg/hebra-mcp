/**
 * `WriteContext` (SPEC.md §5, L3b): lo que las herramientas de escritura
 * (`hebra_create_note`, `hebra_append_to_note`) necesitan de la instancia, sin acoplar
 * `src/server` al tipo concreto `LibraryInstance` (`src/sync/library-instance.ts`) —
 * mismo patrón estructural que `InstanceStatusLike` de `src/status/status-source.ts`.
 *
 * `requestRound` de `WriteContextSources` SIEMPRE está presente: en producción es
 * `instance.syncRunner?.requestRound() ?? Promise.resolve(null)` (sin emparejar, L2,
 * no hay ronda que pedir); en tests sin motor de sync, una función que resuelve ya.
 * Así `buildWriteContext` no necesita saber si hay sync o no.
 */
import type {
  AppendToNoteInput,
  AppendToNoteResult,
  CreateNoteInput,
  CreateNoteResult
} from '../store/writes';
import type { SyncConflictCopy } from '../sync/runner';

export interface WriteContextSources {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult>;
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void;
  /** Pide una ronda de sync (SPEC.md §8: «una ronda justo después de cada escritura»).
   *  Sin sync configurado, resuelta ya: no hay nada que pedir. */
  requestRound(): Promise<unknown>;
}

export interface WriteContext {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult>;
  onConflictCopy(listener: (copy: SyncConflictCopy) => void): () => void;
  /**
   * Pide una ronda y espera a que termine, como mucho `timeoutMs` (SPEC.md §5,
   * `hebra_append_to_note`: 10 s). Nunca rechaza: un timeout o un fallo de la ronda no
   * deshacen una escritura que ya está confirmada en disco, la ronda periódica la
   * subirá más tarde.
   */
  awaitRound(timeoutMs: number): Promise<void>;
}

/** Cuánto espera `hebra_append_to_note` a la ronda de después de guardar (SPEC.md §5). */
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

export function buildWriteContext(sources: WriteContextSources): WriteContext {
  return {
    createNote: (input) => sources.createNote(input),
    appendToNote: (input) => sources.appendToNote(input),
    onConflictCopy: (listener) => sources.onConflictCopy(listener),
    awaitRound(timeoutMs: number): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      const round = sources.requestRound().then(
        () => undefined,
        () => undefined
      );
      return Promise.race([round, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }
  };
}
