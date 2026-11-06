/**
 * Las notas vivas en el orden de id de `hebra_grep` y de la simulación de
 * `hebra_replace_in_notes`, leídas por páginas (M2 del plan de memoria, 6 nov 2026). Antes las dos
 * pedían las filas de TODAS las notas vivas de una vez (`grepNotes`: id, título y `rowid`, unos
 * 4,8 MiB a 30 000 notas, medido) y las ordenaban en memoria; ahora piden páginas de
 * `GREP_NOTES_PAGE` (`grepNotesPage`, paginación por clave sobre el índice de `notes.id`) y lo
 * que guardan a la vez lo acota la página, no la biblioteca.
 *
 * El orden de las dos herramientas (y de sus cursores) es el de las unidades UTF-16 (`byId`, `<`
 * de JavaScript); el de SQLite, el de los bytes UTF-8 (los puntos de código). Coinciden siempre
 * que una de las dos ids no tenga ninguna unidad desde U+D800 (sustitutos y U+E000-U+FFFF): en la
 * primera posición en que difieren, la unidad de esa id es menor que U+D800, y la otra o también
 * lo es (mismo orden en los dos) o es mayor en los dos. Solo dos ids con unidades de ese tramo
 * pueden salir en otro orden, y entre dos ids sin ninguna (que están en su sitio en los dos
 * órdenes) solo caben ids de ese tipo: cada racha seguida de ids así se ordena con `byId` antes
 * de darla. Con ids UUID (las de Hebra) no hay ninguna racha. Una biblioteca entera de ids así
 * sería una racha entera, como antes de M2.
 */
import type { GrepNoteRow, GrepNotesFrom } from './grep-sql';
import type { HebraLibraryPort } from './types';

/** Filas por página de `grepNotesPage`. */
export const GREP_NOTES_PAGE = 512;

/** El orden de `hebra_grep` y de la simulación: unidades UTF-16. */
export function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Posición de la primera unidad UTF-16 desde U+D800, o -1 si no hay ninguna. */
function firstHighUnit(id: string): number {
  for (let index = 0; index < id.length; index += 1) {
    if (id.charCodeAt(index) >= 0xd800) return index;
  }
  return -1;
}

/**
 * Las notas vivas (también las bloqueadas: quien llama decide) en orden de `byId`, desde `from`
 * (la de ese id entra con `inclusive`), de `take` en `take`, leyendo del almacén por páginas. Cada
 * página es una lectura aparte: lo que cambie entre dos se ve con su fila de ese momento, como ya
 * pasaba con los tramos y los lotes de las dos herramientas.
 */
export class NoteRowsById {
  /** Listas para dar, ya en orden. */
  private ready: GrepNoteRow[] = [];
  private readyAt = 0;
  /** La racha de ids con unidades desde U+D800 que aún no se ha cerrado. */
  private run: GrepNoteRow[] = [];
  /** Por dónde sigue la página siguiente (el id de la última fila leída). */
  private after: GrepNotesFrom | null;
  private exhausted = false;

  constructor(
    private readonly port: Pick<HebraLibraryPort, 'grepNotesPage'>,
    private readonly from: GrepNotesFrom | null,
    private readonly pageSize = GREP_NOTES_PAGE
  ) {
    if (from === null) {
      this.after = null;
    } else {
      // Desde el trozo de `from` anterior a su primera unidad desde U+D800 (con un id UUID, el id
      // entero): toda id que vaya detrás de `from` en `byId` va detrás de ese trozo en los bytes
      // (cabecera). Lo de en medio que no toca lo descarta `inRange`.
      const cut = firstHighUnit(from.id);
      this.after = cut < 0 ? from : { id: from.id.slice(0, cut), inclusive: true };
    }
  }

  /** Las `max` siguientes; menos solo al acabar (y ninguna si ya no queda nada). Por tandas y no
   *  de una en una: una espera por página, no por nota. */
  async take(max: number): Promise<GrepNoteRow[]> {
    const out: GrepNoteRow[] = [];
    while (out.length < max) {
      if (this.readyAt >= this.ready.length) {
        if (this.exhausted) break;
        await this.readPage();
        continue;
      }
      const count = Math.min(max - out.length, this.ready.length - this.readyAt);
      for (let index = 0; index < count; index += 1) out.push(this.ready[this.readyAt++]!);
    }
    return out;
  }

  private inRange(row: GrepNoteRow): boolean {
    if (this.from === null) return true;
    const order = byId(row.id, this.from.id);
    return order > 0 || (order === 0 && this.from.inclusive);
  }

  private async readPage(): Promise<void> {
    const rows = await this.port.grepNotesPage(this.after, this.pageSize);
    const out: GrepNoteRow[] = [];
    const closeRun = (): void => {
      if (this.run.length === 0) return;
      this.run.sort((left, right) => byId(left.id, right.id));
      for (const row of this.run) if (this.inRange(row)) out.push(row);
      this.run = [];
    };
    for (const row of rows) {
      if (firstHighUnit(row.id) >= 0) {
        this.run.push(row);
        continue;
      }
      closeRun();
      if (this.inRange(row)) out.push(row);
    }
    if (rows.length < this.pageSize) {
      this.exhausted = true;
      closeRun();
    } else {
      this.after = { id: rows[rows.length - 1]!.id, inclusive: false };
    }
    this.ready = out;
    this.readyAt = 0;
  }
}
