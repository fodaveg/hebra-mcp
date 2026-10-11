/**
 * La puerta final de privacidad (tarea de Lumbre d64e187e, 2.ª y 3.ª revisión de Codex del
 * 11 oct 2026; SPEC.md §6.3, «Cuándo se evalúa», y punto 8 de D16). Sustituye a la
 * recomprobación por herramienta de C1 y C2 (el `recheck.ts` retirado), que comparaba un sello
 * por fila con el filtro del PRINCIPIO de la llamada y dejaba huecos: algo que pasa a privado
 * mientras la llamada está en marcha sin tocar la fila (mover o renombrar una carpeta
 * antecesora, cambiar `config.json`, otra llamada que recuerda una carpeta privada), una fila
 * que se leyó privada y volvió a ser pública con el mismo `updated_at`, o lo que se leía
 * después de recomprobar (el apartado de un resultado de búsqueda, un error `note_locked`).
 *
 * Toda respuesta de una herramienta registrada, y todo error, pasa por aquí antes de salir
 * (`register-tools.ts`, `runTool`, con `finalGate`):
 * 1. La configuración: se espera la recarga de `config.json` que esté en vuelo y se vuelve a
 *    mirar su huella (`PrivacyConfigSource.current`). Si ya no se puede leer,
 *    `privacy_config_unresolved`, aunque la llamada empezara bien.
 * 2. En UNA transacción de lectura (`HebraLibraryPort.privacyRecheck`), el filtro entero
 *    desde cero: la configuración de ahora, la memoria de las carpetas privadas (A3, tabla y
 *    proceso), el árbol de carpetas con la ruta de AHORA de cada antecesora, etiquetas,
 *    bloqueadas y lápidas; y, solo si la respuesta los usó, la papelera, los ficheros sueltos
 *    y las notas que enlazan cada adjunto. Aunque la respuesta no use nada, una configuración
 *    que ya no resuelve es `privacy_config_unresolved` (cerrado ante la duda; basta el árbol
 *    de carpetas).
 * 3. Contra ese filtro, lo que usó la respuesta (`GateUsage`): notas vivas, notas de la
 *    papelera, carpetas (con la ruta que se enseñó), ficheros sueltos, bytes de adjuntos,
 *    etiquetas enseñadas y la nota del registro de un `operationId`. Cada cosa tiene que
 *    seguir visible y, si lleva sello, ser la misma fila: el `local_seq` de la fila con la que
 *    el filtro de la llamada decidió que se veía y, si se leyó aparte, el de la fila leída, que
 *    tienen que coincidir entre sí y con el de ahora; de una carpeta, la ruta que se enseñó.
 *    Nunca `updated_at`, que dos guardados seguidos pueden compartir.
 * 4. Y la configuración tiene que ser la MISMA en la llamada, en el paso 1 y justo después
 *    de la transacción (se vuelve a mirar la huella): cualquier cambio (una etiqueta privada
 *    nueva, que vuelve privada una versión antigua o una etiqueta de un recuento) cambia lo
 *    que la llamada pudo enseñar, y la respuesta no vale.
 * 5. Si algo de eso no se cumple, no se poda la respuesta (podar deja huecos en cursores,
 *    recuentos y resoluciones que ya se calcularon con ello): se REPITE la llamada entera con
 *    un filtro nuevo, hasta `GATE_ATTEMPTS` veces. Si la última tampoco pasa, sale la
 *    respuesta del estado fresco que declara la herramienta (una lista vacía o `not_found`),
 *    nunca la vieja.
 *
 * Los cursores solo llevan posiciones de lo devuelto (la clave de la última nota devuelta, una
 * nota ya mirada), y tanto la nota que nombran como la que decide que HAYA cursor (la de mirar
 * por delante) se declaran: la puerta los juzga con todo lo demás, y si no pasa, el cursor se
 * descarta con la respuesta y se calcula otra vez en el intento siguiente.
 *
 * Una escritura que escribió no se repite: su informe pasa por la misma puerta, solo con la
 * visibilidad (sus propios guardados cambian los sellos), y se filtra (`GatePolicy.redact`):
 * por defecto, si algo de lo que nombra ya no se ve, la respuesta de algo que no existe. Un
 * RECHAZO (el escritor o la herramienta no escribieron nada: `no_match`, `ambiguous_heading`,
 * `operation_id_reused`, `folder_name_taken`…) se repite como una lectura.
 *
 * Coste: dos lecturas de la huella de `config.json` y una transacción de lectura con el árbol
 * de carpetas y el índice de visibilidad (lo mismo que `PrivacyFilter.build`), más la papelera
 * o los ficheros solo cuando la respuesta los usa. Medido en SPEC.md §6.3.
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyConfigUnreadable } from '../privacy/config-source';
import { FileFilter } from '../privacy/file-filter';
import { PrivacyFilter } from '../privacy/filter';
import { FolderIndex } from '../privacy/folder-index';
import { withRememberedFolders } from '../privacy/folder-memory';
import { TrashFilter } from '../privacy/trash-filter';
import type { ToolErrorCode } from '../log/logger';
import type { HebraLibraryPort } from '../store/types';
import type { ServerContext } from './context';
import { ToolError } from './errors';

/** Intentos de una llamada antes de responder el estado fresco. */
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
  /** Lo que nombra el registro de un `operationId` (nota, fichero o plan). */
  private readonly operationTargets = new Set<string>();
  private readonly files = new Map<string, SealedUse>();
  private readonly folders = new Map<string, { path: string | undefined; conflict: boolean }>();
  private readonly blobs = new Set<string>();
  private readonly tags = new Set<string>();

  /** `privacy`: el filtro de la llamada, del que salen los sellos por defecto. */
  constructor(private readonly privacy?: PrivacyFilter) {}

  /** Una nota viva cuyo contenido o existencia sale en la respuesta, o que decidió algo de
   *  ella con su fila, con el sello de la fila con la que el filtro de la llamada la juzgó
   *  visible y, si se leyó aparte, el de la fila leída: los dos tienen que coincidir entre sí y
   *  con el de ahora. */
  note(id: string, localSeq?: number): void {
    useSeal(this.notes, id, this.privacy?.sealOf(id));
    if (localSeq !== undefined) useSeal(this.notes, id, localSeq);
  }

  /** Una nota viva que solo cuenta por estar visible, sin enseñar nada de su fila (una
   *  homónima que deja un enlace o un título ambiguos, el original de `conflictOf`). */
  noteVisible(id: string): void {
    useVisible(this.notes, id);
  }

  /** Notas vivas que solo cuentan por estar visibles (los recuentos de `hebra_list_tags` y
   *  `hebra_list_folders`). */
  visibleNotes(ids: Iterable<string>): void {
    for (const id of ids) useVisible(this.notes, id);
  }

  /** Una nota de la papelera que sale en la respuesta, con el sello de su filtro. */
  trashedNote(id: string, localSeq?: number): void {
    useSeal(this.trashed, id, localSeq);
  }

  /** Una nota que vale viva o en la papelera, solo por estar visible (el `copyId` de un
   *  informe, la original de un informe de `hebra-mcp apply`). */
  noteInAnyState(id: string): void {
    this.anyState.add(id);
  }

  /** Lo que nombra el registro de un `operationId` que decidió `operation_id_reused` (R3-2 de
   *  la 3.ª revisión): una nota (viva o de la papelera) o un fichero suelto que tiene que
   *  seguir viéndose; otra cosa (un plan de `hebra_replace_in_notes`) vale siempre. */
  operationTarget(id: string): void {
    this.operationTargets.add(id);
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

  /** Una etiqueta canónica que sale en la respuesta: no puede ser privada ahora. */
  tag(tag: string): void {
    this.tags.add(tag);
  }

  get empty(): boolean {
    return (
      this.notes.size === 0 &&
      this.trashed.size === 0 &&
      this.anyState.size === 0 &&
      this.operationTargets.size === 0 &&
      this.files.size === 0 &&
      this.folders.size === 0 &&
      this.blobs.size === 0 &&
      this.tags.size === 0
    );
  }

  /** Para la puerta: lo declarado, de solo lectura. */
  declared(): GateDeclared {
    return {
      notes: this.notes,
      trashed: this.trashed,
      anyState: this.anyState,
      operationTargets: this.operationTargets,
      files: this.files,
      folders: this.folders,
      blobs: this.blobs,
      tags: this.tags
    };
  }
}

