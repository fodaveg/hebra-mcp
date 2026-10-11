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
 *    y las notas que enlazan cada adjunto. Siempre, aunque la respuesta no use nada: una
 *    configuración que ya no resuelve es `privacy_config_unresolved` (cerrado ante la duda).
 * 3. Contra ese filtro, lo que usó la respuesta (`GateUsage`): notas vivas, notas de la
 *    papelera, carpetas (con la ruta que se enseñó), ficheros sueltos, bytes de adjuntos,
 *    etiquetas enseñadas y la nota del registro de un `operationId`. Cada cosa tiene que
 *    seguir visible y, si lleva sello, ser la misma fila: el `local_seq` de la fila con la que
 *    el filtro de la llamada decidió que se veía y, si se leyó aparte, el de la fila leída, que
 *    tienen que coincidir entre sí y con el de ahora; de una carpeta, la ruta que se enseñó.
 *    Nunca `updated_at`, que dos guardados seguidos pueden compartir.
 * 4. Y nada de lo que puede cambiar la privacidad puede haber cambiado durante la llamada,
 *    aunque no se haya declarado (la garantía de la CLASE, que no depende de que cada
 *    herramienta declare bien cada rama): la configuración tiene que ser la MISMA en la
 *    llamada, en el paso 1 y justo después de la transacción (se vuelve a mirar la huella), y
 *    la ÉPOCA de privacidad del almacén (`HebraLibraryPort.privacyEpoch`: notas, carpetas,
 *    ficheros sueltos y memoria de carpetas privadas; ver `privacyEpochOf`) que la llamada tomó
 *    al empezar, ANTES de su filtro, tiene que ser la de la transacción de la puerta.
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
 * Una escritura no se repite. Su informe pasa por la misma puerta, solo con la visibilidad de
 * lo declarado (sus propios guardados, y la ronda que espera, cambian los sellos y la época), y
 * se reduce a lo que resiste el filtro nuevo (`GatePolicy.redact`: por defecto, si algo de lo
 * que nombra ya no se ve, la respuesta de algo que no existe). Un error de una escritura ligado
 * a un objeto (`no_match`, `ambiguous_heading`, `note_locked`, `operation_id_reused`,
 * `folder_name_taken`…), si la puerta no pasa entera (también por la configuración o la
 * época: con algo cambiado no se puede confirmar que ese objeto se siga viendo), pasa a
 * `not_found` (`folder_unavailable` en las carpetas).
 *
 * Coste: dos lecturas de la huella de `config.json`, la época al empezar (tres sumas sobre
 * `notes`, `folders` y `files`) y una transacción de lectura con el árbol de carpetas, el
 * índice de visibilidad y la época (lo mismo que `PrivacyFilter.build`, más las sumas), más la
 * papelera o los ficheros solo cuando la respuesta los usa. Y repeticiones: cualquier
 * escritura de notas, carpetas o ficheros (una ronda de sync, otra llamada) a mitad de una
 * lectura la repite. Medido en SPEC.md §6.3 (`gateStats`).
 */
import { ROOT_FOLDER_ID } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyConfigUnreadable } from '../privacy/config-source';
import { FileFilter } from '../privacy/file-filter';
import { PrivacyFilter } from '../privacy/filter';
import { privacyFingerprint } from '../store/replace';
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

  /** Lo que nombra el registro de un `operationId` que decidió `operation_id_reused` (R3-2):
   *  nota, fichero o plan. El plan solo se ve si todas sus notas siguen visibles. */
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
  /** Todo: lo declarado, la configuración y la época. */
  passed: boolean;
  /** Solo lo declarado (lo que filtra el informe de una escritura). */
  declaredPassed: boolean;
  /** La configuración de privados cambió durante la llamada: nada de lo que usó vale. */
  configChanged: boolean;
  /** La época de privacidad del almacén cambió durante la llamada (algo que puede cambiar
   *  lo que es privado se escribió, por quien sea): nada de lo que usó está garantizado. */
  epochChanged: boolean;
  /** Notas (vivas, de la papelera o en cualquier estado) que ya no se ven o cambiaron. */
  failedNotes: ReadonlySet<string>;
  failedFiles: ReadonlySet<string>;
  failedFolders: ReadonlySet<string>;
  failedBlobs: ReadonlySet<string>;
  failedTags: ReadonlySet<string>;
}

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
  options: { seals: boolean; epoch?: string; configStillInstalled?: () => boolean }
): Promise<GateVerdict> {
  const used = usage.declared();
  // Siempre la transacción entera, aunque no haya nada declarado (R3-6 de la 3.ª revisión de
  // Codex): el filtro de ahora tiene que resolver, y la época tiene que ser la de la llamada.
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
    blobs: [...used.blobs],
    operationTargets: [...used.operationTargets],
    ...(options.configStillInstalled ? { check: options.configStillInstalled } : {})
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
      : files?.sealOf(id) !== undefined
        ? files.isVisible(id)
        : (() => {
            const plan = snapshot.operationPlans?.get(id);
            return plan !== undefined && plan.privacySha256 === privacyFingerprint(now) &&
              plan.noteIds.length > 0 && plan.noteIds.every((noteId) => live.visibleMeta(noteId) !== undefined);
          })();
    if (!visible) failedNotes.add(id);
  }
  const failedFiles = new Set<string>();
  for (const [id, use] of used.files) {
    if (files?.isVisible(id) !== true || !sealHolds(use, files.sealOf(id))) failedFiles.add(id);
  }
  const failedFolders = new Set<string>();
  for (const [id, use] of used.folders) {
    if (id === ROOT_FOLDER_ID) continue;
    // La ruta enseñada cuenta incluso en una escritura: puede quedar privada tras mover
    // la carpeta a una ruta aún visible y crear otra bajo la ruta antigua.
    const visible = live.folderExists(id) && !live.isFolderHidden(id);
    const samePath = !use.conflict && (use.path === undefined || live.folderPath(id) === use.path);
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
  const declaredPassed =
    failedNotes.size === 0 &&
    failedFiles.size === 0 &&
    failedFolders.size === 0 &&
    failedBlobs.size === 0 &&
    failedTags.size === 0;
  const epochChanged = options.epoch !== undefined && options.epoch !== snapshot.epoch;
  const configChanged = !snapshot.check;
  return {
    passed: declaredPassed && !epochChanged && !configChanged,
    declaredPassed,
    configChanged,
    epochChanged,
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
  call: { config: PrivacyConfig; epoch?: string },
  usage: GateUsage,
  options: { seals: boolean }
): Promise<GateVerdict> {
  const before = await gateConfig(server);
  // `config.json` se mira otra vez DENTRO de la transacción, síncrono: después de ella no queda
  // ninguna espera antes de responder (R4-1 de la 4.ª revisión de Codex: la segunda lectura de
  // la huella, asíncrona y posterior, dejaba un hueco en el que podía cambiar el almacén).
  const source = server.privacyConfigSource;
  const verdict = await passGate(port, before, usage, {
    ...options,
    epoch: call.epoch,
    ...(source?.isInstalledNow ? { configStillInstalled: () => source.isInstalledNow!() } : {})
  });
  if (samePrivacyConfig(before, call.config)) return verdict;
  return { ...verdict, passed: false, configChanged: true };
}

/** Lo que hizo una llamada: su resultado o su error. */
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: ToolError };

