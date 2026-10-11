/**
 * La puerta final de privacidad (tarea de Lumbre d64e187e, 2.ª revisión de Codex del 11 oct
 * 2026; SPEC.md §6.3, «Cuándo se evalúa», y punto 8 de D16). Sustituye a la recomprobación por
 * herramienta de C1 y C2 (el `recheck.ts` retirado), que comparaba un sello por fila con el filtro del
 * PRINCIPIO de la llamada y dejaba huecos: algo que pasa a privado mientras la llamada está
 * en marcha sin tocar la fila (mover o renombrar una carpeta antecesora, cambiar
 * `config.json`, otra llamada que recuerda una carpeta privada), una fila que se leyó
 * privada y volvió a ser pública con el mismo `updated_at`, o lo que se leía después de
 * recomprobar (el apartado de un resultado de búsqueda, un error `note_locked`).
 *
 * Toda respuesta de una herramienta registrada, y todo error que dependa de un objeto
 * concreto, pasa por aquí antes de salir (`register-tools.ts`, `runTool`):
 * 1. La configuración: se espera la recarga de `config.json` que esté en vuelo y se vuelve a
 *    mirar su huella (`PrivacyConfigSource.current`). Si ya no se puede leer,
 *    `privacy_config_unresolved`, aunque la llamada empezara bien.
 * 2. En UNA transacción de lectura (`HebraLibraryPort.privacyRecheck`), el filtro entero
 *    desde cero: la configuración de ahora, la memoria de las carpetas privadas (A3, tabla y
 *    proceso), el árbol de carpetas con la ruta de AHORA de cada antecesora, etiquetas,
 *    bloqueadas y lápidas; y, solo si la respuesta los usó, la papelera, los ficheros sueltos
 *    y las notas que enlazan cada adjunto.
 * 3. Contra ese filtro, lo que usó la respuesta (`GateUsage`): notas vivas, notas de la
 *    papelera, carpetas (con la ruta que se enseñó), ficheros sueltos y bytes de adjuntos.
 *    Cada cosa tiene que seguir visible y, si lleva sello, ser la misma fila: el `local_seq`
 *    de la fila con la que el filtro de la llamada decidió que se veía y, si se leyó aparte,
 *    el de la fila leída, que tienen que coincidir entre sí y con el de ahora; de una
 *    carpeta, la ruta que se enseñó. Nunca `updated_at`, que dos guardados seguidos pueden
 *    compartir.
 * 4. Si algo usado cambió o dejó de verse, no se poda la respuesta (podar deja huecos en
 *    cursores, recuentos y resoluciones que ya se calcularon con ello): se REPITE la llamada
 *    entera con un filtro nuevo, hasta `GATE_ATTEMPTS` veces. Si la última tampoco pasa, sale
 *    la respuesta del estado fresco que declara la herramienta (una lista vacía o
 *    `not_found`), nunca la vieja.
 *
 * Los cursores solo llevan posiciones de lo devuelto (la clave de la última nota devuelta, una
 * nota ya mirada, cuántas notas visibles se devolvieron), y la nota que nombran se declara
 * como usada: la puerta los juzga con todo lo demás, y si no pasa, el cursor se descarta con
 * la respuesta y se calcula otra vez en el intento siguiente.
 *
 * Una escritura no se repite (ya escribió): su informe pasa por la misma puerta, solo con la
 * visibilidad (sus propias escrituras cambian los sellos), y se filtra (`GatePolicy.redact`):
 * por defecto, si algo de lo que nombra ya no se ve, la respuesta de algo que no existe.
 *
 * Coste: una lectura de la huella de `config.json` (ya la pagaba cada llamada) y una
 * transacción de lectura con el árbol de carpetas y el índice de visibilidad (lo mismo que
 * `PrivacyFilter.build`), más la papelera o los ficheros solo cuando la respuesta los usa.
 * Medido en SPEC.md §6.3.
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyConfigUnreadable } from '../privacy/config-source';
import { FileFilter } from '../privacy/file-filter';
import { PrivacyFilter } from '../privacy/filter';
import { withRememberedFolders } from '../privacy/folder-memory';
import { TrashFilter } from '../privacy/trash-filter';
import type { HebraLibraryPort } from '../store/types';
import type { ServerContext } from './context';
import { ToolError } from './errors';

/** Intentos de una llamada de lectura antes de responder el estado fresco. */
export const GATE_ATTEMPTS = 3;