interface GateDeclared {
  notes: ReadonlyMap<string, SealedUse>;
  trashed: ReadonlyMap<string, SealedUse>;
  anyState: ReadonlySet<string>;
  operationTargets: ReadonlySet<string>;
  files: ReadonlyMap<string, SealedUse>;
  folders: ReadonlyMap<string, { path: string | undefined; conflict: boolean }>;
  blobs: ReadonlySet<string>;
  tags: ReadonlySet<string>;
}

/** El resultado de la puerta: si pasa, y qué no pasó, para filtrar un informe. */
export interface GateVerdict {
  passed: boolean;
  /** La configuración de privados cambió durante la llamada: nada de lo que usó vale. */
  configChanged: boolean;
  /** Notas (vivas, de la papelera o en cualquier estado) que ya no se ven o cambiaron. */
  failedNotes: ReadonlySet<string>;
  failedFiles: ReadonlySet<string>;
  failedFolders: ReadonlySet<string>;
  failedBlobs: ReadonlySet<string>;
  failedTags: ReadonlySet<string>;
}

const PASSED: GateVerdict = {
  passed: true,
  configChanged: false,
  failedNotes: new Set(),
  failedFiles: new Set(),
  failedFolders: new Set(),
  failedBlobs: new Set(),
  failedTags: new Set()
};

