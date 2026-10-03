/**
 * Filtro de privados de la PAPELERA (ampliación de D2, decisión de David del 30 sep
 * 2026: «acepto tus recomendaciones»). `PrivacyFilter` (`./filter.ts`) solo conoce notas
 * vivas; este decide, sobre las notas de la papelera, cuáles puede ver el MCP:
 * `hebra_list_trash` las lista, y `hebra_trash_note`/`hebra_restore_note` solo actúan
 * sobre ellas. Una nota de la papelera oculta responde igual que una inexistente
 * (`not_found`), y la lista no dice cuántas se saltó.
 *
 * Oculta, como en §6.3, si tiene una etiqueta privada (o descendiente) o si su carpeta
 * es privada (o subcarpeta). Lo nuevo es la carpeta: `folderTrash` de Hebra deja la
 * carpeta como LÁPIDA (con su nombre y su padre) y manda sus notas a la papelera sin
 * tocar su `folder_id`, y al restaurarlas Hebra las deja en la raíz (la carpeta efectiva
 * de una lápida). Así que para una nota cuya carpeta ya no está viva se sube por las
 * filas de carpeta, lápidas incluidas, hasta una carpeta viva o la raíz:
 * - si esa carpeta viva es privada, oculta;
 * - si alguna ruta intermedia (la de la carpeta viva más los nombres de las lápidas, en
 *   minúsculas) es una ruta privada configurada, oculta: una carpeta privada borrada y
 *   vuelta a crear con el mismo nombre no destapa las notas de la vieja;
 * - cerrado ante la duda: una fila que falta, un nombre vacío o un ciclo, oculta.
 *
 * Restaurar deja la nota en su carpeta si sigue viva y, si no, en la raíz (lo mismo que
 * `rowToNote` de Hebra). Con esta regla, una nota de la papelera visible aquí queda
 * visible al restaurarla: el destino nunca es más privado que lo comprobado.
 *
 * Igual que `PrivacyFilter`, es una instantánea del almacén: se construye en cada
 * llamada (`build`) o dentro del turno del escritor (`fromSnapshot`), nunca se guarda.
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { HebraLibraryPort, TrashIndex, TrashedNoteEntry, FolderRowFact } from '../store/types';
import type { PrivacyConfig } from './config';
import type { PrivacyFilter } from './filter';
import { privacyPathKey } from './folder-index';

/** Lo que se enseña de una nota de la papelera visible. */
export interface TrashedNoteMeta {
  /** Donde quedará al restaurarla (su carpeta si sigue viva; si no, la raíz). */
  folderId: string;
  /** Etiquetas HOJA, como `PrivacyFilter.visibleTagsOf`. */
  tags: string[];
  trashedAt: number;
}

export class TrashFilter {
  private readonly notes = new Map<string, TrashedNoteEntry>();
  private readonly rows = new Map<string, FolderRowFact>();
  private readonly privatePaths: ReadonlySet<string>;

  private constructor(
    private readonly live: PrivacyFilter,
    index: TrashIndex,
    config: PrivacyConfig
  ) {
    for (const note of index.notes) this.notes.set(note.id, note);
    for (const row of index.folders) this.rows.set(row.id, row);
    this.privatePaths = new Set(config.privateFolders.map((segments) => privacyPathKey(segments)));
  }

  /** Sobre el almacén de ahora; `live` es el filtro de esta misma llamada. */
  static async build(
    port: Pick<HebraLibraryPort, 'trashIndex'>,
    live: PrivacyFilter,
    config: PrivacyConfig
  ): Promise<TrashFilter> {
    return new TrashFilter(live, await port.trashIndex(), config);
  }

  /** Sobre datos ya leídos DENTRO del turno de escritura (`src/store/writes.ts`). */
  static fromSnapshot(live: PrivacyFilter, index: TrashIndex, config: PrivacyConfig): TrashFilter {
    return new TrashFilter(live, index, config);
  }

  /** `true` si `id` está en la papelera y el MCP puede verla. */
  isVisible(id: string): boolean {
    return this.visibleMeta(id) !== undefined;
  }

  /** Carpeta de restauración, etiquetas y fecha de una nota de la papelera VISIBLE;
   *  `undefined` si está oculta o no está en la papelera (las dos cosas, igual). */
  visibleMeta(id: string): TrashedNoteMeta | undefined {
    const note = this.notes.get(id);
    if (!note) return undefined;
    if (this.live.hidesAnyTag(note.tags)) return undefined;
    const folderId = this.restoreFolderOf(note.folderId);
    if (folderId === undefined) return undefined;
    const tags = note.tags.filter(
      (tag) => !note.tags.some((other) => other !== tag && other.startsWith(`${tag}/`))
    );
    return { folderId, tags, trashedAt: note.trashedAt };
  }

  /** Carpeta en la que quedaría al restaurarla, o `undefined` si su carpeta (viva o
   *  lápida) es privada o no se puede saber. */
  private restoreFolderOf(folderId: string): string | undefined {
    if (folderId === ROOT_FOLDER_ID) return ROOT_FOLDER_ID;
    if (this.live.folderExists(folderId)) {
      return this.live.isFolderHidden(folderId) ? undefined : folderId;
    }
    // Carpeta borrada: subir por las lápidas hasta una carpeta viva o la raíz.
    const tombstoneNames: string[] = [];
    const seen = new Set<string>();
    let current: string = folderId;
    let anchorPath: string[];
    for (;;) {
      if (current === ROOT_FOLDER_ID) {
        anchorPath = [];
        break;
      }
      if (this.live.folderExists(current)) {
        if (this.live.isFolderHidden(current)) return undefined;
        const path = this.live.folderPath(current);
        anchorPath = path.length === 0 ? [] : path.split('/');
        break;
      }
      const row = this.rows.get(current);
      const name = row?.name?.trim().toLowerCase();
      if (!row || !name || seen.has(current)) return undefined;
      seen.add(current);
      tombstoneNames.unshift(name);
      current = row.parentId ?? ROOT_FOLDER_ID;
    }
    const full = [...anchorPath, ...tombstoneNames];
    for (let length = 1; length <= full.length; length += 1) {
      if (this.privatePaths.has(privacyPathKey(full.slice(0, length)))) return undefined;
    }
    return ROOT_FOLDER_ID;
  }
}