/** Una fila usada con su sello. Si la respuesta tomó algo de dos lecturas de la misma fila
 *  con sellos distintos (el título de una página y el cuerpo de una lectura aparte, o la
 *  fila con la que se decidió que se veía y la que se leyó después), `conflict`: mezcla dos
 *  filas, y no pasa. */
interface SealedUse {
  seal: number | undefined;
  conflict: boolean;
}

function useSeal(uses: Map<string, SealedUse>, id: string, seal: number | undefined): void {
  const current = uses.get(id);
  if (!current) {
    uses.set(id, { seal, conflict: false });
  } else if (seal !== undefined) {
    if (current.seal === undefined) current.seal = seal;
    else if (current.seal !== seal) current.conflict = true;
  }
}

function useVisible(uses: Map<string, SealedUse>, id: string): void {
  if (!uses.has(id)) uses.set(id, { seal: undefined, conflict: false });
}

/**
 * Lo que usó UNA llamada para construir su respuesta (o su error): lo que comprueba la puerta.
 * Una por intento (`resolveToolContext`), con el filtro de ese intento para los sellos por
 * defecto. La herramienta lo declara al usarlo; lo que la respuesta no enseña ni la decide
 * (una nota que se saltó por oculta) no se declara.
 */
export class GateUsage {
  private readonly notes = new Map<string, SealedUse>();
  private readonly trashed = new Map<string, SealedUse>();
  /** Notas que pueden estar vivas o en la papelera (una copia de conflicto). */
  private readonly anyState = new Set<string>();
  private readonly files = new Map<string, SealedUse>();
  private readonly folders = new Map<string, { path: string | undefined; conflict: boolean }>();
  private readonly blobs = new Set<string>();

  /** `privacy`: el filtro de la llamada, del que salen los sellos por defecto. */
  constructor(private readonly privacy?: PrivacyFilter) {}

  /** Una nota viva cuyo contenido o existencia sale en la respuesta, o que decidió algo de
   *  ella (una homónima que deja un enlace sin resolver), con el sello de la fila con la que
   *  el filtro de la llamada la juzgó visible y, si se leyó aparte, el de la fila leída: los
   *  dos tienen que coincidir entre sí y con el de ahora. */
  note(id: string, localSeq?: number): void {
    useSeal(this.notes, id, this.privacy?.sealOf(id));
    if (localSeq !== undefined) useSeal(this.notes, id, localSeq);
  }

  /** Notas vivas que solo cuentan por estar visibles, sin enseñar nada de su fila (los
   *  recuentos de `hebra_list_tags` y `hebra_list_folders`). */
  visibleNotes(ids: Iterable<string>): void {
    for (const id of ids) useVisible(this.notes, id);
  }

  /** Una nota de la papelera que sale en la respuesta, con el sello de su filtro. */
  trashedNote(id: string, localSeq?: number): void {
    useSeal(this.trashed, id, localSeq);
  }

  /** Una nota que vale viva o en la papelera, solo por estar visible (el `copyId` de un
   *  informe). */
  noteInAnyState(id: string): void {
    this.anyState.add(id);
  }

  /** Un fichero suelto que sale en la respuesta, con el sello de su filtro. */
  file(id: string, localSeq?: number): void {
    useSeal(this.files, id, localSeq);
  }

