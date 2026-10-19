/**
 * `hebra_jd_new_id` en el escritor (D18, SPEC.md §3 y §5): un ID nuevo dentro de una
 * categoría que ya existe, con el motor JD de jdex-manager (`../jd.ts`) sobre el puerto de
 * `./jd-port.ts`. Escribe la nota del JDex y, por defecto, la carpeta del ID; nada más
 * (categorías, áreas, hijos «+» y mover quedan fuera del lote). Dos pasos, como
 * `hebra_replace_in_notes`:
 *
 * - `simulate`, en UN turno de la cola: `resolveSettings` (carpetas del JDex y de
 *   plantillas, detectadas o las que pide el agente), `loadLibraryState` y `planNewId`. No
 *   escribe ninguna nota ni carpeta. Además mira lo que Hebra rechazaría al aplicar, porque
 *   `writes[0]` es la nota y la carpeta va después: un nombre de carpeta que no vale
 *   (`invalid_title`), una ruta privada o un choque con algo oculto (`folder_unavailable`) y
 *   un cuerpo con una etiqueta privada (`not_found`, decisión 4 de D2). Guarda el plan
 *   (`./jd-plans.ts`) con la biblioteca y la huella de la configuración de privados.
 * - `apply`, con el `planId` y un `operationId` nuevo, en UN turno: el registro de
 *   `./operations.ts` (huella del `planId`); ya hecho, lo anotado con `replayed` si lo que
 *   nombra sigue visible. Si no, `applyPlan` del motor, que vuelve a leer, vuelve a comprobar
 *   las precondiciones (`plan_stale` sin escribir si algo cambió, también si la categoría
 *   tiene ahora algo oculto) y asegura cada escritura: un reintento tras un corte a mitad
 *   completa lo que falta sin duplicar. El registro se anota al terminar.
 * - `discard` (interno): borra el plan de una simulación que la puerta final del lector
 *   descartó (nadie vio su `planId`).
 *
 * Los códigos de error del motor salen como rechazos con el mismo código; su `message` no
 * sale nunca (podría nombrar una carpeta o un número). Tras escribir, `onWritten` (la ronda
 * de sync) solo si se creó algo, también si `applyPlan` se cortó después de crear.
 */
import { createHash, randomUUID } from 'node:crypto';
import { deriveNote, bodyWithFrontmatterTitle } from '../hebra';
import {
  applyPlan,
  loadLibraryState,
  planNewId,
  resolveSettings,
  type CreatedItem,
  type JdLibraryErrorCode,
  type LibraryPort,
  type NewIdPlan,
  type PlanWrite,
  type PlannedTemplate
} from '../jd';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import { StoreError, writeRejected, type JdRejectionCode } from './errors';
import { planCreateFolder, validFolderName } from './folders';
import { isJdexFolderCandidate, JdLibraryPort } from './jd-port';
import { JD_PLAN_APPLY_TTL_MS } from './jd-plans';
import { OPERATION_ID_MAX_LENGTH } from './operations';
import { privacyFingerprint } from './replace';
import {
  CREATE_BODY_MAX_LENGTH,
  hiddenOperationTarget,
  priorOperation,
  privacyInTurn,
  type LocalWrite,
  type NoteWriteStore,
  type NoteWriteTarget
} from './writes';

/** Tope de un `planId` (son UUID) y de los textos que llegan por el socket. */
export const JD_PLAN_ID_MAX_LENGTH = 200;
export const JD_TITLE_MAX_LENGTH = 1_000;

export type JdNewIdRequest =
  | {
      mode: 'simulate';
      /** Categoría existente, `"21"`. */
      category: string;
      title: string;
      /** Sistema de la categoría (`D01`); vacío o ausente, el de por defecto. */
      systemId?: string;
      /** También la carpeta del ID dentro de la de la categoría. Def. `true`. */
      createFolder?: boolean;
      /** Carpetas del JDex y de plantillas, si no son las que detecta el motor. */
      jdexFolderId?: string;
      templatesFolderId?: string;
      privacy: PrivacyConfig;
    }
  | { mode: 'apply'; planId: string; operationId: string; privacy: PrivacyConfig }
  | { mode: 'discard'; planId: string; privacy: PrivacyConfig };

/** Una carpeta resuelta, como se enseña: id y nombre. */
export interface JdFolderView {
  id: string;
  name: string;
}

