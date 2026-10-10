/**
 * `hebra_replace_in_notes` (D14, decidido por David el 10 oct 2026; tarea F3 de Lumbre
 * db978cf0, la fase F3 del audit `2026-10-10-sqlite-o-markdown.md` de Hebra): sustituir un
 * literal o una expresión regular en un lote de notas, en dos pasos obligatorios. Todo
 * ocurre en el ESCRITOR (un lector lo reenvía por `writer.sock`, op `replaceInNotes`), con
 * la configuración de privados de quien pide.
 *
 * 1. **Simular** (`simulate`): recorre las notas visibles del ámbito como `hebra_grep`
 *    (mismas reglas de qué se mira, mismo prefiltro y la expresión en un hilo con plazo),
 *    calcula el cuerpo resultante de cada una y guarda el plan (`./replace-plans.ts`): por
 *    nota, el SHA-256 del cuerpo base y del resultante y el resultante ENTERO. Devuelve un
 *    `planId` y, por nota, id, título, coincidencias y unas líneas antes/después, paginado
 *    (`preview` da las páginas siguientes). Nada se escribe en ninguna nota.
 * 2. **Aplicar** (`apply`, con `planId` y `operationId`): por cada nota del plan, en orden
 *    y en su propio turno del escritor, `replaceBodyInTurn` (`./body-writes.ts`, el mismo
 *    turno que los ficheros de trabajo de D12) con el cuerpo resultante guardado:
 *    - privacidad con la fila de ese momento: oculta, borrada o en la papelera, no se toca
 *      ni sale en el informe;
 *    - «ya estaba»: si el cuerpo ya es el resultante, no se escribe (lo que hace repetible
 *      una aplicación cortada, AC5);
 *    - si el cuerpo es el base: se guarda en el plan (AC6), instantánea forzada
 *      (`noteVersionSnapshot`) y `noteSave`;
 *    - si cambió desde la simulación: copia de conflicto visible con el resultado (como
 *      `hebra_edit_note`), sin tocar el original, y sin crear otra si ya hay una igual.
 *    Aplica SOLO lo simulado: nunca vuelve a ejecutar la expresión.
 * 3. **Deshacer** (`undo`, con `planId`): por cada nota que el lote escribió, si su cuerpo
 *    sigue siendo el resultante vuelve a la base (con instantánea antes); si cambió después,
 *    no se toca y se lista. Una copia de conflicto del lote va a la papelera si sigue igual.
 *
 * Privacidad (D3): ninguna nota oculta entra en el plan, en los recuentos ni en el informe.
 * Una nota cuyo resultado tendría una etiqueta privada (regla 4 de D2) o el prefijo de una
 * bloqueada no entra en el plan, sin decir por qué: como una que no existe.
 */
