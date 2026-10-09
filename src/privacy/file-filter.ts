/**
 * Filtro de privados de los FICHEROS SUELTOS (D10, decisión de David del 9 oct 2026:
 * «adelante con las tres»; SPEC.md §6.3). Un fichero suelto es una fila de `files` de
 * Hebra (un `.base`, un PDF que no cuelga de una nota): tiene carpeta propia y no tiene
 * etiquetas, así que `PrivacyFilter` (`./filter.ts`), que solo conoce notas vivas, no
 * sabe decidir sobre él. Este filtro decide qué ficheros puede ver el MCP:
 * `hebra_list_files` los lista, y `hebra_trash_file`/`hebra_restore_file` solo actúan
 * sobre ellos. Un fichero oculto responde igual que uno inexistente (`not_found`), y la
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
 *     «Enlaza» es lo que el motor guarda en `links` (su nombre o el SHA-256 de sus
 *     bytes); el cruce lo trae ya hecho `FilesIndex.refs`. Hace falta porque los dos
 *     mundos se solapan: el importador de Hebra crea ficheros sueltos que las notas
 *     adjuntan por `sha256:`, y los dibujos son ficheros sueltos incrustados por nombre.
 *     Sin esta parte, el adjunto de una nota privada saldría por aquí con su nombre.
 *     Coste asumido en D10: con homónimos oculta de más.
 *
 * Cerrado ante la duda también con las instantáneas: una nota que enlaza un fichero y que
 * el filtro de su estado (vivo o papelera) no conoce cuenta como oculta.
 *
 * Igual que los otros dos filtros, es una instantánea del almacén: se construye en cada
 * llamada (`build`) o dentro del turno del escritor (`fromSnapshot`), nunca se guarda.
 */
import type { FileEntry, FilesIndex, HebraLibraryPort } from '../store/types';
import type { PrivacyConfig } from './config';
import type { PrivacyFilter } from './filter';
import { TrashFilter } from './trash-filter';

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

  private constructor(live: PrivacyFilter, index: FilesIndex, config: PrivacyConfig) {
    this.trash = TrashFilter.fromSnapshot(live, index.trash, config);
    for (const file of index.files) this.files.set(file.id, file);
    for (const ref of index.refs) {
      const noteVisible = ref.noteTrashed
        ? this.trash.isVisible(ref.noteId)
        : !live.isHiddenNote(ref.noteId);
      if (!noteVisible) this.hiddenByReference.add(ref.fileId);
    }
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