/** La simulación: el plan sin lo interno (precondiciones, ajustes) y su `planId`. */
export interface JdSimulation {
  mode: 'simulate';
  planId: string;
  expiresAt: string;
  id: string;
  system: string;
  noteName: string;
  folderName: string | null;
  category: { number: string; label: string; folderId: string | null };
  resolved: { jdex: JdFolderView; templates: JdFolderView | null };
  template: PlannedTemplate;
  /** Lo que se va a escribir, en orden: la nota del JDex (con su cuerpo) y la carpeta. */
  writes: PlanWrite[];
}

/** Lo que dejó aplicar: lo creado y lo que ya estaba, con ids. */
export interface JdApplyReport {
  mode: 'apply';
  planId: string;
  id: string;
  noteName: string;
  folderName: string | null;
  created: CreatedItem[];
  existing: CreatedItem[];
  replayed?: true;
}

export type JdNewIdResult = JdSimulation | JdApplyReport | { mode: 'discard' };

/** Ganchos de los tests: envolver el puerto (para cortar un `apply` a mitad). */
export interface JdTestHooks {
  port?(port: LibraryPort): LibraryPort;
}

/** Cada código del motor (`JdLibraryErrorCode`) es un rechazo de hebra-mcp con el mismo nombre
 *  (`JdRejectionCode`): si el motor añade uno, esto deja de compilar hasta añadirlo allí. */
const JD_CODES_ARE_REJECTIONS: JdLibraryErrorCode extends JdRejectionCode ? true : never = true;
void JD_CODES_ARE_REJECTIONS;

/** Un rechazo del motor con su código, sin su `message`. */
export function jdRejected(code: JdLibraryErrorCode): StoreError {
  return writeRejected(code);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Huella de un `apply` en el registro compartido: la operación y el plan. */
function applyFingerprint(planId: string): string {
  return sha256Hex(JSON.stringify(['jdNewId', planId]));
}

/** El puerto sobre el almacén de este turno, con el filtro de quien pide rehecho en cada
 *  llamada (lo que crea un `ensure*` lo ve el siguiente). */
function turnPort(store: NoteWriteStore, privacy: PrivacyConfig, jdexFolderId?: string): JdLibraryPort {
  return new JdLibraryPort(
    {
      folders: () => store.foldersList(),
      notes: () => store.notesVisibilityIndex(),
      noteRead: (id) => store.noteRead(id),
      filter: () => privacyInTurn(store, privacy),
      noteTitles: (ids) => store.noteTitles(ids),
      files: () => {
        const index = store.filesIndex();
        return { index, filter: FileFilter.fromSnapshot(privacyInTurn(store, privacy), index, privacy) };
      }
    },
    {
      noteCreate: (folderId) => store.noteCreate(folderId),
      noteSave: (input) => store.noteSave(input),
      folderCreate: (parentId, name) => store.folderCreate(parentId, name)
    },
    jdexFolderId === undefined ? {} : { jdexFolderId }
  );
}

/** Un `NewIdPlan` leído de la tabla (no se fía de su forma): lo mínimo que usa `applyPlan`. */
function isPlan(value: unknown): value is NewIdPlan {
  if (typeof value !== 'object' || value === null) return false;
  const plan = value as Record<string, unknown>;
  const resolved = plan.resolved as Record<string, unknown> | undefined;
  return (
    typeof plan.id === 'string' &&
    typeof plan.noteName === 'string' &&
    Array.isArray(plan.writes) &&
    Array.isArray(plan.preconditions) &&
    Array.isArray(plan.outputs) &&
    typeof resolved === 'object' &&
    resolved !== null &&
    typeof (resolved.jdex as { id?: unknown } | undefined)?.id === 'string'
  );
}

/** Lo que se guarda por plan: el del motor y el sello de su plantilla (`null` sin ella). */
interface StoredJdPlan {
  plan: NewIdPlan;
  templateSeal: number | null;
}

function isStoredPlan(value: unknown): value is StoredJdPlan {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Record<string, unknown>;
  return isPlan(stored.plan) && (stored.templateSeal === null || typeof stored.templateSeal === 'number');
}

function isItem(value: unknown): value is CreatedItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (item.kind === 'folder' || item.kind === 'note') && typeof item.id === 'string' && typeof item.name === 'string';
}

