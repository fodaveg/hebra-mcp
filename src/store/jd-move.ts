/**
 * `hebra_jd_move` en el escritor (D19, decisión de David del 19 oct 2026, «deberia entrar el
 * move, no?»; SPEC.md §3 y §5): archivar una nota, un fichero suelto o una carpeta dentro de
 * la carpeta de un ID del JDex (o de una subcarpeta suya), con el motor de mover de
 * jdex-manager (`planMoveIntoId`, `applyMovePlan`, `planUndoMove`, `applyUndoMovePlan`) sobre
 * el puerto de `./jd-move-port.ts`. Es la ÚNICA vía del MCP para mover carpetas. Tres pasos,
 * como `hebra_replace_in_notes`:
 *
 * - `simulate`, en UN turno: resuelve el JDex (el indicado tiene que ser una `00.00` visible,
 *   como en D18), planifica con el motor y mira lo que Hebra rechazaría al aplicar
 *   (`JdMovePort.preflight`). No escribe nada en la biblioteca; guarda el plan (`MovePlan`,
 *   JSON plano) en `jd-plans.sqlite` y devuelve el `planId` y el plan legible.
 * - `apply`, con el `planId` y un `operationId` nuevo, en UN turno: el registro de
 *   `./operations.ts` (huella del modo y del plan; ya hecho, lo anotado con `replayed`) y
 *   `applyMovePlan`, que relee, comprueba las precondiciones (`plan_stale`) y da por hecho lo
 *   que un `apply` cortado ya movió. El plan queda aplicado: se guarda 7 días para deshacerlo.
 * - `undo`, con el `planId` aplicado y un `operationId` nuevo, en UN turno: `planUndoMove`
 *   (puro) y `applyUndoMovePlan`, que devuelve cada pieza a su sitio si sigue donde la dejó
 *   el `apply`; si no, la salta con su motivo. Las carpetas que creó el plan se quedan.
 * - `discard` (interno): el plan de una simulación que la puerta final del lector descartó.
 *
 * El plan nunca se acepta del agente. La pieza que se mueve se localiza con el filtro de quien
 * pide (su carpeta la pone el servidor, no el agente): una oculta es `source_not_found`, como
 * una que no existe. Los códigos del motor salen con su nombre y sin su `message`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  applyMovePlan,
  applyUndoMovePlan,
  loadLibraryState,
  planMoveIntoId,
  planUndoMove,
  resolveSettings,
  type CreatedItem,
  type LibraryMovePort,
  type MovePlan,
  type MoveSkipReason,
  type MoveSource,
  type PlannedMove
} from '../jd';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { writeRejected } from './errors';
import { JdMovePort } from './jd-move-port';
import { jdRejected, JD_PLAN_ID_MAX_LENGTH, type JdFolderView } from './jd-new-id';
import { isJdexFolderCandidate } from './jd-port';
import { JD_MOVE_UNDO_RETENTION_MS, JD_PLAN_APPLY_TTL_MS } from './jd-plans';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import { privacyFingerprint } from './replace';
import {
  hiddenOperationTarget,
  priorOperation,
  privacyInTurn,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Tope de los textos que llegan (un nombre, una subcarpeta, un ID). */
export const JD_MOVE_NAME_MAX_LENGTH = 1_000;

export type JdMoveKind = 'note' | 'file' | 'folder';

export type JdMoveRequest =
  | {
      mode: 'simulate';
      source: { kind: JdMoveKind; id: string };
      /** ID de destino, `"21.34"`. */
      toId: string;
      /** Un nivel por debajo de la carpeta del ID; se crea si falta. */
      subfolder?: string;
      /** Nombre nuevo (el título, en una nota). */
      as?: string;
      systemId?: string;
      jdexFolderId?: string;
      privacy: PrivacyConfig;
    }
  | { mode: 'apply' | 'undo'; planId: string; operationId: string; privacy: PrivacyConfig }
  | { mode: 'discard'; planId: string; privacy: PrivacyConfig };

/** Una carpeta del plan: la que ya existe (`folderId`) o la que se crea (`null`), con la ruta
 *  que tendrá (como `path` de `hebra_list_folders`). */
export interface JdMovePlace {
  folderId: string | null;
  folderPath: string;
}

export interface JdMoveSimulation {
  mode: 'simulate';
  planId: string;
  expiresAt: string;
  /** ID de destino y su sistema. */
  id: string;
  system: string;
  jdex: JdFolderView;
  destination: { folderName: string; subfolder: string | null };
  /** Qué se mueve, de dónde, a dónde y con qué nombre. */
  move: { kind: JdMoveKind; id: string; name: string; from: JdMovePlace; to: JdMovePlace & { name: string } };
  /** Las carpetas que se crean, en orden (la del ID y la subcarpeta, si faltan). */
  createFolders: Array<{ name: string; folderPath: string }>;
}

