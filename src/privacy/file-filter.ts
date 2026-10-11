/**
 * Filtro de privados de los FICHEROS SUELTOS (D10, decisión de David del 9 oct 2026:
 * «adelante con las tres»; SPEC.md §6.3). Un fichero suelto es una fila de `files` de
 * Hebra (un `.base`, un PDF que no cuelga de una nota): tiene carpeta propia y no tiene
 * etiquetas, así que `PrivacyFilter` (`./filter.ts`), que solo conoce notas vivas, no
 * sabe decidir sobre él. Este filtro decide qué ficheros puede ver el MCP:
 * `hebra_list_files` los lista, y `hebra_trash_file`/`hebra_restore_file` y, desde D15,
 * `hebra_read_file`/`hebra_replace_file_text` solo actúan sobre ellos. Un fichero oculto responde igual que uno inexistente (`not_found`), y la
 * lista no dice cuántos se saltó.
 *
 * La regla es la misma para los vivos y para los de la papelera, y tiene dos partes:
 *
 * (a) Por carpeta. Se parte de la carpeta GUARDADA del fichero y se aplica la regla de la
 *     papelera de notas (`TrashFilter.restoreFolderOf`): carpeta viva privada o
 *     subcarpeta, oculto; carpeta ya borrada, se sube por las lápidas y es oculto si la
 *     ruta es privada o si falta una fila, no tiene nombre o hay un ciclo. Lo que
 *     devuelve es la carpeta donde el fichero está o quedaría al restaurarlo (viva y
 *     visible, o la raíz), la única que se enseña.
 *
 * (b) Por referencia. Oculto si lo enlaza alguna nota oculta: una viva que
 *     `PrivacyFilter` oculta, o una de la papelera que `TrashFilter` no deja ver.
 *     «Enlaza» es una de estas tres cosas: un enlace de `links` con su nombre, un
 *     enlace de `links` con el SHA-256 de sus bytes, o una fila de `note_blob_refs` con
 *     ese SHA-256. La tercera cubre las notas BLOQUEADAS, de las que el motor no deriva
 *     enlaces (saldrían del texto cifrado) pero sí guarda los adjuntos. El cruce lo trae
 *     ya hecho `FilesIndex.refs` (`NodeLibraryPort.filesIndex`). Hace falta porque los
 *     dos mundos se solapan: el importador de Hebra crea ficheros sueltos que las notas
 *     adjuntan por `sha256:`, y los dibujos son ficheros sueltos incrustados por nombre.
 *     Sin esta parte, el adjunto de una nota privada saldría por aquí con su nombre.
 *     Coste asumido en D10: con homónimos oculta de más.
 *     Variante de las notas bloqueadas (A1 del audit de privacidad, opción cerrada decidida
 *     el 10 oct 2026): de una bloqueada no queda el NOMBRE de lo que incrustaba (va cifrado
 *     y no deriva enlaces), así que, mientras exista alguna bloqueada oculta (viva o de la
 *     papelera), se ocultan todos los ficheros que se pueden incrustar por su nombre
 *     (`linkableByName`). Coste asumido: con una sola, dejan de verse casi todos.
 *
 * Cerrado ante la duda también con las instantáneas: una nota que enlaza un fichero y que
 * el filtro de su estado (vivo o papelera) no conoce cuenta como oculta.
 *
 * Igual que los otros dos filtros, es una instantánea del almacén: se construye en cada
 * llamada (`build`) o dentro del turno del escritor (`fromSnapshot`), nunca se guarda.
 */
import { parseLinkRef } from '../hebra';
import type { FileEntry, FilesIndex, HebraLibraryPort } from '../store/types';
import type { PrivacyConfig } from './config';
import type { PrivacyFilter } from './filter';
import { TrashFilter } from './trash-filter';

/**
 * ¿Se puede incrustar este fichero por su nombre (`![[plano.pdf]]`)? Es lo que hace
 * `parseLinkRef` de Hebra con el nombre: un enlace de tipo `file` cuyo destino es ese mismo
 * nombre (una extensión con alguna letra que no sea `.md`). Uno sin extensión, un `.md`, o
 * con `#`, `|` o espacios en los extremos no se puede enlazar por nombre.
 */
function linkableByName(name: string): boolean {
  const query = parseLinkRef(name);
  return query?.targetKind === 'file' && query.target === name;
}

/** Lo que se enseña de un fichero suelto visible. Sin el SHA-256 de sus bytes y sin su
 *  carpeta guardada. */
export interface VisibleFile {
  id: string;
  name: string;
  /** Donde está o, si está en la papelera o su carpeta se borró, donde quedaría: una
   *  carpeta viva y visible, o la raíz. */
  folderId: string;
  mime: string | null;
  byteLength: number | null;
  updatedAt: number;
  /** Epoch ms, o `null` si está vivo. */
  trashedAt: number | null;
}