/** Un `JdApplyReport` del registro (no se fía de su forma). */
export function isJdApplyReport(value: unknown): value is JdApplyReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return (
    report.mode === 'apply' &&
    typeof report.planId === 'string' &&
    typeof report.id === 'string' &&
    typeof report.noteName === 'string' &&
    (report.folderName === null || typeof report.folderName === 'string') &&
    Array.isArray(report.created) &&
    report.created.every(isItem) &&
    Array.isArray(report.existing) &&
    report.existing.every(isItem)
  );
}

/**
 * Lo que Hebra rechazaría al aplicar, mirado ya en la simulación con el filtro del turno:
 * cada carpeta con el validador y el plan de `./folders.ts`, y el cuerpo de la nota con las
 * etiquetas privadas (como `ensureNote`, con el título en el frontmatter).
 */
function checkWrites(store: NoteWriteStore, privacy: PrivacyConfig, plan: NewIdPlan): void {
  const filter = privacyInTurn(store, privacy);
  for (const write of plan.writes) {
    if (write.kind === 'ensure_folder') {
      if (validFolderName(write.name) === null) throw jdRejected('invalid_title');
      if (!('folderId' in write.parent)) continue; // dentro de una carpeta que aún no existe.
      const planned = planCreateFolder(filter, write.parent.folderId, write.name);
      if (planned.kind === 'reject') {
        throw planned.code === 'invalid_input' ? jdRejected('invalid_title') : writeRejected(planned.code);
      }
    } else {
      const body = bodyWithFrontmatterTitle(write.body, write.title) ?? write.body;
      // El tope de `hebra_create_note`: una plantilla enorme no se escribe.
      if (body.length > CREATE_BODY_MAX_LENGTH) throw writeRejected('invalid_input');
      if (filter.hidesAnyTag((deriveNote(body).tags ?? []).map(({ tag }) => tag))) throw writeRejected('not_found');
    }
  }
}

function folderView(folder: { id: string; name: string } | null): JdFolderView | null {
  return folder === null ? null : { id: folder.id, name: folder.name };
}

async function simulate(
  store: NoteWriteStore,
  request: Extract<JdNewIdRequest, { mode: 'simulate' }>,
  now: number
): Promise<JdSimulation> {
  const port = turnPort(store, request.privacy);
  // Una carpeta cualquiera como JDex haría de `hasHidden` un oráculo de sus notas ocultas: solo
  // una `00.00` visible (si no, como sin JDex).
  if (request.jdexFolderId !== undefined && !isJdexFolderCandidate(privacyInTurn(store, request.privacy), request.jdexFolderId)) {
    throw jdRejected('jdex_not_found');
  }
  const resolved = await resolveSettings(port, {
    ...(request.jdexFolderId !== undefined ? { jdexFolderId: request.jdexFolderId } : {}),
    ...(request.templatesFolderId !== undefined ? { templatesFolderId: request.templatesFolderId } : {})
  });
  if (!resolved.ok) throw jdRejected(resolved.code);
  port.useJdexFolder(resolved.value.jdex.id);
  const state = await loadLibraryState(port, resolved.value);
  const planned = await planNewId(
    port,
    state,
    {
      category: request.category,
      title: request.title,
      ...(request.systemId !== undefined ? { systemId: request.systemId } : {}),
      ...(request.createFolder !== undefined ? { createFolder: request.createFolder } : {})
    },
    new Date(now)
  );
  if (!planned.ok) throw jdRejected(planned.code);
  const plan = planned.value;
  checkWrites(store, request.privacy, plan);
  const planId = randomUUID();
  // La plantilla no es una precondición del motor: su sello (`local_seq`) se guarda con el plan
  // y aplicar exige que siga visible y sin cambios.
  const templateId = plan.template.noteId;
  const stored: StoredJdPlan = {
    plan,
    templateSeal: templateId === undefined ? null : (privacyInTurn(store, request.privacy).sealOf(templateId) ?? null)
  };
  store.jdPlans.insert({
    planId,
    libraryId: store.libraryId(),
    privacySha256: privacyFingerprint(request.privacy),
    createdAt: now,
    plan: stored
  });
  return {
    mode: 'simulate',
    planId,
    expiresAt: new Date(now + JD_PLAN_APPLY_TTL_MS).toISOString(),
    id: plan.id,
    system: plan.system,
    noteName: plan.noteName,
    folderName: plan.folderName,
    category: { ...plan.category },
    resolved: { jdex: folderView(plan.resolved.jdex)!, templates: folderView(plan.resolved.templates) },
    template: { ...plan.template },
    writes: plan.writes
  };
}