  /** Una carpeta que sale en la respuesta y, si se enseña, su ruta tal cual salió: con otra
   *  ruta ahora (una antecesora renombrada o movida), la respuesta ya no vale. */
  folder(id: string, path?: string): void {
    const current = this.folders.get(id);
    if (!current) {
      this.folders.set(id, { path, conflict: false });
    } else if (path !== undefined) {
      if (current.path !== undefined && current.path !== path) current.conflict = true;
      else current.path = path;
    }
  }

  /** Bytes (SHA-256 en minúsculas) cuyo tamaño, tipo o contenido sale en la respuesta: no
   *  pueden ser también de algo oculto (M6). */
  blob(sha256: string): void {
    this.blobs.add(sha256.toLowerCase());
  }

  get empty(): boolean {
    return (
      this.notes.size === 0 &&
      this.trashed.size === 0 &&
      this.anyState.size === 0 &&
      this.files.size === 0 &&
      this.folders.size === 0 &&
      this.blobs.size === 0
    );
  }

  /** Para la puerta: lo declarado, de solo lectura. */
  declared(): GateDeclared {
    return {
      notes: this.notes,
      trashed: this.trashed,
      anyState: this.anyState,
      files: this.files,
      folders: this.folders,
      blobs: this.blobs
    };
  }
}

interface GateDeclared {
  notes: ReadonlyMap<string, SealedUse>;
  trashed: ReadonlyMap<string, SealedUse>;
  anyState: ReadonlySet<string>;
  files: ReadonlyMap<string, SealedUse>;
  folders: ReadonlyMap<string, { path: string | undefined; conflict: boolean }>;
  blobs: ReadonlySet<string>;
}

/** El resultado de la puerta: si pasa, y qué no pasó, para filtrar un informe. */
export interface GateVerdict {
  passed: boolean;
  /** Notas (vivas, de la papelera o en cualquier estado) que ya no se ven o cambiaron. */
  failedNotes: ReadonlySet<string>;
  failedFiles: ReadonlySet<string>;
  failedFolders: ReadonlySet<string>;
  failedBlobs: ReadonlySet<string>;
}

const PASSED: GateVerdict = {
  passed: true,
  failedNotes: new Set(),
  failedFiles: new Set(),
  failedFolders: new Set(),
  failedBlobs: new Set()
};

/**
 * Paso 1: la configuración de privados de AHORA, esperando la recarga en vuelo. Una que ya
 * no se puede leer, `privacy_config_unresolved`.
 */
export async function gateConfig(server: ServerContext): Promise<PrivacyConfig> {
  try {
    return server.privacyConfigSource ? await server.privacyConfigSource.current() : server.privacyConfig;
  } catch (error) {
    if (error instanceof PrivacyConfigUnreadable) throw new ToolError('privacy_config_unresolved');
    throw error;
  }
}

/**
 * Pasos 2 y 3: lo que usó la llamada contra el filtro de ahora, todo de una transacción.
 * `seals: false` en las escrituras (sus propios guardados cambian los sellos): solo la
 * visibilidad. Una configuración que ya no resuelve, `privacy_config_unresolved`.
 */
