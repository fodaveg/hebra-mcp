/**
 * Pieza A2 del plan de memoria (6 nov 2026): la puerta final (`passGate`,
 * `src/server/privacy-gate.ts`) ya no lee el índice de visibilidad de TODAS las notas vivas en
 * cada llamada (`privacyRecheck`, `src/store/node-port.ts`), sino solo el de las que juzga: las
 * declaradas (`GateUsage`) y las que el puerto saca de la misma transacción (las notas de un
 * plan, las que enlazan ficheros y adjuntos y, con ficheros, todas las bloqueadas).
 *
 * Dos cosas se comprueban:
 * 1. Las MISMAS decisiones que con el índice entero, cosa por cosa y todo junto: notas
 *    públicas, privadas por carpeta y por etiqueta, bloqueadas, bajo una carpeta borrada (uno
 *    y dos escalones, pública y privada), con la carpeta pendiente, purgadas, desconocidas y de
 *    la papelera; con y sin sello; en cualquier estado; registros de operación (nota, fichero,
 *    carpeta y un plan de varias notas); ficheros sueltos, adjuntos, carpetas y etiquetas. Y
 *    otra vez después de un cambio que hace que una nota bloqueada oculte los ficheros que se
 *    incrustan por nombre (variante de A1) y que una nota del plan pase a privada. La
 *    referencia es la puerta de antes: el mismo `privacyRecheck` con el índice entero.
 * 2. Que una petición de una nota sobre 2 000 lee del orden de una fila, no 2 000, y que la
 *    sentencia del índice parcial se reutiliza (la caché del puerto no crece).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateUsage, passGate, type GateVerdict } from '../../src/server/privacy-gate';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store';
import type { PrivacyRecheckSnapshot } from '../../src/store/types';
import { createSyntheticLibrary } from '../fixtures/synthetic-notes';
import { FILE_NAMES, legacyFolderTombstone } from '../fixtures/test-library';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody } from './audit-harness';

const UNKNOWN = 'nota-que-no-existe-a2';
const PLAN_TEXT = 'CODIGO_PLAN_A2';

/** La puerta de antes: el mismo `privacyRecheck`, con el índice de visibilidad entero. */
function fullIndexPort(port: NodeLibraryPort): NodeLibraryPort {
  const old = Object.create(port) as NodeLibraryPort;
  old.privacyRecheck = async (request) => ({
    ...(await port.privacyRecheck(request)),
    notes: await port.notesVisibilityIndex()
  });
  return old;
}

function plain(verdict: GateVerdict): Record<string, unknown> {
  return {
    passed: verdict.passed,
    declaredPassed: verdict.declaredPassed,
    failedNotes: [...verdict.failedNotes].sort(),
    failedFiles: [...verdict.failedFiles].sort(),
    failedFolders: [...verdict.failedFolders].sort(),
    failedBlobs: [...verdict.failedBlobs].sort(),
    failedTags: [...verdict.failedTags].sort()
  };
}

type Declare = (usage: GateUsage) => void;