/** Una pieza en un informe: qué es y con qué nombre estaba y queda. */
export interface JdMoveItem {
  kind: JdMoveKind;
  id: string;
  fromName: string;
  toName: string;
}

export interface JdMoveApplyReport {
  mode: 'apply';
  planId: string;
  id: string;
  created: CreatedItem[];
  existing: CreatedItem[];
  moved: JdMoveItem[];
  /** Lo que un `apply` anterior (cortado) ya había movido. */
  alreadyDone: JdMoveItem[];
  replayed?: true;
}

export interface JdMoveUndoReport {
  mode: 'undo';
  planId: string;
  restored: JdMoveItem[];
  alreadyRestored: JdMoveItem[];
  skipped: Array<JdMoveItem & { reason: MoveSkipReason }>;
  replayed?: true;
}

export type JdMoveResult = JdMoveSimulation | JdMoveApplyReport | JdMoveUndoReport | { mode: 'discard' };

/** Ganchos de los tests: envolver el puerto (para cortar un `apply` a mitad). */
export interface JdMoveTestHooks {
  port?(port: JdMovePort): LibraryMovePort;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function itemOf(move: PlannedMove): JdMoveItem {
  return { kind: move.kind, id: move.id, fromName: move.from.name, toName: move.to.name };
}

/** Un `MovePlan` leído de la tabla (no se fía de su forma): lo que usan el motor y el informe. */
function isMovePlan(value: unknown): value is MovePlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Record<string, unknown>;
  const resolved = plan.resolved as Record<string, unknown> | undefined;
  return (
    plan.kind === 'move_into_id' &&
    typeof plan.id === 'string' &&
    Array.isArray(plan.preconditions) &&
    Array.isArray(plan.writes) &&
    Array.isArray(plan.moves) &&
    plan.moves.length > 0 &&
    typeof resolved === 'object' &&
    resolved !== null &&
    typeof (resolved.jdex as { id?: unknown } | undefined)?.id === 'string'
  );
}

function isItem(value: unknown): value is JdMoveItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === 'note' || item.kind === 'file' || item.kind === 'folder') &&
    typeof item.id === 'string' &&
    typeof item.fromName === 'string' &&
    typeof item.toName === 'string'
  );
}

function isCreated(value: unknown): value is CreatedItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === 'folder' || item.kind === 'note') && typeof item.id === 'string' && typeof item.name === 'string';
}

/** Un informe de `apply` o `undo` del registro (no se fía de su forma). */
export function isJdMoveReport(value: unknown): value is JdMoveApplyReport | JdMoveUndoReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  if (typeof report.planId !== 'string') return false;
  if (report.mode === 'apply') {
    return (
      typeof report.id === 'string' &&
      [report.created, report.existing].every((list) => Array.isArray(list) && list.every(isCreated)) &&
      [report.moved, report.alreadyDone].every((list) => Array.isArray(list) && list.every(isItem))
    );
  }
  if (report.mode === 'undo') {
    return (
      [report.restored, report.alreadyRestored, report.skipped].every((list) => Array.isArray(list) && list.every(isItem))
    );
  }
  return false;
}

/** ¿Se ve todavía la pieza? (para servir un informe del registro). */
function pieceVisible(store: NoteWriteStore, live: PrivacyFilter, privacy: PrivacyConfig, kind: JdMoveKind, id: string): boolean {
  if (kind === 'note') return live.visibleMeta(id) !== undefined;
  if (kind === 'folder') return live.folderExists(id) && !live.isFolderHidden(id);
  return FileFilter.fromSnapshot(live, store.filesIndex(), privacy).visibleMeta(id) !== undefined;
}

/** La pieza que pide el agente, con la carpeta donde está para quien pide (la pone el
 *  servidor). Oculta, inexistente o de la papelera: `source_not_found`, todo igual. */
function sourceOf(store: NoteWriteStore, live: PrivacyFilter, privacy: PrivacyConfig, source: { kind: JdMoveKind; id: string }): MoveSource {
  if (source.kind === 'folder') return { kind: 'folder', id: source.id };
  if (source.kind === 'note') {
    const meta = live.visibleMeta(source.id);
    if (!meta) throw jdRejected('source_not_found');
    return { kind: 'note', id: source.id, folderId: meta.folderId };
  }
  const file = FileFilter.fromSnapshot(live, store.filesIndex(), privacy).visibleMeta(source.id);
  if (!file || file.trashedAt !== null) throw jdRejected('source_not_found');
  return { kind: 'file', id: source.id, folderId: file.folderId };
}

