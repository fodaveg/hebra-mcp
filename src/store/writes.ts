/**
 * Las dos únicas escrituras de v1 (D2, SPEC.md §5 «Detalle de las escrituras»), sobre
 * el almacén. NO son las herramientas MCP (`hebra_create_note`/`hebra_append_to_note`
 * son L3b): aquí no hay límites de longitud, filtro de privados ni esquema de salida.
 * Nada de mover, etiquetar, reescribir ni borrar.
 *
 * - `createNote`: `noteCreate(folderId)` + `noteSave` con los derivados de
 *   `deriveNote(body)`, en UN turno de la cola del almacén (`writeExclusive`): una ronda
 *   de sync no puede colarse entre los dos pasos y subir la nota vacía.
 * - `appendToNote`: `noteRead` → `body + "\n\n" + text` → `noteSave` con
 *   `expectedLocalSeq` y `baseBodySha256` de lo leído. Si el almacén responde
 *   `redirected` (la nota cambió o es una lápida), el texto quedó en una copia de
 *   conflicto visible: `conflict_copy` con su id. Si el choque llega después, con la
 *   ronda (otro dispositivo editó la misma nota), lo resuelve la tabla de §7 del almacén
 *   con otra copia, y el motor lo avisa con `sync.conflict_copy` (`SyncRunner`).
 *
 * Después de cada escritura, `onWritten` (la instancia lo conecta a
 * `SyncRunner.requestRound`, SPEC.md §8: «una ronda justo después de cada escritura»).
 */
import {
  deriveNote,
  LibraryError,
  type NoteRow,
  type NoteSaveInput,
  type NoteSaveResult
} from '../hebra';

/** Acceso directo del motor dentro de un turno de la cola (`NodeLibraryPort`). */
export interface NoteWriteStore {
  noteCreate(folderId?: string | null): Promise<NoteRow>;
  noteRead(id: string): Promise<NoteRow | null>;
  noteSave(input: NoteSaveInput): Promise<NoteSaveResult>;
}

/** Lo que `NoteWriter` necesita del almacén: un turno exclusivo de la cola. Rechaza con
 *  `busy_other_instance` si esta instancia no es el escritor único. */
export interface NoteWriteTarget {
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
}

export interface CreateNoteInput {
  /** Markdown; el primer H1 es el título, como en Hebra. */
  body: string;
  /** Carpeta existente; `null`/ausente = la raíz. */
  folderId?: string | null;
}

export interface CreateNoteResult {
  id: string;
  title: string;
  folderId: string;
}

export interface AppendToNoteInput {
  id: string;
  text: string;
}

export type AppendToNoteResult =
  | { id: string; outcome: 'saved' }
  | { id: string; outcome: 'conflict_copy'; copyId: string };

/** Separador entre el cuerpo existente y lo añadido (SPEC.md §5). */
export const APPEND_SEPARATOR = '\n\n';

/** `NoteSaveInput` completo para `body`: derivados de Hebra y la base leída. */
export function saveInputFor(note: NoteRow, body: string): NoteSaveInput {
  const derived = deriveNote(body);
  return {
    id: note.id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props,
    expectedLocalSeq: note.localSeq,
    baseBodySha256: note.bodySha256
  };
}

export interface NoteWriterOptions {
  /** Tras cada escritura confirmada. Un fallo aquí no deshace ni oculta la escritura. */
  onWritten?: () => void;
}

export class NoteWriter {
  constructor(
    private readonly target: NoteWriteTarget,
    private readonly options: NoteWriterOptions = {}
  ) {}

  private written(): void {
    try {
      this.options.onWritten?.();
    } catch {
      // La escritura ya está en disco; la ronda periódica la subirá.
    }
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const note = await store.noteCreate(input.folderId ?? null);
      const saved = await store.noteSave(saveInputFor(note, input.body));
      // Recién creada, nadie más la conoce: `redirected` aquí sería un fallo del motor,
      // no un conflicto. Se devuelve igual el id donde quedó el texto.
      const id = saved.outcome === 'saved' ? note.id : saved.redirectedTo;
      const row = await store.noteRead(id);
      return { id, title: row?.title ?? '', folderId: row?.folderId ?? note.folderId };
    });
    this.written();
    return result;
  }

  /**
   * Añade `text` al final de la nota `id`. `note_not_found` (`LibraryError` de Hebra) si
   * no existe o está en la papelera: las herramientas nunca devuelven notas de la
   * papelera (SPEC.md §5), así que tampoco se escribe en ellas.
   */
  async appendToNote(input: AppendToNoteInput): Promise<AppendToNoteResult> {
    const result = await this.target.writeExclusive(async (store) => {
      const note = await store.noteRead(input.id);
      if (!note || note.trashedAt !== null) throw new LibraryError('note_not_found');
      const saved = await store.noteSave(
        saveInputFor(note, `${note.body}${APPEND_SEPARATOR}${input.text}`)
      );
      return saved.outcome === 'saved'
        ? ({ id: input.id, outcome: 'saved' } as const)
        : ({ id: input.id, outcome: 'conflict_copy', copyId: saved.redirectedTo } as const);
    });
    this.written();
    return result;
  }
}