export async function passGate(
  port: HebraLibraryPort,
  config: PrivacyConfig,
  usage: GateUsage,
  options: { seals: boolean }
): Promise<GateVerdict> {
  if (usage.empty) return PASSED;
  const used = usage.declared();
  // Sellos solo de lo que lleva sello: una nota que solo cuenta por visible se juzga con el
  // índice de visibilidad, que ya va entero.
  const sealed = [...used.notes, ...used.trashed]
    .filter(([, use]) => use.seal !== undefined)
    .map(([id]) => id);
  const snapshot = await port.privacyRecheck({
    notes: options.seals ? sealed : [],
    trash: used.trashed.size > 0 || used.anyState.size > 0,
    files: used.files.size > 0,
    blobs: [...used.blobs]
  });
  const now = withRememberedFolders(config, snapshot.remembered);
  const live = PrivacyFilter.fromSnapshot(snapshot.folders, snapshot.notes, now);
  if (live.unresolved) throw new ToolError('privacy_config_unresolved');
  const trashIndex = snapshot.files?.trash ?? snapshot.trash;
  const trash = trashIndex ? TrashFilter.fromSnapshot(live, trashIndex, now) : undefined;
  const files = snapshot.files ? FileFilter.fromSnapshot(live, snapshot.files, now) : undefined;

  const sealHolds = (use: SealedUse, current: number | undefined): boolean =>
    !use.conflict && (!options.seals || use.seal === undefined || use.seal === current);

  // El sello de ahora de una nota viva (o de la papelera), del mismo estado que se juzga: una
  // que cambió de estado no es la misma fila.
  const stampOf = (id: string, trashed: boolean): number | undefined => {
    const stamp = snapshot.stamps.get(id);
    return stamp && stamp.trashed === trashed ? stamp.localSeq : undefined;
  };
  const failedNotes = new Set<string>();
  for (const [id, use] of used.notes) {
    if (live.visibleMeta(id) === undefined || !sealHolds(use, stampOf(id, false))) failedNotes.add(id);
  }
  for (const [id, use] of used.trashed) {
    if (trash?.isVisible(id) !== true || !sealHolds(use, stampOf(id, true))) failedNotes.add(id);
  }
  for (const id of used.anyState) {
    if (live.visibleMeta(id) === undefined && trash?.isVisible(id) !== true) failedNotes.add(id);
  }
  const failedFiles = new Set<string>();
  for (const [id, use] of used.files) {
    if (files?.isVisible(id) !== true || !sealHolds(use, files.sealOf(id))) failedFiles.add(id);
  }
  const failedFolders = new Set<string>();
  for (const [id, use] of used.folders) {
    if (id === ROOT_FOLDER_ID) continue;
    // La ruta enseñada cuenta como su sello: en una escritura, solo la visibilidad.
    const visible = live.folderExists(id) && !live.isFolderHidden(id);
    const samePath = !options.seals || (!use.conflict && (use.path === undefined || live.folderPath(id) === use.path));
    if (!visible || !samePath) failedFolders.add(id);
  }
  const failedBlobs = new Set<string>();
  for (const [index, sha256] of [...used.blobs].entries()) {
    const refs = snapshot.blobRefs?.[index] ?? [];
    if (!files || refs.some((ref) => files.isHiddenReference(ref)) || files.hidesContent(sha256)) {
      failedBlobs.add(sha256);
    }
  }
  return {
    passed:
      failedNotes.size === 0 && failedFiles.size === 0 && failedFolders.size === 0 && failedBlobs.size === 0,
    failedNotes,
    failedFiles,
    failedFolders,
    failedBlobs
  };
}

/** Lo que hizo una llamada: su resultado o su error. */
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: ToolError };

/**
 * Qué hace la puerta con una herramienta (`register-tools.ts`):
 * - `repeat` (las lecturas): si no pasa, se repite; al agotar los intentos, `fallback`, la
 *   respuesta del estado fresco (por defecto, `not_found`).
 * - `filter` (las escrituras): no se repite; `redact` decide qué sale con el veredicto (por
 *   defecto, si algo ya no se ve, `not_found`).
 */
export type GatePolicy =
  | { kind: 'repeat'; fallback?: () => ToolOutcome }
  | { kind: 'filter'; redact?: (outcome: ToolOutcome, verdict: GateVerdict) => ToolOutcome };

export const NOT_FOUND_OUTCOME = (): ToolOutcome => ({ ok: false, error: new ToolError('not_found') });

/** El filtro por defecto de un informe de escritura: si algo de lo que usó ya no se ve, la
 *  respuesta de algo que no existe (C3), aunque la escritura se hiciera. */
export function redactWhole(outcome: ToolOutcome, verdict: GateVerdict): ToolOutcome {
  return verdict.passed ? outcome : NOT_FOUND_OUTCOME();
}