/** La ruta para enseñar de una carpeta del plan: la de una que existe o la de una planeada
 *  (la de su padre más su nombre). */
function placeOf(live: PrivacyFilter, plan: MovePlan, parent: PlannedMove['to']['parentId']): JdMovePlace {
  if (typeof parent === 'string') return { folderId: parent, folderPath: live.folderPath(parent) };
  return { folderId: null, folderPath: plannedPath(live, plan, parent.write) };
}

function plannedPath(live: PrivacyFilter, plan: MovePlan, position: number): string {
  const write = plan.writes[position];
  if (!write || write.kind !== 'ensure_folder') return '';
  const parent = 'folderId' in write.parent ? live.folderPath(write.parent.folderId) : plannedPath(live, plan, write.parent.write);
  const segment = write.name.trim().toLowerCase();
  return parent ? `${parent}/${segment}` : segment;
}

async function simulate(
  store: NoteWriteStore,
  request: Extract<JdMoveRequest, { mode: 'simulate' }>,
  now: number
): Promise<JdMoveSimulation> {
  const live = privacyInTurn(store, request.privacy);
  // Como en D18: solo una `00.00` visible vale como JDex indicado.
  if (request.jdexFolderId !== undefined && !isJdexFolderCandidate(live, request.jdexFolderId)) {
    throw jdRejected('jdex_not_found');
  }
  const source = sourceOf(store, live, request.privacy, request.source);
  const port = new JdMovePort(store, request.privacy);
  const resolved = await resolveSettings(port, request.jdexFolderId === undefined ? {} : { jdexFolderId: request.jdexFolderId });
  if (!resolved.ok) throw jdRejected(resolved.code);
  port.useJdexFolder(resolved.value.jdex.id);
  const state = await loadLibraryState(port, resolved.value);
  const planned = await planMoveIntoId(port, state, {
    source,
    toId: request.toId,
    ...(request.subfolder !== undefined ? { subfolder: request.subfolder } : {}),
    ...(request.as !== undefined ? { as: request.as } : {}),
    ...(request.systemId !== undefined ? { systemId: request.systemId } : {})
  });
  if (!planned.ok) throw jdRejected(planned.code);
  const plan = planned.value;
  await port.preflight(plan);
  const planId = randomUUID();
  store.jdPlans.insert({
    planId,
    libraryId: store.libraryId(),
    privacySha256: privacyFingerprint(request.privacy),
    createdAt: now,
    kind: 'move',
    plan
  });
  const move = plan.moves[0]!;
  return {
    mode: 'simulate',
    planId,
    expiresAt: new Date(now + JD_PLAN_APPLY_TTL_MS).toISOString(),
    id: plan.id,
    system: plan.system,
    jdex: { id: plan.resolved.jdex.id, name: plan.resolved.jdex.name },
    destination: { ...plan.destination },
    move: {
      kind: move.kind,
      id: move.id,
      name: move.from.name,
      from: placeOf(live, plan, move.from.parentId),
      to: { ...placeOf(live, plan, move.to.parentId), name: move.to.name }
    },
    createFolders: plan.writes.flatMap((write, position) =>
      write.kind === 'ensure_folder' ? [{ name: write.name, folderPath: plannedPath(live, plan, position) }] : []
    )
  };
}

/**
 * Simular, aplicar, deshacer o descartar (ver la cabecera). `onWritten` pide la ronda de
 * después si se movió o se creó algo, también si el turno se cortó a mitad; `hooks`, solo en
 * los tests. `written`, los ids de lo que cambió (para el estado de sync).
 */