import { randomUUID } from 'node:crypto';
import { canonicalTag, deriveNote, reorderToggledTasks } from '../hebra';
import type { PrivacyConfig } from '../privacy/config';
import { PrivacyFilter } from '../privacy/filter';
import { replaceBodyInTurn, trashConflictCopiesInTurn, type ReplaceBodyTestHooks } from './body-writes';
import { writeRejected } from './errors';
import { compileGrepPattern, trigramMatch } from './grep';
import type { GrepBodiesSession, GrepNoteRow } from './grep-sql';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import {
  compileReplacement,
  globalPattern,
  PLAN_RESULT_MAX_CHARS,
  PREVIEW_CHANGES_PER_NOTE,
  previewChange,
  privacyFingerprint,
  REPLACE_MAX_NOTES,
  REPLACE_SCOPE_MAX_IDS,
  replaceBodyLines,
  sha256Hex,
  type ReplaceChange,
  type ReplaceLinesResult,
  type ReplacementPart
} from './replace';
import { logEvent } from '../log/logger';
import {
  PLAN_APPLY_TTL_MS,
  STORED_PLAN_CHARS_MAX,
  STORED_PLANS_MAX,
  type ApplyOutcome,
  type NoteProof,
  type PlanNoteRecord,
  type PlanRecord,
  type UndoCopyOutcome,
  type UndoOutcome
} from './replace-plans';
import { RegexReplaceWorker, type ReplaceOutcome } from './replace-worker';
import { encodeRevision } from './revision';
import { capHeading } from './sections';
import type { HebraLibraryPort } from './types';
import {
  LOCKED_BODY_PREFIX,
  privacyInTurn,
  REPLACE_BODY_MAX_LENGTH,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Plazo para recorrer los cuerpos en la simulación (el de `hebra_grep`). */
export const REPLACE_SIMULATE_BUDGET_MS = 2_000;
/** Plazo de una llamada a `apply`: al agotarse, sale lo hecho (`complete: false`) y
 *  repetir con el mismo `operationId` sigue. Por debajo del plazo del reenvío. */
export const REPLACE_APPLY_BUDGET_MS = 20_000;
/** Tope de la respuesta de una página de la simulación, como `hebra_grep`: la suma del
 *  JSON de sus notas, en unidades UTF-16. La primera nota sale siempre. */
export const REPLACE_RESPONSE_MAX_CHARS = 100_000;
/** Notas por página de la simulación: por defecto y como mucho. */
export const REPLACE_PAGE_DEFAULT = 50;
export const REPLACE_PAGE_MAX = REPLACE_MAX_NOTES;
/** Notas que `skipped` lista como mucho (las demás que no entran por tamaño no se nombran;
 *  el corte o el plan ya lo dicen). */
const SKIPPED_MAX = 50;
/** Notas por lote de lectura en la simulación, como `hebra_grep`. */
const SIMULATE_BATCH_NOTES = 64;
/** Tope de un id que llega en el ámbito o en un cursor. */
const ID_MAX_LENGTH = 200;
/** Tope de un `planId` (son UUID). */
export const PLAN_ID_MAX_LENGTH = 200;
const CURSOR_MAX_LENGTH = 2_048;

/** Ámbito de la simulación: carpeta (con `subfolders`, su subárbol), etiqueta (con sus
 *  descendientes, como `hebra_grep`) y lista explícita de ids; lo que se pida, a la vez. */
export interface ReplaceScope {
  folder?: string;
  subfolders?: boolean;
  tag?: string;
  ids?: string[];
}

export interface ReplaceSimulateRequest {
  mode: 'simulate';
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  replacement: string;
  scope: ReplaceScope;
  /** Notas como mucho en el plan (1-`REPLACE_MAX_NOTES`). */
  maxNotes: number;
  /** `continueAfter` de una simulación anterior: sigue el ámbito por ahí. */
  after?: string;
  /** Notas en la primera página de la respuesta. */
  limit: number;
  privacy: PrivacyConfig;
}

export interface ReplacePreviewRequest {
  mode: 'preview';
  planId: string;
  cursor: string;
  limit: number;
  privacy: PrivacyConfig;
}

export interface ReplaceApplyRequest {
  mode: 'apply';
  planId: string;
  operationId: string;
  privacy: PrivacyConfig;
}

export interface ReplaceUndoRequest {
  mode: 'undo';
  planId: string;
  privacy: PrivacyConfig;
}

export type ReplaceRequest =
  | ReplaceSimulateRequest
  | ReplacePreviewRequest
  | ReplaceApplyRequest
  | ReplaceUndoRequest;

export type ReplaceMode = ReplaceRequest['mode'];

/** Una nota del plan, como la enseña la simulación. */
export interface ReplacePlanNoteView {
  id: string;
  title: string;
  isConflictCopy: boolean;
  /** Coincidencias sustituidas en la nota. */
  matches: number;
  /** Las primeras líneas que cambian (como mucho `PREVIEW_CHANGES_PER_NOTE`). */
  changes: ReplaceChange[];
}

/** Por qué la simulación paró antes de recorrer todo el ámbito. */
export type ReplaceCutoff = 'maxNotes' | 'time' | 'size';

/** Una nota visible del ámbito que la simulación NO metió en el plan, y por qué:
 *  `too_large` (el resultado pasaría del tope de un cuerpo) o `too_slow` (la expresión no
 *  terminó esa nota en todo el plazo: se salta). */
export interface ReplaceSkipped {
  id: string;
  title: string;
  reason: 'too_large' | 'too_slow';
}

export interface ReplacePlanView {
  mode: 'simulate' | 'preview';
  /** `null` si no cambiaría ninguna nota (no se guarda ningún plan). */
  planId: string | null;
  /** Hasta cuándo se puede aplicar (ISO 8601). */
  expiresAt: string | null;
  notes: ReplacePlanNoteView[];
  /** Página siguiente del MISMO plan (`mode: "preview"`). */
  nextCursor: string | null;
  /** Solo en `simulate`: notas y coincidencias de todo el plan (solo visibles). */
  planNotes?: number;
  planMatches?: number;
  /** Solo en `simulate`. */
  cutoff?: ReplaceCutoff | null;
  /** Solo en `simulate`: con un corte, la posición por la que seguir el ámbito en OTRA
   *  simulación (`after`); `null` si se recorrió entero. */
  continueAfter?: string | null;
  skipped?: ReplaceSkipped[];
}

/** Una nota en el informe de `apply`, leído de lo guardado. */
export interface ReplaceReportNote {
  id: string;
  title: string;
  /** `applied`: entró; `already`: ya tenía el resultado sin que este lote lo escribiera;
   *  `conflict_copy`: cambió desde la simulación y el resultado fue a una copia (`copyId`);
   *  `locked`: está bloqueada, no se tocó; `pending`: no se llegó (corte por plazo). */
  outcome: 'applied' | 'already' | 'conflict_copy' | 'locked' | 'pending';
  /** Prueba de lo guardado (`applied`/`already`), leída de la nota en el turno en que se
   *  escribió: la revisión nueva (vale como `expectedRevision`), el tamaño y el SHA-256. */
  revision?: string;
  totalChars?: number;
  bodySha256?: string;
  copyId?: string;
}

export interface ReplaceApplyReport {
  mode: 'apply';
  planId: string;
  /** `false`: quedan notas `pending`; repetir con el mismo `operationId` sigue. */
  complete: boolean;
  /** Devuelto de lo anotado, sin escribir nada. */
  replayed?: true;
  /** El plan se deshizo (o se está deshaciendo): no se va a aplicar nada más, y
   *  `complete` es `true` aunque quedaran notas sin aplicar. */
  undone?: true;
  notes: ReplaceReportNote[];
}

/** Una nota en el informe de `undo`. */
export interface ReplaceUndoNote {
  id: string;
  title: string;
  /** Solo si el lote escribió la nota: `restored` (vuelve a la base), `already` (ya estaba
   *  en la base), `changed` (cambió después del lote: no se toca), `locked`; `pending` si
   *  esta llamada no llegó a ella (plazo). */
  outcome?: 'restored' | 'already' | 'changed' | 'locked' | 'pending';
  revision?: string;
  totalChars?: number;
  bodySha256?: string;
  /** Solo si el lote dejó una copia de conflicto: qué pasó con ella. */
  copyId?: string;
  copyOutcome?: UndoCopyOutcome;
}

export interface ReplaceUndoReport {
  mode: 'undo';
  planId: string;
  /** `false`: el plazo cortó la llamada; repetir `undo` sigue por lo que falta. */
  complete: boolean;
  notes: ReplaceUndoNote[];
}

export type ReplaceResult = ReplacePlanView | ReplaceApplyReport | ReplaceUndoReport;

/** Lo que devuelve el escritor: el resultado y las notas (o copias) que escribió, para el
 *  estado de sync (`src/server/write-context.ts`). */
export interface ReplaceLocal {
  result: ReplaceResult;
  written: string[];
}

/** Solo para tests (nunca llegan del socket ni de una herramienta). */
export interface ReplaceTestHooks extends ReplaceBodyTestHooks {
  /** Tras escribir la nota de esa posición y ANTES de anotarlo en el plan: el hueco del
   *  `kill -9` de AC5 (`test/replace/apply-corte.node.test.ts`). */
  afterWrite?(position: number): Promise<void> | void;
}

export interface ReplaceBatchOptions {
  /** Tras cada escritura (la ronda de después, sin esperarla). */
  onWritten?: () => void;
  /** Tests: otros plazos. */
  simulateBudgetMs?: number;
  applyBudgetMs?: number;
  undoBudgetMs?: number;
  /** Tests: otros topes de lo guardado sin aplicar (`STORED_PLANS_MAX`,
   *  `STORED_PLAN_CHARS_MAX`). */
  maxStoredPlans?: number;
  maxStoredPlanChars?: number;
}

/** Lo que la simulación lee del almacén (fuera del turno de escritura). */
export type ReplaceReadPort = Pick<
  HebraLibraryPort,
  'grepNotes' | 'grepCandidates' | 'grepBodies' | 'foldersList' | 'notesVisibilityIndex'
>;

/** Una nota que la simulación metería en el plan. */
interface Candidate {
  id: string;
  title: string;
  conflict: boolean;
  baseSha256: string;
  resultBody: string;
  resultTags: string[];
  matches: number;
  changes: ReplaceChange[];
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH;
}

/** Cursores propios, opacos: `rc1` (seguir el ámbito en otra simulación: `[id, desde]`, con
 *  `desde` 1 si esa nota entra y 0 si se empieza en la siguiente) y `rp1` (página siguiente
 *  de un plan: `[planId, posición]`). */
function wrap(kind: 'rc1' | 'rp1', payload: unknown): string {
  return `${kind}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function unwrap(kind: 'rc1' | 'rp1', cursor: string): unknown {
  if (cursor.length > CURSOR_MAX_LENGTH || !cursor.startsWith(`${kind}.`)) throw writeRejected('invalid_input');
  try {
    return JSON.parse(Buffer.from(cursor.slice(kind.length + 1), 'base64url').toString('utf8'));
  } catch {
    throw writeRejected('invalid_input');
  }
}

function parseContinue(cursor: string): { id: string; inclusive: boolean } {
  const value = unwrap('rc1', cursor);
  if (!Array.isArray(value) || value.length !== 2 || !isId(value[0]) || (value[1] !== 0 && value[1] !== 1)) {
    throw writeRejected('invalid_input');
  }
  return { id: value[0], inclusive: value[1] === 1 };
}

function parsePageCursor(cursor: string, planId: string): number {
  const value = unwrap('rp1', cursor);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== planId ||
    !Number.isSafeInteger(value[1]) ||
    (value[1] as number) < 0
  ) {
    throw writeRejected('invalid_input');
  }
  return value[1] as number;
}

function validCount(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/** Los cambios guardados de una nota (JSON propio, ya validado al guardarlo). */
function changesOf(preview: string): ReplaceChange[] {
  try {
    const value = JSON.parse(preview) as unknown;
    return Array.isArray(value) ? (value as ReplaceChange[]) : [];
  } catch {
    return [];
  }
}

/** La prueba de lo guardado, de la fila recién leída en el turno. */
async function proofOf(store: NoteWriteStore, id: string): Promise<NoteProof | null> {
  const row = await store.noteRead(id);
  return row ? { localSeq: row.localSeq, bodySha256: row.bodySha256, totalChars: row.body.length } : null;
}

/** Un plan de ESTA biblioteca y, con `samePrivacy` (`preview` y `apply`), de ESTA
 *  configuración de privados; si no, `plan_not_found` (las causas, igual). `undo` no la
 *  exige (M4: comprueba cada nota en su turno con la de ahora). Una lápida (aplicado hace
 *  más de 7 días, ya sin cuerpos), `plan_expired`. */
function requirePlan(store: NoteWriteStore, planId: string, privacy: PrivacyConfig, samePrivacy: boolean): PlanRecord {
  const plan = store.replacePlans.plan(planId);
  if (
    !plan ||
    plan.libraryId !== store.libraryId() ||
    (samePrivacy && plan.privacySha256 !== privacyFingerprint(privacy))
  ) {
    throw writeRejected('plan_not_found');
  }
  if (plan.state === 'expired') throw writeRejected('plan_expired');
  return plan;
}

/** Huella de la aplicación de un plan en el registro de operaciones compartido: un
 *  `operationId` de otra escritura no vale aquí, ni al revés (`operation_id_reused`). */
function applyFingerprint(planId: string): string {
  return sha256Hex(JSON.stringify(['replaceInNotes', planId]));
}

export class ReplaceBatch {
  /** Una aplicación o una vuelta atrás a la vez por plan, en este proceso (el único
   *  escritor): un reintento que llega con la primera aún en marcha espera a que acabe. */
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly port: ReplaceReadPort,
    private readonly target: NoteWriteTarget,
    private readonly options: ReplaceBatchOptions = {}
  ) {}

  run(request: ReplaceRequest, hooks: ReplaceTestHooks = {}): Promise<ReplaceLocal> {
    switch (request.mode) {
      case 'simulate':
        return this.simulate(request);
      case 'preview':
        return this.preview(request);
      case 'apply':
        return this.serialized(request.planId, () => this.apply(request, hooks));
      case 'undo':
        return this.serialized(request.planId, () => this.undo(request));
    }
  }

  /**
   * Purga los planes caducados (M3), en UN turno corto del escritor: dos `DELETE` y un
   * `UPDATE`, sin leer cuerpos. La llama la instancia al pasar a escritor y en cada
   * `checkWriter` (cada 30 s), además de cada operación de plan. Nunca rechaza: un fallo
   * se anota sin mensaje y lo reintenta la siguiente.
   */
  async purgeExpired(): Promise<void> {
    try {
      await this.target.writeExclusive(async (store) => store.replacePlans.purgeExpired(Date.now()));
    } catch (error) {
      logEvent({
        event: 'replace.purge',
        result: 'failed',
        error: error instanceof Error ? error.name : 'unknown'
      });
    }
  }

  private async serialized<T>(planId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.running.get(planId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.running.set(planId, settled);
    try {
      return await next;
    } finally {
      if (this.running.get(planId) === settled) this.running.delete(planId);
    }
  }

  private written(): void {
    try {
      this.options.onWritten?.();
    } catch {
      // La escritura ya está en disco; la ronda periódica la subirá.
    }
  }

  /** Títulos y si es copia de conflicto de las notas vivas, y un filtro de privados
   *  recién hecho: lo que necesita cualquier salida, para no nombrar una que ya es oculta. */
  private async visibleNow(privacy: PrivacyConfig): Promise<{
    filter: PrivacyFilter;
    rows: Map<string, GrepNoteRow>;
  }> {
    const filter = await PrivacyFilter.build(this.port, privacy);
    if (filter.unresolved) throw writeRejected('privacy_config_unresolved');
    const rows = new Map<string, GrepNoteRow>();
    for (const row of await this.port.grepNotes()) {
      if (filter.visibleMeta(row.id)) rows.set(row.id, row);
    }
    return { filter, rows };
  }

  // --- Simular -------------------------------------------------------------------------

  private async simulate(request: ReplaceSimulateRequest): Promise<ReplaceLocal> {
    const pattern = compileGrepPattern(request.pattern, {
      regex: request.regex,
      caseSensitive: request.caseSensitive
    });
    if (!pattern) throw writeRejected('invalid_input');
    const parts = compileReplacement(request.replacement, pattern);
    if (!parts) throw writeRejected('invalid_input');
    if (!validCount(request.maxNotes, REPLACE_MAX_NOTES) || !validCount(request.limit, REPLACE_PAGE_MAX)) {
      throw writeRejected('invalid_input');
    }
    const { scope } = request;
    if (scope.ids !== undefined && (scope.ids.length > REPLACE_SCOPE_MAX_IDS || !scope.ids.every(isId))) {
      throw writeRejected('invalid_input');
    }
    const after = request.after === undefined ? null : parseContinue(request.after);

    const filter = await PrivacyFilter.build(this.port, request.privacy);
    if (filter.unresolved) throw writeRejected('privacy_config_unresolved');
    const nothing = (extra: Partial<ReplacePlanView> = {}): ReplaceLocal => ({
      result: {
        mode: 'simulate',
        planId: null,
        expiresAt: null,
        notes: [],
        nextCursor: null,
        planNotes: 0,
        planMatches: 0,
        cutoff: null,
        continueAfter: null,
        ...extra
      },
      written: []
    });

    // Filtros, como `hebra_grep`: una etiqueta o una carpeta privadas o inexistentes dan
    // un plan vacío, sin mirar nada.
    let tag: string | undefined;
    if (scope.tag !== undefined) {
      const canonical = canonicalTag(scope.tag)?.tag;
      if (!canonical || filter.isTagHidden(canonical)) return nothing();
      tag = canonical;
    }
    let inFolder: ((folderId: string) => boolean) | undefined;
    if (scope.folder !== undefined) {
      const resolved = filter.folderIdForPath(scope.folder);
      if (!resolved || filter.isFolderHidden(resolved)) return nothing();
      if (scope.subfolders) {
        const subtree = new Set(filter.folderSubtree(resolved));
        inFolder = (folderId) => subtree.has(folderId);
      } else {
        inFolder = (folderId) => folderId === resolved;
      }
    }
    const ids = scope.ids === undefined ? null : new Set(scope.ids);

    // Qué notas se miran, sin leer ningún cuerpo, en orden de id y desde `after`.
    let pending: GrepNoteRow[] = [];
    for (const row of await this.port.grepNotes()) {
      if (row.locked) continue;
      const meta = filter.visibleMeta(row.id);
      if (!meta) continue;
      if (inFolder && !inFolder(meta.folderId)) continue;
      if (tag !== undefined && !filter.hasTag(row.id, tag)) continue;
      if (ids && !ids.has(row.id)) continue;
      if (after) {
        const order = byId(row.id, after.id);
        if (order < 0 || (order === 0 && !after.inclusive)) continue;
      }
      pending.push(row);
    }
    pending.sort((left, right) => byId(left.id, right.id));
    const match = trigramMatch(pattern.required, request.caseSensitive);
    if (match !== null && pending.length > 0) {
      const candidates = await this.port.grepCandidates(match, pending.map((note) => note.rowid));
      if (candidates) pending = pending.filter((note) => candidates.has(note.rowid));
    }

    const re = globalPattern(pattern);
    const entries: Candidate[] = [];
    const skipped: ReplaceSkipped[] = [];
    let totalChars = 0;
    let cutoff: ReplaceCutoff | null = null;
    let continueAt: { id: string; inclusive: boolean } | null = null;
    let progressed = false;
    let session: GrepBodiesSession | null = null;
    const worker = pattern.literal ? null : await RegexReplaceWorker.start(re, parts);
    // El plazo cuenta desde el primer cuerpo leído, como en `hebra_grep`.
    let deadline = Infinity;
    try {
      for (let first = 0; first < pending.length && cutoff === null; first += SIMULATE_BATCH_NOTES) {
        const batch = pending.slice(first, first + SIMULATE_BATCH_NOTES);
        if (progressed && Date.now() >= deadline) {
          cutoff = 'time';
          continueAt = { id: batch[0]!.id, inclusive: true };
          break;
        }
        const read = await this.port.grepBodies(
          batch.map((note) => note.rowid),
          request.privacy,
          session
        );
        if (read.unresolved) throw writeRejected('privacy_config_unresolved');
        session = read.session;
        if (deadline === Infinity) deadline = Date.now() + (this.options.simulateBudgetMs ?? REPLACE_SIMULATE_BUDGET_MS);
        // Una que dejó de estar viva, se bloqueó o pasó a oculta (filtro rehecho en el
        // turno de la lectura) se salta.
        const notes = batch.filter((note) => read.bodies.has(note.rowid));
        const bodies = notes.map((note) => read.bodies.get(note.rowid)!);
        const nextAfterBatch = pending[first + SIMULATE_BATCH_NOTES];

        const onNote = (index: number, result: ReplaceLinesResult): boolean => {
          progressed = true;
          const note = notes[index]!;
          const base = bodies[index]!;
          // M1: un resultado que pasaría del tope ni siquiera se construyó; se dice, antes
          // de ningún trabajo con él (`reorderToggledTasks`, `deriveNote`).
          if (result.tooLarge) {
            if (skipped.length < SKIPPED_MAX) {
              skipped.push({ id: note.id, title: capHeading(note.title), reason: 'too_large' });
            }
            return true;
          }
          if (result.count === 0) return true;
          // Las tareas que la sustitución marca o desmarca se colocan como en el editor de
          // Hebra (David, 4 oct 2026: «el orden tiene que ser el mismo venga de donde venga
          // el cambio»), y ESE es el resultado que se simula y se aplica.
          const body = reorderToggledTasks(base, result.body);
          if (body === base || body.startsWith(LOCKED_BODY_PREFIX)) return true;
          const resultTags = (deriveNote(body).tags ?? []).map(({ tag: name }) => name);
          // Regla 4 de D2: nunca una etiqueta privada en una nota visible. Fuera del plan,
          // sin decir por qué: como una nota que no existe.
          if (filter.hidesAnyTag(resultTags)) return true;
          if (body.length > REPLACE_BODY_MAX_LENGTH) {
            if (skipped.length < SKIPPED_MAX) {
              skipped.push({ id: note.id, title: capHeading(note.title), reason: 'too_large' });
            }
            return true;
          }
          if (entries.length >= request.maxNotes) {
            cutoff = 'maxNotes';
            continueAt = { id: note.id, inclusive: true };
            return false;
          }
          if (totalChars + body.length > PLAN_RESULT_MAX_CHARS) {
            cutoff = 'size';
            continueAt = { id: note.id, inclusive: true };
            return false;
          }
          totalChars += body.length;
          entries.push({
            id: note.id,
            title: note.title,
            conflict: note.conflict,
            baseSha256: sha256Hex(base),
            resultBody: body,
            resultTags,
            matches: result.count,
            changes: result.changes.map(previewChange)
          });
          return true;
        };

        const outcome = worker
          ? await worker.replace(bodies, PREVIEW_CHANGES_PER_NOTE, REPLACE_BODY_MAX_LENGTH, deadline, onNote)
          : this.replaceLiteral(bodies, re, parts, deadline, () => progressed, onNote);
        if (outcome.status === 'stopped') break;
        if (outcome.status === 'interrupted') {
          const stuck = notes[outcome.next];
          if (!stuck) {
            // Todas las del lote terminadas y el plazo llegó antes del aviso de fin.
            if (nextAfterBatch) {
              cutoff = 'time';
              continueAt = { id: nextAfterBatch.id, inclusive: true };
            }
            break;
          }
          cutoff = 'time';
          if (!progressed) {
            // La expresión no terminó esa nota en todo el plazo: se salta, se dice y se
            // sigue por la siguiente en otra simulación.
            skipped.push({ id: stuck.id, title: capHeading(stuck.title), reason: 'too_slow' });
            continueAt = { id: stuck.id, inclusive: false };
          } else {
            continueAt = { id: stuck.id, inclusive: true };
          }
          break;
        }
        if (outcome.status === 'time') {
          const next = notes[outcome.next] ?? nextAfterBatch;
          if (next) {
            cutoff = 'time';
            continueAt = { id: next.id, inclusive: true };
          }
          break;
        }
      }
    } finally {
      await worker?.close();
    }
    // Sin nada detrás (el corte cayó justo al final del ámbito), no hay corte.
    const continueAfter = continueAt === null ? null : wrap('rc1', [continueAt.id, continueAt.inclusive ? 1 : 0]);
    const extra: Partial<ReplacePlanView> = { cutoff, continueAfter };
    if (skipped.length > 0) extra.skipped = skipped;
    if (entries.length === 0) return nothing(extra);

    // Guardar el plan, en UN turno del escritor y comprobando cada nota con su fila de
    // AHORA: viva, visible, sin bloquear y con el cuerpo que se simuló. La que no, fuera.
    const planId = randomUUID();
    const createdAt = Date.now();
    const kept = await this.target.writeExclusive(async (store) => {
      store.replacePlans.purgeExpired(createdAt);
      const inTurn = privacyInTurn(store, request.privacy);
      const keep: Candidate[] = [];
      for (const entry of entries) {
        const note = await store.noteRead(entry.id);
        if (!note || note.trashedAt !== null || inTurn.isHiddenNote(note.id)) continue;
        if (note.body.startsWith(LOCKED_BODY_PREFIX) || note.bodySha256 !== entry.baseSha256) continue;
        if (inTurn.hidesAnyTag(entry.resultTags)) continue;
        keep.push(entry);
      }
      if (keep.length === 0) return keep;
      // M2: tope de lo guardado sin aplicar. Caen los más antiguos SIN aplicar; uno aplicado
      // o a medias nunca (hace falta para deshacer).
      const maxPlans = this.options.maxStoredPlans ?? STORED_PLANS_MAX;
      const maxChars = this.options.maxStoredPlanChars ?? STORED_PLAN_CHARS_MAX;
      const newChars = keep.reduce((sum, entry) => sum + entry.resultBody.length, 0);
      const stored = store.replacePlans.unapplied();
      let storedChars = stored.reduce((sum, plan) => sum + plan.resultChars, 0);
      while (stored.length > 0 && (stored.length + 1 > maxPlans || storedChars + newChars > maxChars)) {
        const oldest = stored.shift()!;
        store.replacePlans.deleteUnapplied(oldest.planId);
        storedChars -= oldest.resultChars;
      }
      store.replacePlans.insert(
        {
          planId,
          libraryId: store.libraryId(),
          privacySha256: privacyFingerprint(request.privacy),
          createdAt,
          matches: keep.reduce((sum, entry) => sum + entry.matches, 0)
        },
        keep.map((entry) => ({
          noteId: entry.id,
          baseSha256: entry.baseSha256,
          resultSha256: sha256Hex(entry.resultBody),
          resultBody: entry.resultBody,
          matches: entry.matches,
          preview: JSON.stringify(entry.changes)
        }))
      );
      return keep;
    });
    if (kept.length === 0) return nothing(extra);
    const views = kept.map((entry, position) => ({
      position,
      view: {
        id: entry.id,
        title: capHeading(entry.title),
        isConflictCopy: entry.conflict,
        matches: entry.matches,
        changes: entry.changes
      }
    }));
    const page = this.page(planId, views, request.limit);
    return {
      result: {
        mode: 'simulate',
        planId,
        expiresAt: new Date(createdAt + PLAN_APPLY_TTL_MS).toISOString(),
        notes: page.notes,
        nextCursor: page.nextCursor,
        planNotes: kept.length,
        planMatches: kept.reduce((sum, entry) => sum + entry.matches, 0),
        ...extra
      },
      written: []
    };
  }

  /** Un literal se sustituye en el hilo principal (es lineal), mirando el plazo entre nota
   *  y nota si ya se avanzó algo en esta llamada, y también DENTRO de cada nota (M1: una
   *  nota enorme no se lo salta); con el tope de tamaño del resultado mientras se
   *  construye. Una nota cortada por el plazo cuenta como interrumpida, como en el hilo. */
  private replaceLiteral(
    bodies: readonly string[],
    re: RegExp,
    parts: readonly ReplacementPart[],
    deadline: number,
    mayCut: () => boolean,
    onNote: (index: number, result: ReplaceLinesResult) => boolean
  ): ReplaceOutcome | { status: 'time'; next: number } {
    for (let index = 0; index < bodies.length; index += 1) {
      if (mayCut() && Date.now() >= deadline) return { status: 'time', next: index };
      // Un literal sin coincidencias no se parte en líneas.
      re.lastIndex = 0;
      const body = bodies[index]!;
      const result = re.test(body)
        ? replaceBodyLines(body, re, parts, PREVIEW_CHANGES_PER_NOTE, REPLACE_BODY_MAX_LENGTH, deadline)
        : { body, count: 0, changes: [] };
      if (result.timedOut) return { status: 'interrupted', next: index };
      if (!onNote(index, result)) return { status: 'stopped' };
    }
    return { status: 'done' };
  }

  /** Una página de un plan desde `from`: como mucho `limit` notas y
   *  `REPLACE_RESPONSE_MAX_CHARS` de JSON (la primera sale siempre), y `nextCursor` solo si
   *  queda otra detrás. */
  private page(
    planId: string,
    views: ReadonlyArray<{ position: number; view: ReplacePlanNoteView }>,
    limit: number
  ): { notes: ReplacePlanNoteView[]; nextCursor: string | null } {
    const notes: ReplacePlanNoteView[] = [];
    let chars = 0;
    for (const [index, entry] of views.entries()) {
      const size = JSON.stringify(entry.view).length;
      if (notes.length >= limit || (notes.length > 0 && chars + size > REPLACE_RESPONSE_MAX_CHARS)) {
        return { notes, nextCursor: wrap('rp1', [planId, views[index]!.position]) };
      }
      chars += size;
      notes.push(entry.view);
    }
    return { notes, nextCursor: null };
  }

  // --- Páginas de un plan ----------------------------------------------------------------

  private async preview(request: ReplacePreviewRequest): Promise<ReplaceLocal> {
    if (!isId(request.planId) || !validCount(request.limit, REPLACE_PAGE_MAX)) throw writeRejected('invalid_input');
    const from = parsePageCursor(request.cursor, request.planId);
    const { plan, rows } = await this.target.writeExclusive(async (store) => {
      store.replacePlans.purgeExpired(Date.now());
      const found = requirePlan(store, request.planId, request.privacy, true);
      return { plan: found, rows: store.replacePlans.notes(request.planId) };
    });
    // Solo las que siguen visibles ahora: una que pasó a oculta no se nombra.
    const { rows: visible } = await this.visibleNow(request.privacy);
    const views = rows
      .filter((row) => row.position >= from && visible.has(row.noteId))
      .map((row) => {
        const live = visible.get(row.noteId)!;
        return {
          position: row.position,
          view: {
            id: row.noteId,
            title: capHeading(live.title),
            isConflictCopy: live.conflict,
            matches: row.matches,
            changes: changesOf(row.preview)
          }
        };
      });
    const page = this.page(plan.planId, views, request.limit);
    return {
      result: {
        mode: 'preview',
        planId: plan.planId,
        expiresAt: new Date(plan.createdAt + PLAN_APPLY_TTL_MS).toISOString(),
        notes: page.notes,
        nextCursor: page.nextCursor
      },
      written: []
    };
  }

  // --- Aplicar ---------------------------------------------------------------------------

  private async apply(request: ReplaceApplyRequest, hooks: ReplaceTestHooks): Promise<ReplaceLocal> {
    if (!isId(request.planId)) throw writeRejected('invalid_input');
    if (request.operationId.length === 0 || request.operationId.length > OPERATION_ID_MAX_LENGTH) {
      throw writeRejected('invalid_input');
    }
    const fingerprint = applyFingerprint(request.planId);
    const start = await this.target.writeExclusive(async (store) => {
      const now = Date.now();
      store.replacePlans.purgeExpired(now);
      // El registro compartido: un `operationId` de otra escritura no vale para aplicar.
      store.operations.purgeExpired(now);
      const previous = store.operations.lookup(request.operationId);
      if (previous && previous.fingerprint !== fingerprint) throw writeRejected('operation_id_reused');
      const plan = requirePlan(store, request.planId, request.privacy, true);
      if (plan.applyOperationId === null) {
        if (now - plan.createdAt > PLAN_APPLY_TTL_MS) throw writeRejected('plan_expired');
        store.replacePlans.startApply(plan.planId, request.operationId, now);
        if (!previous) {
          store.operations.begin({
            operationId: request.operationId,
            fingerprint,
            noteId: plan.planId,
            targetBodySha256: '',
            now
          });
        }
        return { plan: { ...plan, state: 'applying' as const }, rows: store.replacePlans.notes(plan.planId) };
      }
      if (plan.applyOperationId !== request.operationId) throw writeRejected('plan_already_applied');
      // B2: un `apply` cortado se reanuda solo durante la hora desde que empezó (la misma
      // ventana que para empezarlo). Pasada, `plan_expired`: lo que entró se deshace con
      // `undo`, y el resto se simula otra vez. Responder lo anotado sigue valiendo.
      if (plan.state === 'applying' && now - (plan.appliedAt ?? 0) > PLAN_APPLY_TTL_MS) {
        throw writeRejected('plan_expired');
      }
      return { plan, rows: store.replacePlans.notes(plan.planId) };
    });
    const { plan } = start;
    if (plan.state !== 'applying') {
      // `applied`, o deshecho (`undoing`/`undone`): lo anotado, sin escribir. Deshecho, el
      // plan no se reanuda nunca, y se dice (`undone`, `complete: true`), para que repetir
      // no quede esperando unas pendientes que ya no se van a aplicar (B1).
      return { result: await this.applyReport(plan, start.rows, request.privacy, true), written: [] };
    }

    const written: string[] = [];
    const deadline = Date.now() + (this.options.applyBudgetMs ?? REPLACE_APPLY_BUDGET_MS);
    let first = true;
    for (const row of start.rows) {
      if (row.outcome !== null) continue;
      // Al menos una nota por llamada, para que repetir siempre avance.
      if (!first && Date.now() >= deadline) break;
      first = false;
      const wrote = await this.target.writeExclusive((store) =>
        this.applyNoteInTurn(store, plan.planId, row, request.privacy, hooks)
      );
      if (wrote) {
        written.push(row.noteId);
        this.written();
      }
    }
    const rows = await this.target.writeExclusive(async (store) => {
      const now = store.replacePlans.notes(plan.planId);
      if (now.every((row) => row.outcome !== null)) {
        store.replacePlans.setState(plan.planId, 'applied');
        store.operations.finish(request.operationId, { planId: plan.planId });
      }
      return now;
    });
    return { result: await this.applyReport(plan, rows, request.privacy, false), written };
  }

  /** Una nota del plan, en SU turno del escritor (ver la cabecera). Devuelve si escribió. */
  private async applyNoteInTurn(
    store: NoteWriteStore,
    planId: string,
    row: PlanNoteRecord,
    privacy: PrivacyConfig,
    hooks: ReplaceTestHooks
  ): Promise<boolean> {
    const plans = store.replacePlans;
    const bodies = plans.bodies(planId, row.position);
    if (!bodies) return false;
    const filter = privacyInTurn(store, privacy);
    const note = await store.noteRead(row.noteId);
    const visible = note !== null && note.trashedAt === null && !filter.isHiddenNote(note.id);
    // AC6: el cuerpo base se guarda en el plan ANTES de escribir la nota, en este turno: si
    // el proceso muere justo después del guardado, deshacer lo sigue teniendo.
    if (visible && bodies.base === null && note.bodySha256 === row.baseSha256) {
      plans.saveBase(planId, row.position, note.body);
    }
    // B5: el primer intento queda anotado ANTES de escribir. Una copia de conflicto que se
    // reutiliza (`findCopy`) solo es de este plan si apareció después de un intento suyo
    // anterior (un corte entre crearla y anotarla) y ningún otro plan la tiene como suya.
    const earlierAttempt = row.attemptAt;
    plans.markAttempt(planId, row.position, Date.now());
    const { result, wrote } = await replaceBodyInTurn(
      store,
      {
        id: row.noteId,
        body: bodies.result,
        baseBodySha256: row.baseSha256,
        onConflict: 'copy',
        privacy
      },
      hooks
    );
    if (wrote) await hooks.afterWrite?.(row.position);
    let outcome: ApplyOutcome;
    let copyId: string | null = null;
    let copyOwned = false;
    let proof: NoteProof | null = null;
    switch (result.outcome) {
      case 'applied':
        outcome = 'applied';
        proof = await proofOf(store, row.noteId);
        break;
      case 'already':
        // Con la base ya guardada por este plan, la escribió este lote (un corte entre el
        // guardado y esta anotación): entró.
        outcome = bodies.base !== null ? 'applied' : 'already';
        proof = await proofOf(store, row.noteId);
        break;
      case 'conflict_copy': {
        outcome = 'conflict_copy';
        copyId = result.copyId;
        if (!result.reused) {
          copyOwned = true;
        } else if (earlierAttempt !== null && !plans.copyOwnedElsewhere(copyId, planId)) {
          const copy = await store.noteRead(copyId);
          copyOwned = copy !== null && copy.createdAt >= earlierAttempt;
        }
        break;
      }
      case 'locked':
        outcome = 'locked';
        break;
      default:
        // `unavailable` (y `conflict_rejected`, que con `copy` no se da).
        outcome = 'unavailable';
    }
    plans.recordApply(planId, row.position, outcome, copyId, copyOwned, proof);
    return wrote;
  }

  /** El informe de `apply`, de lo anotado en el plan, sin las notas que ya no son visibles. */
  private async applyReport(
    plan: PlanRecord,
    rows: readonly PlanNoteRecord[],
    privacy: PrivacyConfig,
    replayed: boolean
  ): Promise<ReplaceApplyReport> {
    const { rows: visible } = await this.visibleNow(privacy);
    const notes: ReplaceReportNote[] = [];
    for (const row of rows) {
      if (row.outcome === 'unavailable') continue;
      const live = visible.get(row.noteId);
      if (!live) continue;
      const entry: ReplaceReportNote = {
        id: row.noteId,
        title: capHeading(live.title),
        outcome: row.outcome ?? 'pending'
      };
      if (row.proof) Object.assign(entry, this.proofFields(plan, row.noteId, row.proof));
      if (row.copyId !== null) entry.copyId = row.copyId;
      notes.push(entry);
    }
    const undone = plan.state === 'undoing' || plan.state === 'undone';
    const report: ReplaceApplyReport = {
      mode: 'apply',
      planId: plan.planId,
      // B7: lo pendiente que ya no es visible no cuenta (ni se nombra); deshecho, nada queda
      // pendiente (B1).
      complete: undone || rows.every((row) => row.outcome !== null || !visible.has(row.noteId)),
      notes
    };
    if (undone) report.undone = true;
    if (replayed) report.replayed = true;
    return report;
  }

  private proofFields(
    plan: PlanRecord,
    noteId: string,
    proof: NoteProof
  ): { revision: string; totalChars: number; bodySha256: string } {
    return {
      revision: encodeRevision({
        libraryId: plan.libraryId,
        noteId,
        localSeq: proof.localSeq,
        bodySha256: proof.bodySha256
      }),
      totalChars: proof.totalChars,
      bodySha256: proof.bodySha256
    };
  }

  // --- Deshacer --------------------------------------------------------------------------

  private async undo(request: ReplaceUndoRequest): Promise<ReplaceLocal> {
    if (!isId(request.planId)) throw writeRejected('invalid_input');
    /** Lo que esta vuelta atrás tiene que mirar: lo que el lote escribió o su copia. */
    const touched = (row: PlanNoteRecord): boolean => row.hasBase || row.copyId !== null;
    const start = await this.target.writeExclusive(async (store) => {
      store.replacePlans.purgeExpired(Date.now());
      // M4: deshacer no exige la configuración con que se simuló (cada nota se vuelve a
      // comprobar en su turno con la de AHORA), pero sí una que se pueda aplicar.
      privacyInTurn(store, request.privacy);
      const plan = requirePlan(store, request.planId, request.privacy, false);
      // Una vuelta atrás nueva empieza de cero; una a medias (`undoing`, cortada por el
      // plazo) sigue por las que le faltan.
      if (plan.applyOperationId !== null && plan.state !== 'undoing') {
        store.replacePlans.resetUndo(plan.planId);
        store.replacePlans.setState(plan.planId, 'undoing');
      }
      return { plan, rows: store.replacePlans.notes(plan.planId) };
    });
    const { plan } = start;
    const written: string[] = [];
    const deadline = Date.now() + (this.options.undoBudgetMs ?? REPLACE_APPLY_BUDGET_MS);
    let first = true;
    for (const row of start.rows) {
      if (!touched(row) || row.undoOutcome !== null || row.undoCopy !== null) continue;
      // Al menos una nota por llamada, como `apply`, para que repetir siempre avance.
      if (!first && Date.now() >= deadline) break;
      first = false;
      const wrote = await this.target.writeExclusive((store) =>
        this.undoNoteInTurn(store, plan, row, request.privacy)
      );
      if (wrote.length > 0) {
        written.push(...wrote);
        this.written();
      }
    }
    const rows = await this.target.writeExclusive(async (store) => {
      const now = store.replacePlans.notes(plan.planId);
      const done = now.every((row) => !touched(row) || row.undoOutcome !== null || row.undoCopy !== null);
      if (plan.applyOperationId !== null && done) store.replacePlans.setState(plan.planId, 'undone');
      return now;
    });
    const { rows: visible } = await this.visibleNow(request.privacy);
    const notes: ReplaceUndoNote[] = [];
    for (const row of rows) {
      if (!touched(row)) continue;
      const live = visible.get(row.noteId);
      if (!live) continue;
      const entry: ReplaceUndoNote = { id: row.noteId, title: capHeading(live.title) };
      const processed = row.undoOutcome !== null || row.undoCopy !== null;
      if (!processed) entry.outcome = 'pending';
      else if (row.undoOutcome !== null && row.undoOutcome !== 'unavailable') entry.outcome = row.undoOutcome;
      if (row.undoProof) Object.assign(entry, this.proofFields(plan, row.noteId, row.undoProof));
      if (row.copyId !== null && row.undoCopy !== null) {
        entry.copyId = row.copyId;
        entry.copyOutcome = row.undoCopy;
      }
      if (entry.outcome === undefined && entry.copyOutcome === undefined) continue;
      notes.push(entry);
    }
    // B7: lo pendiente que ya no es visible no cuenta.
    const complete = rows.every(
      (row) => !touched(row) || row.undoOutcome !== null || row.undoCopy !== null || !visible.has(row.noteId)
    );
    return { result: { mode: 'undo', planId: plan.planId, complete, notes }, written };
  }

  /** Deshace una nota del plan en SU turno del escritor. Devuelve lo que escribió: la nota
   *  restaurada y la copia mandada a la papelera, las dos si hizo las dos (B4). */
  private async undoNoteInTurn(
    store: NoteWriteStore,
    plan: PlanRecord,
    row: PlanNoteRecord,
    privacy: PrivacyConfig
  ): Promise<string[]> {
    const planId = plan.planId;
    const plans = store.replacePlans;
    const bodies = plans.bodies(planId, row.position);
    if (!bodies) return [];
    const wrote: string[] = [];
    let outcome: UndoOutcome | null = null;
    let proof: NoteProof | null = null;
    if (bodies.base !== null) {
      // Vuelve a la base solo si el cuerpo sigue siendo el que dejó el lote (`reject`): uno
      // que cambió después no se toca. Con instantánea forzada antes.
      const restored = await replaceBodyInTurn(store, {
        id: row.noteId,
        body: bodies.base,
        baseBodySha256: row.resultSha256,
        onConflict: 'reject',
        privacy
      });
      if (restored.wrote) wrote.push(row.noteId);
      switch (restored.result.outcome) {
        case 'applied':
          outcome = 'restored';
          proof = await proofOf(store, row.noteId);
          break;
        case 'already':
          outcome = 'already';
          proof = await proofOf(store, row.noteId);
          break;
        case 'conflict_rejected':
          outcome = 'changed';
          break;
        case 'locked':
          outcome = 'locked';
          break;
        default:
          outcome = 'unavailable';
      }
    }
    let copy: UndoCopyOutcome | null = null;
    if (row.copyId !== null && !row.copyOwned) {
      // B5: una copia que este plan reutilizó pero no creó (de otro plan, o de los ficheros
      // de trabajo) no se toca.
      copy = 'changed';
    } else if (row.copyId !== null) {
      const trashed = await trashConflictCopiesInTurn(store, {
        originalId: row.noteId,
        bodySha256: row.resultSha256,
        copyId: row.copyId,
        privacy
      });
      if (trashed.wrote) wrote.push(row.copyId);
      copy = trashed.result.trashed > 0 ? 'trashed' : trashed.result.already > 0 ? 'already' : 'changed';
    }
    plans.recordUndo(planId, row.position, outcome, copy, proof);
    return wrote;
  }
}