/**
 * Simular, aplicar o descartar (ver la cabecera). `onWritten` pide la ronda de después;
 * `hooks`, solo en los tests. `wrote` dice si se creó algo (para esperar la ronda) y
 * `written`, los ids creados.
 */
export async function runJdNewId(
  target: NoteWriteTarget,
  request: JdNewIdRequest,
  onWritten: () => void,
  hooks: JdTestHooks = {}
): Promise<LocalWrite<JdNewIdResult> & { written: string[] }> {
  if (request.mode === 'apply') {
    if (request.operationId.length === 0 || request.operationId.length > OPERATION_ID_MAX_LENGTH) {
      throw writeRejected('invalid_input');
    }
  }
  if (request.mode !== 'simulate' && (request.planId.length === 0 || request.planId.length > JD_PLAN_ID_MAX_LENGTH)) {
    throw writeRejected('invalid_input');
  }
  let created: Array<{ id: string }> = [];
  try {
    const result = await target.writeExclusive(async (store): Promise<LocalWrite<JdNewIdResult>> => {
      const now = Date.now();
      store.jdPlans.purgeExpired(now);
      switch (request.mode) {
        case 'discard':
          store.jdPlans.delete(request.planId);
          return { result: { mode: 'discard' }, wrote: false };
        case 'simulate':
          // Cerrado ante la duda: una configuración que no resuelve no simula nada.
          privacyInTurn(store, request.privacy);
          return { result: await simulate(store, request, now), wrote: false };
        case 'apply': {
          const filter = privacyInTurn(store, request.privacy);
          const fingerprint = applyFingerprint(request.planId);
          const log = store.operations;
          const previous = priorOperation(
            log,
            request.operationId,
            fingerprint,
            now,
            hiddenOperationTarget(store, filter, request.privacy)
          );
          if (previous?.state === 'done' && isJdApplyReport(previous.result)) {
            // Lo que nombra tiene que seguir viéndose: si no, como algo que no existe.
            for (const item of [...previous.result.created, ...previous.result.existing]) {
              const visible =
                item.kind === 'note'
                  ? filter.visibleMeta(item.id) !== undefined
                  : filter.folderExists(item.id) && !filter.isFolderHidden(item.id);
              if (!visible) throw writeRejected('not_found');
            }
            return { result: { ...previous.result, replayed: true }, wrote: false };
          }
          const record = store.jdPlans.get(request.planId);
          if (
            !record ||
            record.libraryId !== store.libraryId() ||
            record.privacySha256 !== privacyFingerprint(request.privacy) ||
            !isStoredPlan(record.plan)
          ) {
            throw writeRejected('plan_not_found');
          }
          if (now - record.createdAt > JD_PLAN_APPLY_TTL_MS) throw writeRejected('plan_expired');
          const { plan, templateSeal } = record.plan;
          // La plantilla de la simulación: visible y con el mismo `local_seq`; si no, el cuerpo
          // simulado ya no es el de la plantilla de ahora (o la delataría oculta).
          const templateId = plan.template.noteId;
          if (templateId !== undefined) {
            const seal = filter.visibleMeta(templateId) ? filter.sealOf(templateId) : undefined;
            if (seal === undefined || templateSeal === null || seal !== templateSeal) throw jdRejected('plan_stale');
          }
          const port = turnPort(store, request.privacy, plan.resolved.jdex.id);
          created = port.created;
          const outcome = await applyPlan(hooks.port ? hooks.port(port) : port, plan);
          if (!outcome.ok) throw jdRejected(outcome.code);
          const report: JdApplyReport = {
            mode: 'apply',
            planId: request.planId,
            id: plan.id,
            noteName: plan.noteName,
            folderName: plan.folderName,
            created: outcome.value.created,
            existing: outcome.value.existing
          };
          const note = [...report.created, ...report.existing].find((item) => item.kind === 'note');
          log.begin({
            operationId: request.operationId,
            fingerprint,
            noteId: note?.id ?? request.planId,
            targetBodySha256: '',
            now
          });
          log.finish(request.operationId, report);
          return { result: report, wrote: report.created.length > 0 };
        }
      }
    });
    return { ...result, written: created.map((item) => item.id) };
  } finally {
    // También si `applyPlan` se cortó después de crear la nota: lo creado tiene que subir.
    if (created.length > 0) {
      try {
        onWritten();
      } catch {
        // Ya está en disco; la ronda periódica lo subirá.
      }
    }
  }
}