export async function runJdMove(
  target: NoteWriteTarget,
  request: JdMoveRequest,
  onWritten: () => void,
  hooks: JdMoveTestHooks = {}
): Promise<LocalWrite<JdMoveResult> & { written: Array<{ kind: JdMoveKind; id: string }> }> {
  if (request.mode === 'apply' || request.mode === 'undo') {
    if (request.operationId.length === 0 || request.operationId.length > OPERATION_ID_MAX_LENGTH) {
      throw writeRejected('invalid_input');
    }
  }
  if (request.mode !== 'simulate' && (request.planId.length === 0 || request.planId.length > JD_PLAN_ID_MAX_LENGTH)) {
    throw writeRejected('invalid_input');
  }
  let port: JdMovePort | null = null;
  const written: Array<{ kind: JdMoveKind; id: string }> = [];
  try {
    const result = await target.writeExclusive(async (store): Promise<LocalWrite<JdMoveResult>> => {
      const now = Date.now();
      store.jdPlans.purgeExpired(now);
      if (request.mode === 'discard') {
        store.jdPlans.delete(request.planId);
        return { result: { mode: 'discard' }, wrote: false };
      }
      if (request.mode === 'simulate') {
        privacyInTurn(store, request.privacy);
        return { result: await simulate(store, request, now), wrote: false };
      }
      const live = privacyInTurn(store, request.privacy);
      const fingerprint = sha256Hex(JSON.stringify(['jdMove', request.mode, request.planId]));
      const log = store.operations;
      const previous = priorOperation(
        log,
        request.operationId,
        fingerprint,
        now,
        hiddenOperationTarget(store, live, request.privacy)
      );
      if (previous?.state === 'done' && isJdMoveReport(previous.result) && previous.result.mode === request.mode) {
        // Lo que nombra tiene que seguir viéndose: si no, como algo que no existe.
        const report = previous.result;
        const pieces = report.mode === 'apply' ? [...report.moved, ...report.alreadyDone] : [...report.restored, ...report.alreadyRestored, ...report.skipped];
        const folders = report.mode === 'apply' ? [...report.created, ...report.existing] : [];
        for (const piece of pieces) {
          if (!pieceVisible(store, live, request.privacy, piece.kind, piece.id)) throw writeRejected('not_found');
        }
        for (const folder of folders) {
          if (!pieceVisible(store, live, request.privacy, 'folder', folder.id)) throw writeRejected('not_found');
        }
        return { result: { ...report, replayed: true }, wrote: false };
      }
      const record = store.jdPlans.get(request.planId);
      if (
        !record ||
        record.kind !== 'move' ||
        record.libraryId !== store.libraryId() ||
        record.privacySha256 !== privacyFingerprint(request.privacy) ||
        !isMovePlan(record.plan)
      ) {
        throw writeRejected('plan_not_found');
      }
      const plan = record.plan;
      const movePort = new JdMovePort(store, request.privacy, { jdexFolderId: plan.resolved.jdex.id });
      port = movePort;
      const enginePort = hooks.port ? hooks.port(movePort) : movePort;
      const piece = plan.moves[0]!;
      let report: JdMoveApplyReport | JdMoveUndoReport;
      if (request.mode === 'apply') {
        if (record.appliedAt === null && now - record.createdAt > JD_PLAN_APPLY_TTL_MS) throw writeRejected('plan_expired');
        const outcome = await applyMovePlan(enginePort, plan);
        if (!outcome.ok) throw jdRejected(outcome.code);
        store.jdPlans.markApplied(request.planId, now);
        report = {
          mode: 'apply',
          planId: request.planId,
          id: plan.id,
          created: outcome.value.created,
          existing: outcome.value.existing,
          moved: outcome.value.moved.map(itemOf),
          alreadyDone: outcome.value.alreadyDone.map(itemOf)
        };
        for (const item of outcome.value.created) written.push({ kind: 'folder', id: item.id });
        for (const item of outcome.value.moved) written.push({ kind: item.kind, id: item.id });
      } else {
        // Solo un plan aplicado, en los 7 días siguientes (la purga borra los más viejos).
        if (record.appliedAt === null || now - record.appliedAt > JD_MOVE_UNDO_RETENTION_MS) {
          throw writeRejected('plan_not_found');
        }
        const outcome = await applyUndoMovePlan(enginePort, planUndoMove(plan));
        if (!outcome.ok) throw jdRejected(outcome.code);
        report = {
          mode: 'undo',
          planId: request.planId,
          restored: outcome.value.restored.map(itemOf),
          alreadyRestored: outcome.value.alreadyRestored.map(itemOf),
          skipped: outcome.value.skipped.map(({ move, reason }) => ({ ...itemOf(move), reason }))
        };
        for (const item of outcome.value.restored) written.push({ kind: item.kind, id: item.id });
      }
      log.begin({ operationId: request.operationId, fingerprint, noteId: piece.id, targetBodySha256: '', now });
      log.finish(request.operationId, report);
      return { result: report, wrote: written.length > 0 };
    });
    return { ...result, written };
  } finally {
    // También si el turno se cortó después de crear o mover algo: tiene que subir.
    const touched = port !== null && ((port as JdMovePort).created.length > 0 || (port as JdMovePort).moves > 0);
    if (written.length > 0 || touched) {
      try {
        onWritten();
      } catch {
        // Ya está en disco; la ronda periódica lo subirá.
      }
    }
  }
}