/**
 * Qué hace la puerta con una herramienta (`register-tools.ts`):
 * - `repeat` (las lecturas): si no pasa (lo declarado, la configuración o la época), se repite
 *   entera, también si dio un error; al agotar los intentos, `fallback`, la respuesta del
 *   estado fresco (por defecto, `not_found`). `discard` deshace lo que deja un intento
 *   descartado (el plan de una simulación).
 * - `filter` (las escrituras): no se repiten. Un informe se reduce a lo que resiste el filtro
 *   nuevo (`redact`, sobre lo declarado: por defecto, si algo ya no se ve, `not_found`); la
 *   época no lo anula, porque la propia escritura (y su ronda) la cambian. Un error ligado a un
 *   objeto, si la puerta no pasa ENTERA (lo declarado, la configuración o la época: con
 *   algo cambiado no se puede confirmar que ese objeto se siga viendo), pasa a `staleError`
 *   (por defecto, `not_found`).
 */
export type GatePolicy =
  | {
      kind: 'repeat';
      fallback?: () => ToolOutcome;
      discard?: (outcome: ToolOutcome) => Promise<void>;
    }
  | {
      kind: 'filter';
      redact?: (outcome: ToolOutcome, verdict: GateVerdict) => ToolOutcome;
      staleError?: (error: ToolError, verdict: GateVerdict) => ToolOutcome;
    };

/**
 * Los errores que no dependen de ningún objeto de la biblioteca (el escritor, la
 * configuración): una escritura los devuelve tal cual aunque la puerta no pase. Todos los
 * demás (`no_match`, `ambiguous_heading`, `note_locked`, `operation_id_reused`,
 * `folder_name_taken`, `revision_conflict`…) dicen algo de una nota, carpeta o fichero.
 * `invalid_input` es de la entrada solo si se dio ANTES de usar ningún objeto: el escritor
 * también lo da después de haber elegido la nota (una revisión de otra nota, R4-4 de la 4.ª
 * revisión de Codex), y entonces dice que esa nota existía.
 */
const OBJECT_FREE_ERRORS: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'busy_other_instance',
  'writer_outdated',
  'privacy_config_unresolved'
]);

/** ¿Un error que no dice nada de ningún objeto, con lo que la llamada usó hasta darlo? */
export function isObjectFreeError(error: ToolError, usage: GateUsage): boolean {
  if (error.code === 'invalid_input') return usage.empty;
  return OBJECT_FREE_ERRORS.has(error.code);
}

export const NOT_FOUND_OUTCOME = (): ToolOutcome => ({ ok: false, error: new ToolError('not_found') });

/** El filtro por defecto de un informe de escritura: si algo de lo que nombra ya no se ve,
 *  la respuesta de algo que no existe (C3), aunque la escritura se hiciera. */
export function redactWhole(outcome: ToolOutcome, verdict: GateVerdict): ToolOutcome {
  return verdict.declaredPassed ? outcome : NOT_FOUND_OUTCOME();
}

/**
 * Lo que repite la puerta, para medirlo (SPEC.md §6.3; `test/perf/gate-repeats.perf.ts`):
 * llamadas, intentos repetidos (y por qué) y respuestas del estado fresco. Solo números, en
 * este proceso; nunca sale en ninguna respuesta ni en el log.
 */
export const gateStats = {
  calls: 0,
  repeats: 0,
  repeatsByEpoch: 0,
  repeatsByConfig: 0,
  fresh: 0,
  reset(): void {
    this.calls = 0;
    this.repeats = 0;
    this.repeatsByEpoch = 0;
    this.repeatsByConfig = 0;
    this.fresh = 0;
  }
};