export class FileFilter {
  private readonly files = new Map<string, FileEntry>();
  /** Ficheros que enlaza alguna nota que no se ve (regla b). */
  private readonly hiddenByReference = new Set<string>();
  private readonly trash: TrashFilter;

  /** Hay una nota bloqueada oculta, viva o de la papelera (variante de A1): se ocultan los
   *  ficheros que se pueden incrustar por su nombre. */
  private readonly lockedHidden: boolean;

  private constructor(
    private readonly live: PrivacyFilter,
    index: FilesIndex,
    config: PrivacyConfig
  ) {
    this.trash = TrashFilter.fromSnapshot(live, index.trash, config);
    for (const file of index.files) this.files.set(file.id, file);
    for (const ref of index.refs) {
      if (this.isHiddenReference(ref)) this.hiddenByReference.add(ref.fileId);
    }
    this.lockedHidden = live.hasHiddenLockedNote() || this.trash.hasHiddenLockedNote();
  }

  /**
   * ¿Hay algún fichero suelto oculto (vivo o de la papelera) con estos bytes? Para no
   * servirlos como adjunto de una nota visible que los vuelva a enlazar por su SHA-256 (M6
   * del audit de privacidad, 10 oct 2026). `sha256` en minúsculas.
   */
  hidesContent(sha256: string): boolean {
    for (const file of this.files.values()) {
      if (file.sha256.toLowerCase() === sha256 && !this.visibleOf(file)) return true;
    }
    return false;
  }

  /** `true` si la nota que enlaza (viva o de la papelera) no se ve: la que hace oculto al
   *  fichero por la regla (b). Cerrado ante la duda: una nota que el filtro de su estado
   *  no conoce cuenta como oculta. */
  isHiddenReference(ref: { noteId: string; noteTrashed: boolean }): boolean {
    return ref.noteTrashed ? !this.trash.isVisible(ref.noteId) : this.live.isHiddenNote(ref.noteId);
  }

  /**
   * Un fichero VISIBLE con el SHA-256 de sus bytes, del mismo almacén que el filtro (D15:
   * `hebra_read_file` y `hebra_replace_file_text`); `undefined` igual que `visibleMeta`.
   * El hash solo sale de aquí para un fichero que se ve: su contenido se puede leer
   * entero, así que el hash no dice nada que el contenido no diga.
   */
  contentOf(id: string): { file: VisibleFile; sha256: string } | undefined {
    const entry = this.files.get(id);
    const file = entry ? this.visibleOf(entry) : undefined;
    return entry && file ? { file, sha256: entry.sha256.toLowerCase() } : undefined;
  }

  /** Sobre el almacén de ahora; `live` es el filtro de esta misma llamada. */
  static async build(
    port: Pick<HebraLibraryPort, 'filesIndex'>,
    live: PrivacyFilter,
    config: PrivacyConfig
  ): Promise<FileFilter> {
    return new FileFilter(live, await port.filesIndex(), config);
  }

  /** Sobre datos ya leídos DENTRO del turno de escritura (`src/store/writes.ts`). */
  static fromSnapshot(live: PrivacyFilter, index: FilesIndex, config: PrivacyConfig): FileFilter {
    return new FileFilter(live, index, config);
  }

  /** `local_seq` de la fila del fichero con la que se construyó este filtro, el sello de la
   *  puerta final (`src/server/privacy-gate.ts`). */
  sealOf(id: string): number | undefined {
    return this.files.get(id)?.localSeq;
  }

  /** `true` si `id` es un fichero suelto, vivo o de la papelera, que el MCP puede ver. */
  isVisible(id: string): boolean {
    return this.visibleMeta(id) !== undefined;
  }

  /** Lo que se enseña de un fichero VISIBLE; `undefined` si está oculto, no existe, es
   *  una lápida o `id` no es de un fichero suelto (todo eso, igual). */
  visibleMeta(id: string): VisibleFile | undefined {
    const file = this.files.get(id);
    return file ? this.visibleOf(file) : undefined;
  }

  /** Todos los ficheros visibles, vivos y de la papelera, sin orden: quien lista los
   *  separa, los filtra y los ordena. */
  visibleFiles(): VisibleFile[] {
    const out: VisibleFile[] = [];
    for (const file of this.files.values()) {
      const visible = this.visibleOf(file);
      if (visible) out.push(visible);
    }
    return out;
  }

  private visibleOf(file: FileEntry): VisibleFile | undefined {
    if (this.hiddenByReference.has(file.id)) return undefined;
    if (this.lockedHidden && linkableByName(file.name)) return undefined;
    const folderId = this.trash.restoreFolderOf(file.folderId);
    if (folderId === undefined) return undefined;
    return {
      id: file.id,
      name: file.name,
      folderId,
      mime: file.mime,
      byteLength: file.byteLength,
      updatedAt: file.updatedAt,
      trashedAt: file.trashedAt
    };
  }
}
