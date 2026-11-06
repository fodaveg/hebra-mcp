/**
 * Pieza A8 del plan de memoria (6 nov 2026): el escritor ya no lee la visibilidad de TODAS las
 * notas vivas en cada escritura (`privacyInTurn`), sino solo la de las que decide
 * (`privacyInTurnFor`, `looseFilesFilterInTurn`, `src/store/writes.ts`). Una nota que no se cargó es
 * desconocida y desconocida es OCULTA: olvidarse de una cambia la respuesta en silencio (falla
 * cerrando). Esto es lo que se comprueba:
 *
 * 1. Los filtros: `privacyInTurnFor` decide lo mismo que `privacyInTurn` nota a nota y para
 *    varias a la vez (públicas, privadas por carpeta y por etiqueta, bloqueadas, bajo una
 *    carpeta borrada pública y privada, de la papelera, desconocidas); `looseFilesFilterInTurn`, lo
 *    mismo que el `FileFilter` de antes. Y por qué hacen falta todas: sin la nota, oculta; sin
 *    las bloqueadas, `FileFilter` dejaría de ocultar lo que se incrusta por nombre.
 * 2. `hiddenOperationTarget` decide lo mismo que la versión de antes (copiada aquí tal cual)
 *    para notas, papelera, ficheros, carpetas, planes y lo desconocido.
 * 3. Cada escritura cambiada, de punta a punta, sobre DOS copias idénticas de la misma
 *    biblioteca: una con el puerto de producción y otra con un puerto que devuelve la
 *    biblioteca entera a `notesVisibilityIndexFor` (todos los filtros completos, como antes).
 *    Mismas respuestas (o mismo error), y el puerto de producción no lee nunca la visibilidad
 *    de todas las notas.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy';
import { FileFilter } from '../../src/privacy/file-filter';
import type { PrivacyFilter } from '../../src/privacy/filter';
import { TrashFilter } from '../../src/privacy/trash-filter';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import { replaceBody, trashConflictCopies } from '../../src/store/body-writes';
import { fetchFileBytes, replaceFileText } from '../../src/store/file-writes';
import { writeLooseFile } from '../../src/store/file-verbs';
import { writeNoteState } from '../../src/store/note-state';
import { ReplaceBatch, type ReplaceRequest } from '../../src/store/replace-batch';
import { privacyFingerprint } from '../../src/store/replace';
import { encodeRevision } from '../../src/store/revision';
import {
  looseFilesFilterInTurn,
  looseFilesNoteIds,
  hiddenOperationTarget,
  NoteWriter,
  privacyInTurn,
  privacyInTurnFor,
  type NoteWriteStore,
  type NoteWriteTarget
} from '../../src/store/writes';
import { buildTestLibrary, FILE_NAMES, legacyFolderTombstone, type TestLibrary } from '../fixtures/test-library';
import { createNote, lockedBody, withEngine } from '../privacy/audit-harness';
import { capture } from '../workdir/helpers';
import { checkoutCommand, type OpenLibrary } from '../../src/workdir/commands';
import { Workdir } from '../../src/workdir/layout';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const UNKNOWN = 'nota-que-no-existe-a8';
const CODE = 'CODIGO_A8';
/** Nombres que incrusta una nota visible y una oculta sin que exista el fichero. */
const VISIBLE_NAME = 'visible-a8.base';
const HIDDEN_NAME = 'fantasma-a8.base';
/** Unos bytes que enlaza por SHA-256 una nota visible, sin que ningún fichero los tenga. */
const LINKED_TEXT = 'texto A8 enlazado\n';
const LINKED_SHA = createHash('sha256').update(LINKED_TEXT, 'utf8').digest('hex');

interface Extra {
  lockedPublic: string;
  tombPublic: string;
  tombPrivate: string;
  planA: string;
  planB: string;
  planHidden: string;
  embedsActa: string;
}