/**
 * La configuración de privados de AHORA, esperando la recarga en vuelo. Una que ya no se
 * puede leer, `privacy_config_unresolved`.
 */
export async function gateConfig(server: Pick<ServerContext, 'privacyConfig' | 'privacyConfigSource'>): Promise<PrivacyConfig> {
  try {
    return server.privacyConfigSource ? await server.privacyConfigSource.current() : server.privacyConfig;
  } catch (error) {
    if (error instanceof PrivacyConfigUnreadable) throw new ToolError('privacy_config_unresolved');
    throw error;
  }
}

/** ¿La misma configuración de privados? Solo lo configurado: la memoria de carpetas
 *  (`knownPrivateFolderIds`) la rehace la puerta con la tabla. */
export function samePrivacyConfig(left: PrivacyConfig, right: PrivacyConfig): boolean {
  const key = (config: PrivacyConfig): string =>
    JSON.stringify([
      config.privateFolders.map((segments) => segments.join('/')).sort(),
      [...config.privateTags].sort()
    ]);
  return key(left) === key(right);
}

/**
 * Pasos 2 y 3: lo que usó la llamada contra el filtro de `config`, todo de una transacción.
 * `seals: false` en las escrituras (sus propios guardados cambian los sellos): solo la
 * visibilidad. Una configuración que no resuelve, `privacy_config_unresolved`, también sin
 * nada que juzgar. No mira si la configuración cambió: eso lo hace `finalGate`.
 */
