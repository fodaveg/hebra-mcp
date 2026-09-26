/**
 * Biblioteca de prueba para L1: usa el PROPIO motor de Hebra (`SqliteLibraryEngine`,
 * `noteCreate` + `noteSave` con derivados de `deriveNote`), no datos inventados a mano.
 * Solo aquí (test, nunca en `src/`) se importa `deriveNote`: arrastra
 * `@codemirror/lang-markdown` (comentario de cabecera de `src/store/node-port.ts`), que
 * `check:bundle` prohíbe en `dist/`.
 *
 * Carpetas anidadas, etiquetas anidadas, enlaces `[[…]]`, una nota en la papelera, una
 * copia de conflicto y notas en carpeta/etiqueta privada con palabras-cebo únicas
 * (SPEC.md §10 L1).
 */
import { SqliteLibraryEngine } from '$lib/library/sqlite-engine';
import { deriveNote } from '$lib/library/derive';
import type { NoteRow } from '$lib/library/types';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

/** Cebo de una nota oculta por CARPETA privada (SPEC.md §10). */
export const BAIT_FOLDER = 'CEBO_PRIVADO_7f3a';
/** Cebo de una nota oculta por ETIQUETA privada, en una etiqueta DESCENDIENTE de la
 *  configurada (`secreto/personal` oculta por `secreto`): sin estar en ninguna carpeta
 *  privada. */
export const BAIT_TAG = 'CEBO_PRIVADO_TAG_c92e';

export interface TestLibrary {
  sqlitePath: string;
  /** Título de la nota pública principal, para resolver enlaces por título. */
  publicNoteTitle: string;
  publicNoteId: string;
  publicNote2Id: string;
  /** En `Diario/2026` (carpeta privada + subcarpeta): lleva `BAIT_FOLDER`. */
  privateFolderNoteId: string;
  /** En la raíz, etiquetada `secreto/personal`: lleva `BAIT_TAG`. */
  privateTagNoteId: string;
  /** En la raíz; enlaza a `publicNoteId` por título (para backlinks). */
  linkingNoteId: string;
  /** En la papelera: nunca debe salir por ninguna herramienta. */
  trashedNoteId: string;
  /** Dos notas VIVAS con el mismo título, en carpetas distintas (para `ambiguous_title`). */
  duplicateTitle: string;
  duplicateNoteAId: string;
  duplicateNoteBId: string;
  /** Copia de conflicto de `publicNoteId` (`noteSave` forzado a `redirected`). */
  conflictCopyId: string;
}

async function createNote(
  engine: SqliteLibraryEngine,
  folderId: string | null,
  body: string
): Promise<NoteRow> {
  const created = await engine.noteCreate(folderId);
  const derived = deriveNote(body);
  await engine.noteSave({
    id: created.id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: created.localSeq,
    baseBodySha256: created.bodySha256,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
  return (await engine.noteRead(created.id))!;
}

export async function buildTestLibrary(sqlitePath: string): Promise<TestLibrary> {
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  const engine = await SqliteLibraryEngine.open(conn, 'test-fixture');

  const proyectos = await engine.folderCreate(null, 'Proyectos');
  const lumbre = await engine.folderCreate(proyectos.id, 'Lumbre');
  const diario = await engine.folderCreate(null, 'Diario');
  const diario2026 = await engine.folderCreate(diario.id, '2026');

  const publicNoteTitle = 'Nota pública de Lumbre';
  const publicNote = await createNote(
    engine,
    lumbre.id,
    `# ${publicNoteTitle}\n#proyectos/lumbre\nEnlaza a [[Nota pública 2 de Lumbre]] y a ` +
      `[[Nota oculta de carpeta]] (que está en una carpeta privada).\n`
  );
  const publicNote2 = await createNote(
    engine,
    lumbre.id,
    '# Nota pública 2 de Lumbre\n#proyectos/lumbre\nTexto normal, sin enlaces.\n'
  );
  const privateFolderNote = await createNote(
    engine,
    diario2026.id,
    `# Nota oculta de carpeta\n${BAIT_FOLDER}: contenido que nunca debe salir.\n`
  );
  const privateTagNote = await createNote(
    engine,
    null,
    `# Nota oculta por etiqueta\n#secreto/personal\n${BAIT_TAG}: contenido que nunca debe salir.\n`
  );
  const linkingNote = await createNote(
    engine,
    null,
    `# Nota que enlaza\nEnlaza a [[${publicNoteTitle}]] desde la raíz.\n`
  );
  const trashedNote = await createNote(engine, null, '# Nota en la papelera\nEsto nunca debe salir.\n');
  await engine.noteTrash(trashedNote.id);

  const duplicateTitle = 'Título Repetido';
  const duplicateA = await createNote(engine, proyectos.id, `# ${duplicateTitle}\nCandidata A.\n`);
  const duplicateB = await createNote(engine, lumbre.id, `# ${duplicateTitle}\nCandidata B.\n`);

  // Copia de conflicto: `noteSave` con un `expectedLocalSeq` viejo y sin `baseBodySha256`
  // que case con el cuerpo actual, así que no es «in situ» (§4 de sqlite-engine.ts).
  const conflictBody = `# ${publicNoteTitle} (editado a la vez)\nOtro contenido, en conflicto.\n`;
  const conflictDerived = deriveNote(conflictBody);
  const conflictResult = await engine.noteSave({
    id: publicNote.id,
    body: conflictBody,
    title: conflictDerived.title,
    titleNorm: conflictDerived.titleNorm,
    excerpt: conflictDerived.excerpt,
    expectedLocalSeq: -1,
    baseBodySha256: null,
    tags: conflictDerived.tags,
    links: conflictDerived.links,
    blobRefs: conflictDerived.blobRefs,
    props: conflictDerived.props
  });
  if (conflictResult.outcome !== 'redirected') {
    throw new Error(`test-library: se esperaba una copia de conflicto, salió "${conflictResult.outcome}"`);
  }

  db.close();

  return {
    sqlitePath,
    publicNoteTitle,
    publicNoteId: publicNote.id,
    publicNote2Id: publicNote2.id,
    privateFolderNoteId: privateFolderNote.id,
    privateTagNoteId: privateTagNote.id,
    linkingNoteId: linkingNote.id,
    trashedNoteId: trashedNote.id,
    duplicateTitle,
    duplicateNoteAId: duplicateA.id,
    duplicateNoteBId: duplicateB.id,
    conflictCopyId: conflictResult.redirectedTo
  };
}