/** La biblioteca de prueba de siempre, con lo que A8 necesita además. */
async function scenario(sqlitePath: string, library: TestLibrary): Promise<Extra> {
  return withEngine(sqlitePath, async (engine) => {
    const proyectos = (await engine.foldersList()).folders.find((folder) => folder.name === 'Proyectos')!.id;
    const diario = (await engine.foldersList()).folders.find((folder) => folder.name === 'Diario')!.id;
    // Se bloquea en el ÚLTIMO test (`lockLater`): bloqueada, con etiquetas privadas
    // configuradas, queda oculta (A1) y oculta todos los ficheros que se incrustan por nombre
    // (la variante de A1 de `FileFilter`), lo que dejaría sin visibles las pruebas de ficheros.
    const lockedPublic = await createNote(engine, null, '# Se bloqueará A8\n');
    const viejo = await engine.folderCreate(proyectos, 'Viejo A8');
    const tombPublic = await createNote(engine, viejo.id, `# Lápida pública A8\n${CODE}\n`);
    await legacyFolderTombstone(engine, viejo.id);
    const sub = await engine.folderCreate(diario, 'Sub A8');
    const tombPrivate = await createNote(engine, sub.id, `# Lápida privada A8\n${CODE}\n`);
    await legacyFolderTombstone(engine, sub.id);
    const planA = await createNote(engine, null, `# Plan A8 uno\n${CODE}\n`);
    const planB = await createNote(engine, proyectos, `# Plan A8 dos\n#proyectos\n${CODE}\n`);
    const planHidden = await createNote(engine, null, `# Plan A8 oculta\n#secreto\n${CODE}\n`);
    const embedsActa = await createNote(engine, null, `# Incrusta el acta A8\n![[${FILE_NAMES.acta}]]\n`);
    // Referencias que no son de ningún fichero todavía (no están en `FilesIndex.refs`): las
    // que `wouldHide` y el reemplazo de texto cargan aparte. Una visible y una oculta.
    // Y una visible que enlaza los bytes de un adjunto de otra nota: `fetchAttachment` la juzga.
    // Notas distintas: los bytes enlazados pasan a ser de un fichero en una prueba (y su nota,
    // a `FilesIndex.refs`), y el nombre tiene que seguir fuera.
    await createNote(engine, null, `# Incrusta uno que no existe A8\n![[${VISIBLE_NAME}]]\n`);
    await createNote(engine, null, `# Enlaza bytes A8\n![[sha256:${LINKED_SHA}|enlazado.txt]]\n![[sha256:${library.attachments.png}|copia.png]]\n`);
    await createNote(engine, null, `# Oculta que incrusta A8\n#secreto\n![[${HIDDEN_NAME}]]\n`);
    return {
      lockedPublic: lockedPublic.id,
      tombPublic: tombPublic.id,
      tombPrivate: tombPrivate.id,
      planA: planA.id,
      planB: planB.id,
      planHidden: planHidden.id,
      embedsActa: embedsActa.id
    };
  });
}

/** Cuántas veces se leyó la visibilidad de TODAS las notas (en un turno y fuera). */
interface Reads {
  full: number;
}

/** El puerto de producción, contando las lecturas de la visibilidad entera. */
function counted(port: NodeLibraryPort, reads: Reads): NodeLibraryPort {
  const wrapped = Object.create(port) as NodeLibraryPort;
  wrapped.notesVisibilityIndex = async () => {
    reads.full += 1;
    return port.notesVisibilityIndex();
  };
  wrapped.writeExclusive = (operation) =>
    port.writeExclusive((store) =>
      operation(
        new Proxy(store, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (property === 'notesVisibilityIndex') {
              return () => {
                reads.full += 1;
                return (value as () => unknown).call(target);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          }
        })
      )
    );
  return wrapped;
}

/** La referencia: todos los filtros con la biblioteca entera, como antes de A8.
 *  `notesVisibilityIndexFor` devuelve TODAS las filas, en el turno y fuera. */
function fullIndex(port: NodeLibraryPort): NodeLibraryPort {
  const wrapped = Object.create(port) as NodeLibraryPort;
  wrapped.notesVisibilityIndexFor = () => port.notesVisibilityIndex();
  wrapped.writeExclusive = (operation) =>
    port.writeExclusive((store) =>
      operation(
        new Proxy(store, {
          get(target, property) {
            if (property === 'notesVisibilityIndexFor') return () => target.notesVisibilityIndex();
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        })
      )
    );
  return wrapped;
}

/** El `hiddenOperationTarget` de antes de A8 (5223421), tal cual, para comparar. */
function hiddenOperationTargetBefore(
  store: NoteWriteStore,
  filter: PrivacyFilter,
  privacy: PrivacyConfig
): (id: string) => boolean {
  return (id) => {
    if (filter.visibleMeta(id)) return false;
    const trash = store.trashIndex();
    if (trash.notes.some((note) => note.id === id)) {
      return !TrashFilter.fromSnapshot(filter, trash, privacy).isVisible(id);
    }
    if (store.notesVisibilityIndex().some((note) => note.id === id)) return true;
    const files = store.filesIndex();
    if (files.files.some((file) => file.id === id)) {
      return !FileFilter.fromSnapshot(filter, files, privacy).isVisible(id);
    }
    if (filter.folderExists(id)) return filter.isFolderHidden(id);
    const plan = store.replacePlans.plan(id);
    if (plan) {
      const notes = store.replacePlans.notes(id);
      return plan.libraryId !== store.libraryId() || plan.privacySha256 !== privacyFingerprint(privacy) ||
        plan.state === 'expired' || notes.length === 0 || notes.some((note) => !filter.visibleMeta(note.noteId));
    }
    return true;
  };
}

/** Lo que se compara de una escritura: su resultado o el código de su error. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: strip(await run()) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { error: typeof code === 'string' ? code : String(error) };
  }
}

/** Los ids que ya estaban en las dos copias (notas, carpetas y ficheros): uno que no esté es
 *  de algo creado en la ejecución, distinto en cada copia (`strip`). */
const known = new Set<string>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Fuera lo que cambia entre dos ejecuciones idénticas: ids aleatorios de plan y de lo recién
 *  creado (también su prefijo en una ruta, `(1a2b3c4d)`), fechas y cursores. */
function strip(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(UUID, (id) => (known.has(id) ? id : 'NUEVO'))
      .replace(/\(([0-9a-f]{8})\)/g, (all, prefix: string) =>
        [...known].some((id) => id.startsWith(prefix)) ? all : '(nuevo)'
      );
  }
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'planId' || key === 'expiresAt' || key === 'nextCursor' || key === 'continueAfter') continue;
      out[key] = strip(inner);
    }
    return out;
  }
  return value;
}