export async function passGate(
  port: HebraLibraryPort,
  config: PrivacyConfig,
  usage: GateUsage,
  options: { seals: boolean }
): Promise<GateVerdict> {
  const used = usage.declared();
  if (usage.empty) {
    // Nada que juzgar, pero cerrado ante la duda igual (R3-6 de la 3.ª revisión de Codex): una
    // ruta configurada que ya no resuelve es `privacy_config_unresolved`. Basta el árbol.
    const folders = FolderIndex.fromList(await port.foldersList());
    if (config.privateFolders.some((segments) => folders.idsForPath(segments).every((id) => id === ROOT_FOLDER_ID))) {
      throw new ToolError('privacy_config_unresolved');
    }
    return PASSED;
  }
  // Sellos solo de lo que lleva sello (una nota que solo cuenta por visible se juzga con el
  // índice de visibilidad, que ya va entero), y si es nota la de un registro de operación.
  const sealed = options.seals
    ? [...used.notes, ...used.trashed].filter(([, use]) => use.seal !== undefined).map(([id]) => id)
    : [];
  const needsTrash = used.trashed.size > 0 || used.anyState.size > 0 || used.operationTargets.size > 0;
  const snapshot = await port.privacyRecheck({
    notes: [...sealed, ...used.operationTargets],
    trash: needsTrash,
    files: used.files.size > 0 || used.operationTargets.size > 0,
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
  for (const id of used.operationTargets) {
    const stamp = snapshot.stamps.get(id);
    const visible = stamp
      ? stamp.trashed
        ? trash?.isVisible(id) === true
        : live.visibleMeta(id) !== undefined
      : files?.sealOf(id) === undefined || files.isVisible(id);
    if (!visible) failedNotes.add(id);
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
  const failedTags = new Set([...used.tags].filter((tag) => live.isTagHidden(tag)));
  return {
    passed:
      failedNotes.size === 0 &&
      failedFiles.size === 0 &&
      failedFolders.size === 0 &&
      failedBlobs.size === 0 &&
      failedTags.size === 0,
    configChanged: false,
    failedNotes,
    failedFiles,
    failedFolders,
    failedBlobs,
    failedTags
  };
}

/**
 * La puerta entera de una llamada: la configuración de ahora (paso 1), lo usado contra ella
 * en una transacción (pasos 2 y 3) y, después de la transacción, la huella otra vez (paso 4):
 * si la configuración no es la de la llamada, o cambió entre el paso 1 y el final de la
 * transacción, el veredicto no pasa (`configChanged`).
 */
export async function finalGate(
  server: Pick<ServerContext, 'privacyConfig' | 'privacyConfigSource'>,
  port: HebraLibraryPort,
  callConfig: PrivacyConfig,
  usage: GateUsage,
  options: { seals: boolean }
): Promise<GateVerdict> {
  const before = await gateConfig(server);
  const verdict = await passGate(port, before, usage, options);
  const after = await gateConfig(server);
  if (samePrivacyConfig(before, callConfig) && samePrivacyConfig(before, after)) return verdict;
  return { ...verdict, passed: false, configChanged: true };
}

/** Lo que hizo una llamada: su resultado o su error. */
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: ToolError };

/**
 * Qué hace la puerta con una herramienta (`register-tools.ts`):
 * - `repeat` (las lecturas): si no pasa, se repite; al agotar los intentos, `fallback`, la
 *   respuesta del estado fresco (por defecto, `not_found`). `discard` deshace lo que deja un
 *   intento descartado (el plan de una simulación).
 * - `filter` (las escrituras): un rechazo que no pasa se repite como una lectura; lo demás no
 *   se repite y `redact` decide qué sale con el veredicto (por defecto, si algo ya no se ve,
 *   `not_found`).
 */
export type GatePolicy =
  | {
      kind: 'repeat';
      fallback?: () => ToolOutcome;
      discard?: (outcome: ToolOutcome) => Promise<void>;
    }
  | { kind: 'filter'; redact?: (outcome: ToolOutcome, verdict: GateVerdict) => ToolOutcome };

/**
 * Los errores de una escritura que son un RECHAZO: ni la herramienta ni el escritor
 * escribieron nada, así que repetir la llamada es seguro (y, con lo que ya no se ve fuera, da
 * la respuesta de ahora). Fuera quedan `busy_other_instance` (un reenvío pudo escribir y
 * perder la respuesta) e `invalid_input` (también lo que da un fallo desconocido).
 */
const REJECTIONS: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'not_found',
  'ambiguous_title',
  'writer_outdated',
  'revision_conflict',
  'no_match',
  'ambiguous_match',
  'overlapping_edits',
  'note_locked',
  'operation_id_reused',
  'attachment_too_large',
  'attachment_type_not_allowed',
  'attachment_unavailable',
  'folder_unavailable',
  'folder_name_taken',
  'heading_not_found',
  'ambiguous_heading',
  'plan_not_found',
  'plan_expired',
  'plan_already_applied',
  'file_changed',
  'file_too_large',
  'file_type_not_allowed',
  'file_unavailable'
]);

/** ¿Es un rechazo, sin nada escrito, que se puede repetir? */
export function isRejection(outcome: ToolOutcome): boolean {
  return !outcome.ok && REJECTIONS.has(outcome.error.code);
}

export const NOT_FOUND_OUTCOME = (): ToolOutcome => ({ ok: false, error: new ToolError('not_found') });

/** El filtro por defecto de un informe de escritura: si algo de lo que usó ya no se ve, la
 *  respuesta de algo que no existe (C3), aunque la escritura se hiciera. */
export function redactWhole(outcome: ToolOutcome, verdict: GateVerdict): ToolOutcome {
  return verdict.passed ? outcome : NOT_FOUND_OUTCOME();
}