describe('la puerta final con el índice de visibilidad parcial', () => {
  it('decide lo mismo que con el índice entero, cosa por cosa y todo junto, antes y después de un cambio', async () => {
    const h = await auditHarness(async (engine, library) => {
      const sub = await engine.folderCreate(library.folders.diario, 'Sub');
      const tombPrivate = await createNote(engine, sub.id, '# Lápida privada\ntexto\n');
      await legacyFolderTombstone(engine, sub.id);
      const antiguo = await engine.folderCreate(library.folders.proyectos, 'Viejo');
      const tombPublic = await createNote(engine, antiguo.id, '# Lápida pública\n#proyectos\ntexto\n');
      await legacyFolderTombstone(engine, antiguo.id);
      const secreto = await engine.folderCreate(library.folders.diario, 'Secreto');
      const deeper = await engine.folderCreate(secreto.id, 'Más');
      const tombDeep = await createNote(engine, deeper.id, '# Dos lápidas\ntexto\n');
      await legacyFolderTombstone(engine, deeper.id);
      await legacyFolderTombstone(engine, secreto.id);
      const pending = await createNote(engine, null, '# Carpeta pendiente\ntexto\n');
      const purged = await createNote(engine, null, '# Purgada\ntexto\n');
      await engine.noteTrash(purged.id);
      await engine.notePurge(purged.id);
      const planA = await createNote(engine, null, `# Plan uno\n${PLAN_TEXT}\n`);
      const planB = await createNote(engine, library.folders.proyectos, `# Plan dos\n#proyectos\n${PLAN_TEXT}\n`);
      const toLock = await createNote(engine, null, '# Se bloqueará\ntexto\n');
      // Una nota VISIBLE que incrusta por nombre un fichero visible: la puerta tiene que leer
      // su fila (regla b de `FileFilter`); sin ella, el fichero pasaría a oculto.
      await createNote(engine, null, `# Enlaza el acta\n![[${FILE_NAMES.acta}]]\n`);
      return {
        tombPrivate: tombPrivate.id,
        tombPublic: tombPublic.id,
        tombDeep: tombDeep.id,
        pending: pending.id,
        purged: purged.id,
        planA: planA.id,
        planB: planB.id,
        toLock: toLock.id
      };
    });
    try {
      const { library, extra } = h;
      await h.mutate(async (_engine, _library, db) => {
        db.prepare('UPDATE notes SET folder_id = ? WHERE id = ?').run('carpeta-que-no-ha-llegado', extra.pending);
      });
      const simulated = await h.call('hebra_replace_in_notes', {
        mode: 'simulate',
        pattern: PLAN_TEXT,
        replacement: 'CAMBIADO',
        ids: [extra.planA, extra.planB]
      });
      expect(simulated.isError).toBe(false);
      const planId = String(simulated.json.planId);

      const liveIds = [
        library.publicNoteId,
        library.publicNote2Id,
        library.privateFolderNoteId,
        library.privateTagNoteId,
        library.linkingNoteId,
        library.lockedPrivateNoteId,
        library.conflictCopyId,
        library.attachmentsNoteId,
        library.privateAttachmentNoteId,
        extra.tombPrivate,
        extra.tombPublic,
        extra.tombDeep,
        extra.pending,
        extra.planA,
        extra.planB,
        extra.toLock
      ];
      const otherIds = [extra.purged, UNKNOWN, library.trashedNoteId, library.trashedPrivateTagNoteId];
      const trashedIds = [
        library.trashedNoteId,
        library.trashedPublicFolderNoteId,
        library.trashedPrivateFolderNoteId,
        library.trashedPrivateTagNoteId,
        library.trashedDeletedPrivateFolderNoteId,
        library.trashedDeletedPublicFolderNoteId
      ];
      const fileIds = Object.values(library.files);
      const folderIds = [...Object.values(library.folders), 'root'];
      const blobs = [...Object.values(library.attachments), library.privateAttachmentSha, library.lockedAttachmentSha];

      const items = async (): Promise<Map<string, Declare>> => {
        const seqOf = async (id: string): Promise<number | undefined> => (await h.port.noteRead(id))?.localSeq;
        const out = new Map<string, Declare>();
        for (const id of [...liveIds, ...otherIds]) {
          const seq = await seqOf(id);
          out.set(`note ${id}`, (u) => u.note(id));
          if (seq !== undefined) {
            out.set(`note+seal ${id}`, (u) => u.note(id, seq));
            out.set(`note+wrong-seal ${id}`, (u) => u.note(id, seq + 1000));
          }
          out.set(`noteVisible ${id}`, (u) => u.noteVisible(id));
          out.set(`anyState ${id}`, (u) => u.noteInAnyState(id));
          out.set(`operation ${id}`, (u) => u.operationTarget(id));
        }
        for (const id of [...trashedIds, library.publicNoteId]) {
          const seq = await seqOf(id);
          out.set(`trashed ${id}`, (u) => u.trashedNote(id));
          if (seq !== undefined) out.set(`trashed+seal ${id}`, (u) => u.trashedNote(id, seq));
          out.set(`anyState ${id}`, (u) => u.noteInAnyState(id));
        }
        for (const id of fileIds) {
          out.set(`file ${id}`, (u) => u.file(id));
          out.set(`operation file ${id}`, (u) => u.operationTarget(id));
        }
        for (const id of folderIds) {
          out.set(`folder ${id}`, (u) => u.folder(id));
          out.set(`operation folder ${id}`, (u) => u.operationTarget(id));
        }
        for (const sha of blobs) out.set(`blob ${sha}`, (u) => u.blob(sha));
        for (const tag of ['secreto', 'secreto/personal', 'proyectos']) out.set(`tag ${tag}`, (u) => u.tag(tag));
        out.set(`plan ${planId}`, (u) => u.operationTarget(planId));
        out.set('visibleNotes', (u) => u.visibleNotes(liveIds));
        return out;
      };

      const compare = async (): Promise<Map<string, Record<string, unknown>>> => {
        const all = await items();
        const old = fullIndexPort(h.port);
        const reference = new Map<string, Record<string, unknown>>();
        const seen = new Map<string, Record<string, unknown>>();
        for (const seals of [true, false]) {
          for (const [label, declare] of [...all, ['todo junto', (u: GateUsage) => all.forEach((d) => d(u))] as const]) {
            const run = async (port: NodeLibraryPort) => {
              const usage = new GateUsage();
              declare(usage);
              return plain(await passGate(port, AUDIT_CONFIG, usage, { seals }));
            };
            const key = `${seals ? 'lectura' : 'escritura'} · ${label}`;
            reference.set(key, await run(old));
            seen.set(key, await run(h.port));
          }
        }
        expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(reference));
        return reference;
      };

      // Antes del cambio: el escenario decide lo que dice (si no, la equivalencia no probaría nada).
      const before = await compare();
      const passed = (key: string): unknown => before.get(`lectura · ${key}`)?.passed;
      expect({
        public: passed(`note+seal ${library.publicNoteId}`),
        wrongSeal: passed(`note+wrong-seal ${library.publicNoteId}`),
        privateFolder: passed(`note ${library.privateFolderNoteId}`),
        privateTag: passed(`note ${library.privateTagNoteId}`),
        tombPublic: passed(`note ${extra.tombPublic}`),
        tombPrivate: passed(`note ${extra.tombPrivate}`),
        tombDeep: passed(`note ${extra.tombDeep}`),
        pending: passed(`note ${extra.pending}`),
        purged: passed(`note ${extra.purged}`),
        unknown: passed(`note ${UNKNOWN}`),
        trashedAsLive: passed(`note ${library.trashedNoteId}`),
        trashed: passed(`trashed ${library.trashedNoteId}`),
        plan: passed(`plan ${planId}`),
        acta: passed(`file ${library.files.acta}`),
        referencedByName: passed(`file ${library.files.referencedByName}`)
      }).toEqual({
        public: true,
        wrongSeal: false,
        privateFolder: false,
        privateTag: false,
        tombPublic: true,
        tombPrivate: false,
        tombDeep: false,
        pending: false,
        purged: false,
        unknown: false,
        trashedAsLive: false,
        trashed: true,
        plan: true,
        acta: true,
        referencedByName: false
      });

      // El cambio: una nota pública BLOQUEADA (con etiquetas privadas configuradas, oculta: A1)
      // oculta los ficheros que se incrustan por nombre, y una nota del plan pasa a privada.
      await h.mutate(async (engine) => {
        await saveBody(engine, extra.toLock, lockedBody('Se bloqueó', []));
        await saveBody(engine, extra.planB, `# Plan dos\n#secreto\n${PLAN_TEXT}\n`);
      });
      expect((await h.port.notesVisibilityIndexFor([extra.toLock]))[0]?.locked).toBe(true);
      const after = await compare();
      expect([
        after.get(`lectura · file ${library.files.acta}`)?.passed,
        after.get(`lectura · plan ${planId}`)?.passed
      ]).toEqual([false, false]);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe('lo que lee la puerta final', () => {
  it('una nota sobre 2 000: del orden de una fila de visibilidad, y la sentencia se reutiliza', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-gate-rows-'));
    const sqlitePath = join(dataDir, 'library.sqlite');
    await createSyntheticLibrary(sqlitePath, { notes: 2000, folders: 4, tagsPerNote: 3, tagUniverse: 8 });
    const port = await openNodeLibraryPort({ sqlitePath, dataDir });
    try {
      const ids = (await port.notesVisibilityIndex()).map((row) => row.id);
      expect(ids).toHaveLength(2000);
      const snapshots: PrivacyRecheckSnapshot[] = [];
      const recheck = port.privacyRecheck.bind(port);
      port.privacyRecheck = async (request) => {
        const snapshot = await recheck(request);
        snapshots.push(snapshot);
        return snapshot;
      };
      const statements = (port as unknown as { statements: Map<string, unknown> }).statements;
      const gate = async (declare: Declare) => {
        const usage = new GateUsage();
        declare(usage);
        return passGate(port, { privateFolders: [], privateTags: ['tag3'] }, usage, { seals: true });
      };

      await gate((u) => u.note(ids[0]!));
      const afterOne = statements.size;
      await gate((u) => ids.slice(0, 10).forEach((id) => u.note(id)));
      const afterTen = statements.size;
      // Con ficheros, además las bloqueadas (ninguna aquí): la primera vez prepara lo suyo, la
      // segunda ya no.
      const withFile = (u: GateUsage): void => {
        u.note(ids[1]!);
        u.file('fichero-que-no-existe');
      };
      const firstWithFiles = await gate(withFile);
      const afterFiles = statements.size;
      await gate(withFile);

      expect({
        rows: snapshots.map((snapshot) => snapshot.notes.length),
        grewWithMoreIds: afterTen - afterOne,
        grewOnRepeat: statements.size - afterFiles,
        failedFiles: [...firstWithFiles.failedFiles]
      }).toEqual({
        rows: [1, 10, 1, 1],
        grewWithMoreIds: 0,
        grewOnRepeat: 0,
        failedFiles: ['fichero-que-no-existe']
      });
      // Las decisiones, las mismas que con el índice entero.
      const old = fullIndexPort(port);
      for (const id of ids.slice(0, 20)) {
        const usage = (): GateUsage => {
          const u = new GateUsage();
          u.note(id);
          return u;
        };
        const config = { privateFolders: [], privateTags: ['tag3'] };
        expect(plain(await passGate(port, config, usage(), { seals: true }))).toEqual(
          plain(await passGate(old, config, usage(), { seals: true }))
        );
      }
    } finally {
      port.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