describe('A8: el escritor juzga solo las notas que decide', () => {
  let dir: string;
  let library: TestLibrary;
  let extra: Extra;
  /** El de producción (contado) y la referencia, sobre dos copias idénticas. */
  let real: NodeLibraryPort;
  let reference: NodeLibraryPort;
  let realPort: NodeLibraryPort;
  let referencePort: NodeLibraryPort;
  const reads: Reads = { full: 0 };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-a8-'));
    const one = join(dir, 'uno');
    const two = join(dir, 'dos');
    library = await buildTestLibrary(join(one, 'library.sqlite'));
    extra = await scenario(join(one, 'library.sqlite'), library);
    cpSync(one, two, { recursive: true });
    const db = new DatabaseSync(join(two, 'library.sqlite'), { readOnly: true });
    for (const table of ['notes', 'folders', 'files']) {
      for (const row of db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>) known.add(String(row.id));
    }
    db.close();
    realPort = await openNodeLibraryPort({ sqlitePath: join(one, 'library.sqlite'), dataDir: one });
    referencePort = await openNodeLibraryPort({ sqlitePath: join(two, 'library.sqlite'), dataDir: two });
    real = counted(realPort, reads);
    reference = fullIndex(referencePort);
  });

  afterAll(() => {
    realPort?.close();
    referencePort?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const liveIds = (): string[] => [
    library.publicNoteId,
    library.publicNote2Id,
    library.privateFolderNoteId,
    library.privateTagNoteId,
    library.linkingNoteId,
    library.conflictCopyId,
    library.attachmentsNoteId,
    library.privateAttachmentNoteId,
    library.lockedPrivateNoteId,
    extra.lockedPublic,
    extra.tombPublic,
    extra.tombPrivate,
    extra.planA,
    extra.planB,
    extra.planHidden,
    extra.embedsActa
  ];
  const trashedIds = (): string[] => [
    library.trashedNoteId,
    library.trashedPublicFolderNoteId,
    library.trashedPrivateFolderNoteId,
    library.trashedPrivateTagNoteId,
    library.trashedDeletedPrivateFolderNoteId,
    library.trashedDeletedPublicFolderNoteId
  ];
  const noteTargets = (): string[] => [...liveIds(), ...trashedIds(), UNKNOWN];

  /** Cambia el cuerpo de una nota en las DOS copias, con el motor (lo que traería el sync). */
  const setBodyInBoth = async (id: string, change: (body: string) => string): Promise<void> => {
    for (const copy of ['uno', 'dos']) {
      await withEngine(join(dir, copy, 'library.sqlite'), async (engine) => {
        const row = (await engine.noteRead(id))!;
        const body = change(row.body);
        await engine.noteSave({ ...deriveNote(body), id, body, expectedLocalSeq: row.localSeq, baseBodySha256: row.bodySha256 });
      });
    }
  };

  /** Un turno del escritor de producción, sin contar (para los tests de los filtros). */
  const turn = <T>(run: (store: NoteWriteStore) => T): Promise<T> =>
    realPort.writeExclusive(async (store) => run(store));

  /** `privacyInTurnFor` contra `privacyInTurn`, nota a nota y todas juntas. Devuelve el entero. */
  const samePrivacyFilters = (store: NoteWriteStore): PrivacyFilter => {
    const full = privacyInTurn(store, CONFIG);
    const together = privacyInTurnFor(store, CONFIG, noteTargets());
    const decide = (filter: PrivacyFilter, id: string) => ({
      hidden: filter.isHiddenNote(id),
      meta: filter.visibleMeta(id) ?? null,
      seal: filter.sealOf(id) ?? null,
      locked: filter.isLockedNote(id),
      tags: filter.visibleTagsOf(id)
    });
    for (const id of noteTargets()) {
      const expected = decide(full, id);
      expect(decide(privacyInTurnFor(store, CONFIG, [id]), id), id).toEqual(expected);
      expect(decide(together, id), id).toEqual(expected);
    }
    return full;
  };

  /** `looseFilesFilterInTurn` contra el `FileFilter` sobre el filtro entero, fichero a fichero
   *  (también `wouldHide` con sus referencias). Devuelve el entero. */
  const sameFileFilters = (store: NoteWriteStore): FileFilter => {
    const index = store.filesIndex();
    const full = FileFilter.fromSnapshot(privacyInTurn(store, CONFIG), index, CONFIG);
    const { files } = looseFilesFilterInTurn(store, CONFIG, index);
    for (const file of index.files) {
      expect(files.isVisible(file.id), file.name).toBe(full.isVisible(file.id));
      expect(files.visibleMeta(file.id) ?? null, file.name).toEqual(full.visibleMeta(file.id) ?? null);
      expect(files.contentOf(file.id) ?? null, file.name).toEqual(full.contentOf(file.id) ?? null);
      expect(files.hidesContent(file.sha256.toLowerCase())).toBe(full.hidesContent(file.sha256.toLowerCase()));
      const refs = [...store.notesLinkingFileName(file.name), ...store.notesLinkingBlob(file.sha256.toLowerCase())];
      const judge = looseFilesFilterInTurn(store, CONFIG, index, refs.map((ref) => ref.noteId)).files;
      expect(judge.wouldHide(file.name, refs), file.name).toBe(full.wouldHide(file.name, refs));
    }
    expect(files.visibleFiles()).toEqual(full.visibleFiles());
    expect(files.wouldHide('nuevo.base', [])).toBe(full.wouldHide('nuevo.base', []));
    return full;
  };

  it('privacyInTurnFor decide lo mismo que privacyInTurn, nota a nota y todas juntas; sin la nota, oculta', async () => {
    await turn((store) => {
      const full = samePrivacyFilters(store);
      // Que el escenario prueba algo: hay visibles y ocultas de cada clase.
      expect(full.isHiddenNote(library.publicNoteId)).toBe(false);
      expect(full.isHiddenNote(extra.tombPublic)).toBe(false);
      for (const id of [library.privateFolderNoteId, library.privateTagNoteId, extra.tombPrivate, library.trashedNoteId, UNKNOWN]) {
        expect(full.isHiddenNote(id), id).toBe(true);
      }
      // Lo mismo de carpetas y configuración, con o sin notas.
      const none = privacyInTurnFor(store, CONFIG, []);
      for (const folderId of [...Object.values(library.folders), 'root']) {
        expect(none.isFolderHidden(folderId)).toBe(full.isFolderHidden(folderId));
        expect(none.folderPath(folderId)).toBe(full.folderPath(folderId));
      }
      // Negativa: una nota visible que no se pidió es desconocida, y desconocida es oculta.
      expect(none.isHiddenNote(library.publicNoteId)).toBe(true);
      expect(privacyInTurnFor(store, CONFIG, [library.publicNote2Id]).visibleMeta(library.publicNoteId)).toBeUndefined();
    });
  });

  it('looseFilesFilterInTurn decide lo mismo que el FileFilter entero', async () => {
    await turn((store) => {
      const full = sameFileFilters(store);
      // El escenario: hay ficheros visibles y ocultos por carpeta y por referencia (por nombre
      // y por los bytes). La variante de las bloqueadas, en el último test.
      expect(full.isVisible(library.files.acta)).toBe(true);
      for (const id of [library.files.privateFolder, library.files.referencedByName, library.files.referencedByHash]) {
        expect(full.isVisible(id), id).toBe(false);
      }
    });
  });

  it('hiddenOperationTarget decide lo mismo que antes, también con un filtro sin notas', async () => {
    const batch = new ReplaceBatch(realPort, realPort);
    const simulated = await batch.run({
      mode: 'simulate', pattern: CODE, regex: false, caseSensitive: true, replacement: 'CAMBIADO_A8',
      scope: { ids: [extra.planA, extra.planB] }, maxNotes: 10, limit: 10, privacy: CONFIG
    });
    const planId = String((simulated.result as { planId: string }).planId);
    const targets = [
      ...noteTargets(),
      ...Object.values(library.files),
      ...Object.values(library.folders),
      'root',
      planId,
      'plan-o-cosa-desconocida'
    ];
    const compare = (store: NoteWriteStore) => {
      const before = hiddenOperationTargetBefore(store, privacyInTurn(store, CONFIG), CONFIG);
      const now = hiddenOperationTarget(store, privacyInTurnFor(store, CONFIG, []), CONFIG);
      const decisions = targets.map((id) => [id, before(id)] as const);
      for (const [id, expected] of decisions) expect(now(id), id).toBe(expected);
      return new Map(decisions);
    };
    const first = await turn(compare);
    expect(first.get(library.publicNoteId)).toBe(false);
    expect(first.get(library.privateTagNoteId)).toBe(true);
    expect(first.get(planId)).toBe(false);
    // Una nota del plan pasa a privada: el plan entero cuenta como oculto, igual que antes. En
    // las dos copias, para que las escrituras de abajo partan de lo mismo.
    // Después se deshace, también en las dos.
    await setBodyInBoth(extra.planB, (body) => `${body}\n#secreto\n`);
    const second = await turn(compare);
    expect(second.get(planId)).toBe(true);
    await setBodyInBoth(extra.planB, (body) => body.replace('\n#secreto\n', ''));
    const third = await turn(compare);
    expect(third.get(planId)).toBe(false);
  });

  describe('cada escritura, contra la referencia con los filtros enteros', () => {
    /** Corre `run` en las dos copias (primero la referencia) y compara. */
    async function same(label: string, run: (target: NodeLibraryPort) => Promise<unknown>): Promise<unknown> {
      const expected = await outcome(() => run(reference));
      const before = reads.full;
      const got = await outcome(() => run(real));
      expect(got, label).toEqual(expected);
      expect(reads.full - before, `${label}: leyó la visibilidad de todas las notas`).toBe(0);
      if ('ok' in (got as object)) tally.ok += 1;
      else tally.error += 1;
      return got;
    }
    /** Respuestas buenas y errores vistos: cada test tiene que ver de los dos, para que la
     *  comparación distinga algo (todo `not_found` en las dos copias no prueba nada). */
    const tally = { ok: 0, error: 0 };
    let mark = { ...tally };
    const expectBoth = (label: string): void => {
      expect(tally.ok, `${label}: ninguna escritura salió bien`).toBeGreaterThan(mark.ok);
      expect(tally.error, `${label}: ninguna escritura se rechazó`).toBeGreaterThan(mark.error);
      mark = { ...tally };
    };
    const writer = (target: NoteWriteTarget) => new NoteWriter(target);
    const revisionOf = async (target: NodeLibraryPort, id: string): Promise<string> => {
      const row = await target.noteRead(id);
      return encodeRevision({
        libraryId: await target.libraryId(),
        noteId: id,
        localSeq: row?.localSeq ?? 1,
        bodySha256: row?.bodySha256 ?? '0'.repeat(64)
      });
    };
    let op = 0;
    const opId = () => `a8-op-${(op += 1)}`;

    it('crear nota y carpetas (sin notas que juzgar)', async () => {
      for (const folderId of [library.folders.proyectos, library.folders.diario2026, 'root', 'carpeta-inexistente']) {
        await same(`createNote ${folderId}`, (t) => writer(t).createNote({ body: '# Nueva A8\n', folderId, privacy: CONFIG }));
      }
      await same('createNote etiqueta privada', (t) => writer(t).createNote({ body: '# Nueva\n#secreto\n', privacy: CONFIG }));
      await same('createFolder', (t) => writer(t).createFolderLocal({ parentId: library.folders.proyectos, name: 'Nueva A8', privacy: CONFIG }));
      await same('createFolder privada', (t) => writer(t).createFolderLocal({ parentId: library.folders.diario, name: 'Otra', privacy: CONFIG }));
      await same('renameFolder', (t) => writer(t).renameFolderLocal({ id: library.folders.lumbre, name: 'Lumbre A8', privacy: CONFIG }));
      expectBoth('crear');
    });

    it('añadir, editar, restaurar una versión, adjuntar y traer un adjunto', async () => {
      for (const id of noteTargets()) {
        await same(`append ${id}`, (t) => writer(t).appendToNote({ id, text: 'añadido A8', privacy: CONFIG }));
        await same(`edit ${id}`, async (t) =>
          writer(t).editNote({
            id,
            edits: [{ find: 'añadido A8', replace: 'editado A8' }],
            expectedRevision: await revisionOf(t, id),
            operationId: opId(),
            privacy: CONFIG
          })
        );
        await same(`attach ${id}`, (t) =>
          writer(t).addAttachmentLocal({
            id,
            name: 'a8.txt',
            bytes: new TextEncoder().encode('adjunto A8'),
            mimeType: 'text/plain',
            operationId: opId(),
            privacy: CONFIG
          })
        );
      }
      for (const id of [library.versionedNoteId, library.privateFolderNoteId]) {
        await same(`restoreVersion ${id}`, async (t) =>
          writer(t).restoreVersion({
            id,
            versionId: library.versionedNoteVersionId,
            expectedRevision: await revisionOf(t, id),
            operationId: opId(),
            privacy: CONFIG
          })
        );
      }
      for (const sha of [...Object.values(library.attachments), library.privateAttachmentSha, library.lockedAttachmentSha]) {
        for (const noteId of [library.attachmentsNoteId, library.privateAttachmentNoteId, library.lockedPrivateNoteId]) {
          await same(`fetchAttachment ${noteId} ${sha}`, (t) => writer(t).fetchAttachment({ noteId, sha256: sha, privacy: CONFIG }, null));
        }
      }
      expectBoth('notas');
    });

    it('organizar notas y su estado, y organizar ficheros', async () => {
      for (const id of noteTargets()) {
        await same(`favorite ${id}`, (t) => writer(t).organize({ action: 'setFavorite', id, favorite: true, privacy: CONFIG }));
        await same(`move ${id}`, (t) => writer(t).organize({ action: 'moveNote', id, folderId: library.folders.lumbre, privacy: CONFIG }));
        await same(`setHidden ${id}`, (t) => writeNoteState(t, { action: 'setHidden', id, hidden: true, privacy: CONFIG }, () => {}));
      }
      for (const id of trashedIds()) {
        await same(`restoreNote ${id}`, (t) => writer(t).organize({ action: 'restoreNote', id, privacy: CONFIG }));
      }
      for (const id of Object.values(library.files)) {
        await same(`trashFile ${id}`, (t) => writer(t).organizeFileLocal({ action: 'trashFile', id, privacy: CONFIG }));
        await same(`restoreFile ${id}`, (t) => writer(t).organizeFileLocal({ action: 'restoreFile', id, privacy: CONFIG }));
      }
      expectBoth('organizar');
    });

    it('cuerpos enteros de los ficheros de trabajo y sus copias de conflicto', async () => {
      const outcomes = new Map<string, unknown>();
      for (const id of [...liveIds(), UNKNOWN]) {
        const got = await same(`replaceBody ${id}`, (t) =>
          replaceBody(
            t,
            { id, body: `# Cuerpo A8\n${id}\n`, baseBodySha256: 'f'.repeat(64), onConflict: 'copy', privacy: CONFIG },
            () => {}
          )
        );
        outcomes.set(id, (got as { ok?: { outcome: string } }).ok?.outcome);
      }
      // Escribe en las visibles (aquí, copia de conflicto: la base es otra) y no en las ocultas.
      expect(outcomes.get(library.publicNoteId)).toBe('conflict_copy');
      expect(outcomes.get(extra.tombPublic)).toBe('conflict_copy');
      for (const id of [library.privateTagNoteId, library.privateFolderNoteId, extra.tombPrivate, UNKNOWN]) {
        expect(outcomes.get(id), id).toBe('unavailable');
      }
      // Otra vez el mismo cuerpo sobre la base vieja: reutiliza la copia de conflicto que dejó
      // la primera (`findCopy`), si la ve.
      const again = await same('replaceBody reutiliza la copia', (t) =>
        replaceBody(
          t,
          { id: library.publicNoteId, body: `# Cuerpo A8\n${library.publicNoteId}\n`, baseBodySha256: 'f'.repeat(64), onConflict: 'copy', privacy: CONFIG },
          () => {}
        )
      );
      expect((again as { ok: { reused: boolean } }).ok.reused).toBe(true);
      const trashed = await same('trashConflictCopies', async (t) => {
        const copy = await t.noteRead(library.conflictCopyId);
        return trashConflictCopies(
          t,
          { originalId: library.publicNoteId, bodySha256: copy?.bodySha256 ?? '', privacy: CONFIG },
          () => {}
        );
      });
      expect((trashed as { ok: { trashed: number } }).ok.trashed).toBe(1);
      mark = { ...tally };
    });

    it('replace_in_notes: simular, previsualizar, aplicar y deshacer un plan de varias notas', async () => {
      const ids = [extra.planA, extra.planB, extra.planHidden, extra.tombPublic, extra.tombPrivate, library.privateFolderNoteId, UNKNOWN];
      const plans = new Map<NodeLibraryPort, string>();
      const run = (request: ReplaceRequest) => (t: NodeLibraryPort) => new ReplaceBatch(t, t).run(request);
      const simulated = await same('simulate', async (t) => {
        const out = await run({
          mode: 'simulate', pattern: CODE, regex: false, caseSensitive: true, replacement: 'HECHO_A8',
          scope: { ids }, maxNotes: 20, limit: 20, privacy: CONFIG
        })(t);
        plans.set(t, String((out.result as { planId: string }).planId));
        return out;
      });
      // El plan lleva las visibles (también la de la carpeta borrada pública) y ninguna oculta.
      expect((simulated as { ok: { result: { gateNotes: string[] } } }).ok.result.gateNotes.sort()).toEqual(
        [extra.planA, extra.planB, extra.tombPublic].sort()
      );
      const planOf = (t: NodeLibraryPort) => plans.get(t)!;
      const previewed = await same('preview', (t) => run({ mode: 'preview', planId: planOf(t), cursor: `rp1.${Buffer.from(JSON.stringify([planOf(t), 0])).toString('base64url')}`, limit: 1, privacy: CONFIG })(t));
      // Una nota del plan cambia por debajo (en las dos copias): aplicar deja una copia de
      // conflicto, y el informe la nombra si se ve (`reportedIds` lleva las copias).
      await setBodyInBoth(extra.planB, (body) => `${body}\notro cambio A8\n`);
      const applied = await same('apply', (t) => run({ mode: 'apply', planId: planOf(t), operationId: 'a8-apply', privacy: CONFIG })(t));
      await same('apply otra vez', (t) => run({ mode: 'apply', planId: planOf(t), operationId: 'a8-apply', privacy: CONFIG })(t));
      const undone = await same('undo', (t) => run({ mode: 'undo', planId: planOf(t), privacy: CONFIG })(t));
      // Los informes nombran las notas del plan que se ven (`visibleNow`).
      const notesOf = (got: unknown): string[] =>
        (got as { ok: { result: { notes: Array<{ id: string }> } } }).ok.result.notes.map((note) => note.id).sort();
      expect(notesOf(previewed)).toHaveLength(1);
      expect(notesOf(applied)).toEqual([extra.planA, extra.planB, extra.tombPublic].sort());
      expect(notesOf(undone)).toEqual([extra.planA, extra.planB, extra.tombPublic].sort());
      const copyOf = (got: unknown): unknown =>
        (got as { ok: { result: { notes: Array<{ id: string; copyId?: string }> } } }).ok.result.notes.find(
          (note) => note.id === extra.planB
        )?.copyId;
      expect(copyOf(applied)).toBe('NUEVO');
      expect(copyOf(undone)).toBe('NUEVO');
      await same('apply de un plan inexistente', (t) => run({ mode: 'apply', planId: 'plan-inexistente', operationId: 'a8-apply-2', privacy: CONFIG })(t));
      expectBoth('replace_in_notes');
      // Sin `ids`, el ámbito es la biblioteca: sigue cargándola entera (no es de A8), pero
      // decide lo mismo.
      const expected = await outcome(() => run({
        mode: 'simulate', pattern: 'HECHO_A8|' + CODE, regex: true, caseSensitive: true, replacement: 'X',
        scope: {}, maxNotes: 20, limit: 20, privacy: CONFIG
      })(reference));
      const got = await outcome(() => run({
        mode: 'simulate', pattern: 'HECHO_A8|' + CODE, regex: true, caseSensitive: true, replacement: 'X',
        scope: {}, maxNotes: 20, limit: 20, privacy: CONFIG
      })(real));
      expect(got).toEqual(expected);
    });

    it('checkout de los ficheros de trabajo: lo que sale y lo que se retira, igual', async () => {
      const open = (port: NodeLibraryPort): OpenLibrary => async () => ({
        role: 'this', linked: true, port, privacyConfig: CONFIG,
        replaceBody: (input) => replaceBody(port, { ...input, privacy: CONFIG }, () => {}),
        trashConflictCopies: (input) => trashConflictCopies(port, { ...input, privacy: CONFIG }, () => {}),
        syncRound: async () => ({ kind: 'done', result: 'ok' }),
        close: async () => {}
      });
      const cwd = { real: join(dir, 'wd-real'), reference: join(dir, 'wd-ref') };
      let titulos: string[] = [];
      const checkout = async (port: NodeLibraryPort, where: string) => {
        mkdirSync(where, { recursive: true });
        await checkoutCommand(capture(where).io, open(port), {
          dir: 'trabajo', all: titulos.length === 0, consultas: [], titulos, carpetas: [], forzar: false
        });
        const workdir = new Workdir(join(where, 'trabajo'));
        // Las notas creadas por las pruebas de arriba tienen otro id en cada copia (`strip`).
        return (
          workdir
            .readCheckout()
            .notas.map((entry) => strip({ ...entry, body: readFileSync(workdir.notePath(entry.ruta), 'utf8') })) as Array<{
            id: string;
            ruta: string;
          }>
        ).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      };
      const expectSame = async (label: string) => {
        const expected = await checkout(reference, cwd.reference);
        const before = reads.full;
        const got = await checkout(real, cwd.real);
        expect(got, label).toEqual(expected);
        expect(reads.full - before, `${label}: leyó la visibilidad de todas las notas`).toBe(0);
        return got;
      };
      const first = await expectSame('primer checkout');
      expect(first.some((entry) => entry.id === library.publicNoteId)).toBe(true);
      expect(first.some((entry) => entry.id === library.privateTagNoteId)).toBe(false);
      // Una nota sacada pasa a privada en las dos copias: se retira (las sacadas antes que ya
      // no se piden también se juzgan, `previous`).
      await setBodyInBoth(library.publicNote2Id, (body) => `${body}\n#secreto\n`);
      const second = await expectSame('segundo checkout');
      expect(second.some((entry) => entry.id === library.publicNote2Id)).toBe(false);
      await setBodyInBoth(library.publicNote2Id, (body) => body.replace('\n#secreto\n', ''));
      // Ahora solo una nota por título: las sacadas antes que no se piden (`previous`) siguen
      // en la carpeta si se ven, y se juzgan aunque no se hayan pedido.
      titulos = [library.publicNoteTitle];
      const third = await expectSame('tercer checkout, por título');
      expect(third.some((entry) => entry.id === library.linkingNoteId)).toBe(true);
    });

    it('ficheros sueltos: traer, reemplazar el texto, crear, duplicar, renombrar y mover', async () => {
      const fileIds = Object.values(library.files);
      for (const id of fileIds) {
        await same(`fetchFileBytes ${id}`, (t) => fetchFileBytes(t, { id, privacy: CONFIG }, null));
        await same(`replaceFileText ${id}`, async (t) => {
          const row = (await t.filesIndex()).files.find((file) => file.id === id);
          return replaceFileText(
            t,
            { id, expectedSha256: row?.sha256.toLowerCase() ?? '0'.repeat(64), text: 'texto A8\n', operationId: opId(), privacy: CONFIG },
            null,
            () => {}
          );
        });
      }
      // Unos bytes que enlaza una nota visible (fuera de `FilesIndex.refs`): se pueden escribir.
      await same('replaceFileText a bytes enlazados', async (t) => {
        const row = (await t.filesIndex()).files.find((file) => file.id === library.files.inventario)!;
        return replaceFileText(
          t,
          { id: row.id, expectedSha256: row.sha256.toLowerCase(), text: LINKED_TEXT, operationId: opId(), privacy: CONFIG },
          null,
          () => {}
        );
      });
      // Crear: un nombre libre, uno que incrusta una nota visible y uno que incrusta una oculta
      // (`file_name_unavailable`), estos dos sin fichero aún (fuera de `FilesIndex.refs`).
      const created = new Map<string, unknown>();
      for (const name of ['libre-a8.txt', VISIBLE_NAME, HIDDEN_NAME]) {
        created.set(
          name,
          await same(`createFile ${name}`, (t) =>
            writeLooseFile(t, { action: 'createFile', folderId: 'root', name, text: 'hola A8', operationId: opId(), privacy: CONFIG }, null, () => {})
          )
        );
      }
      expect(created.get(VISIBLE_NAME)).toHaveProperty('ok');
      expect(created.get(HIDDEN_NAME)).toEqual({ error: 'file_name_unavailable' });
      for (const id of fileIds) {
        await same(`duplicate ${id}`, (t) =>
          writeLooseFile(t, { action: 'duplicateFile', id, folderId: 'root', name: `copia-a8${id.slice(0, 4)}.pdf`, operationId: opId(), privacy: CONFIG }, null, () => {})
        );
        await same(`move ${id}`, (t) =>
          writeLooseFile(t, { action: 'moveFile', id, folderId: library.folders.proyectos, operationId: opId(), privacy: CONFIG }, null, () => {})
        );
      }
      // Renombrar el acta, que incrusta una nota visible (reenlazar): las notas que se
      // reenlazan se juzgan con `liveFor`.
      await same('rename acta', (t) =>
        writeLooseFile(t, { action: 'renameFile', id: library.files.acta, name: 'Acta A8.pdf', operationId: opId(), privacy: CONFIG }, null, () => {})
      );
      expectBoth('ficheros sueltos');
    });

    // El último: deja una nota bloqueada en las dos copias.
    it('con una nota bloqueada oculta (variante de A1): mismos filtros y mismas escrituras; sin las bloqueadas, no', async () => {
      await setBodyInBoth(extra.lockedPublic, () => lockedBody('Bloqueada A8', []));
      await turn((store) => {
        const full = samePrivacyFilters(store);
        expect(full.isHiddenNote(extra.lockedPublic)).toBe(true);
        expect(full.isLockedNote(extra.lockedPublic)).toBe(true);
        const files = sameFileFilters(store);
        expect(files.wouldHide('nuevo.base', [])).toBe(true);
        // Negativa: sin las bloqueadas, `hasHiddenLockedNote` no ve la bloqueada oculta y lo
        // que se incrusta por nombre dejaría de ocultarse.
        const index = store.filesIndex();
        const refsOnly = privacyInTurnFor(store, CONFIG, index.refs.map((ref) => ref.noteId));
        expect(refsOnly.hasHiddenLockedNote()).toBe(false);
        expect(FileFilter.fromSnapshot(refsOnly, index, CONFIG).wouldHide('nuevo.base', [])).toBe(false);
        expect(looseFilesNoteIds(store, index)).toContain(extra.lockedPublic);
      });
      for (const name of ['otro-a8.base', 'otro-a8.txt']) {
        await same(`createFile con bloqueada ${name}`, (t) =>
          writeLooseFile(t, { action: 'createFile', folderId: 'root', name, text: 'hola A8', operationId: opId(), privacy: CONFIG }, null, () => {})
        );
      }
      for (const id of Object.values(library.files)) {
        await same(`trashFile con bloqueada ${id}`, (t) => writer(t).organizeFileLocal({ action: 'trashFile', id, privacy: CONFIG }));
      }
      await same('append a la bloqueada', (t) => writer(t).appendToNote({ id: extra.lockedPublic, text: 'x', privacy: CONFIG }));
    });
  });
});
