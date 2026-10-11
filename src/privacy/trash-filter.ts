/**
 * Filtro de privados de la PAPELERA (ampliación de D2, decisión de David del 30 sep
 * 2026: «acepto tus recomendaciones»). `PrivacyFilter` (`./filter.ts`) solo conoce notas
 * vivas; este decide, sobre las notas de la papelera, cuáles puede ver el MCP:
 * `hebra_list_trash` las lista, y `hebra_trash_note`/`hebra_restore_note` solo actúan
 * sobre ellas. Una nota de la papelera oculta responde igual que una inexistente
 * (`not_found`), y la lista no dice cuántas se saltó.
 *
 * La parte de las carpetas (`restoreFolderOf`) la usa también el filtro de los ficheros
 * sueltos (D10, 9 oct 2026; `./file-filter.ts`), que parte de la carpeta guardada del
 * fichero igual que aquí se parte de la de la nota.
 *
 * Oculta, como en §6.3, si tiene una etiqueta privada (o descendiente), si está bloqueada
 * y hay etiquetas privadas configuradas (A1 del audit de privacidad, 10 oct 2026), o si su
 * carpeta es privada (o subcarpeta). Lo nuevo es la carpeta: `folderTrash` de Hebra deja la
 * carpeta como LÁPIDA (con su nombre y su padre) y manda sus notas a la papelera sin
 * tocar su `folder_id`, y al restaurarlas Hebra las deja en la raíz (la carpeta efectiva
 * de una lápida). Así que para una nota cuya carpeta ya no está viva se sube por las
 * filas de carpeta, lápidas incluidas, hasta una carpeta viva o la raíz, con la regla de
 * `./tombstones.ts` (`climbFolder`), que desde A2 usan también las notas vivas.
 *
 * Restaurar deja la nota en su carpeta si sigue viva y, si no, en la raíz (lo mismo que
 * `rowToNote` de Hebra). Con esta regla, una nota de la papelera visible aquí queda
 * visible al restaurarla: el destino nunca es más privado que lo comprobado.
 *
 * Igual que `PrivacyFilter`, es una instantánea del almacén: se construye en cada
 * llamada (`build`) o dentro del turno del escritor (`fromSnapshot`), nunca se guarda.
 */
import type { HebraLibraryPort, TrashIndex, TrashedNoteEntry, FolderRowFact } from '../store/types';
import type { PrivacyConfig } from './config';
import type { PrivacyFilter } from './filter';
import { privacyPathKey } from './folder-index';
import { climbFolder } from './tombstones';

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

  /** `local_seq` de la fila de la papelera con la que se construyó este filtro, el sello
   *  de la puerta final (`src/server/privacy-gate.ts`). */
  sealOf(id: string): number | undefined {
    return this.notes.get(id)?.localSeq;
  }

  /** ¿Hay en la papelera alguna nota BLOQUEADA que no se ve? Para la variante de A1 de los
   *  ficheros sueltos (`FileFilter`): lo que incrustaba por nombre va cifrado. */
  hasHiddenLockedNote(): boolean {
    for (const note of this.notes.values()) {
      if (note.locked && !this.isVisible(note.id)) return true;
    }
    return false;
  }

  /** Carpeta de restauración, etiquetas y fecha de una nota de la papelera VISIBLE;
   *  `undefined` si está oculta o no está en la papelera (las dos cosas, igual). */
  visibleMeta(id: string): TrashedNoteMeta | undefined {
    const note = this.notes.get(id);
    if (!note) return undefined;
    if (this.live.hidesAnyTag(note.tags)) return undefined;
    // Bloqueada: no deriva etiquetas, así que con etiquetas privadas configuradas no se sabe
    // si llevaba una (A1 del audit de privacidad, como en `PrivacyFilter.isHiddenNote`).
    if (note.locked && this.live.hasPrivateTags()) return undefined;
    const folderId = this.restoreFolderOf(note.folderId);
    if (folderId === undefined) return undefined;
    const tags = note.tags.filter(
      (tag) => !note.tags.some((other) => other !== tag && other.startsWith(`${tag}/`))
    );
    return { folderId, tags, trashedAt: note.trashedAt };
  }

  /** Carpeta en la que quedaría al restaurarla, o `undefined` si su carpeta (viva o
   *  lápida) es privada o no se puede saber. `folderId` es la carpeta GUARDADA, de una
   *  nota de la papelera o de un fichero suelto (`FileFilter`): el resultado es siempre
   *  una carpeta viva y visible o la raíz. */
  restoreFolderOf(folderId: string): string | undefined {
    return climbFolder(folderId, this.rows, this.live, this.privatePaths);
  }
}
