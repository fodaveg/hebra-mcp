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
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { deriveNote, SqliteLibraryEngine, type NoteRow } from '../../src/hebra';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';

/** Cebo de una nota oculta por CARPETA privada (SPEC.md §10). */
export const BAIT_FOLDER = 'CEBO_PRIVADO_7f3a';
/** Cebo de una nota oculta por ETIQUETA privada, en una etiqueta DESCENDIENTE de la
 *  configurada (`secreto/personal` oculta por `secreto`): sin estar en ninguna carpeta
 *  privada. */
export const BAIT_TAG = 'CEBO_PRIVADO_TAG_c92e';

/** Cebo de los adjuntos: va en el NOMBRE y en el contenido del adjunto de texto visible
 *  (puede salir en la salida de `hebra_read_attachment`, nunca en stderr). */
export const BAIT_ATTACHMENT = 'CEBO_ADJUNTO_5d1e';

/** Adjuntos de `attachmentsNoteId`: bytes y tipo declarado. */
export const ATTACHMENT_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);
export const ATTACHMENT_TEXT = `Lista de la compra\n${BAIT_ATTACHMENT}\npan, café\n`;
export const ATTACHMENT_PDF = new TextEncoder().encode('%PDF-1.4\n% prueba\n1 0 obj << >> endobj\n%%EOF\n');
const ATTACHMENT_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
/** Tamaño de la fila del adjunto grande (sin bytes): 5 MiB + 1. */
export const ATTACHMENT_BIG_BYTES = 5 * 1024 * 1024 + 1;

function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cuerpos de `versionedNoteId`: el de la versión anterior y el actual. */
export const VERSIONED_OLD_BODY = '# Nota con versiones\n\nPrimera redacción.\n';
export const VERSIONED_NEW_BODY = '# Nota con versiones\n\nSegunda redacción.\n';

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
  /** En la papelera, en la raíz: solo sale por `hebra_list_trash` (y se puede restaurar). */
  trashedNoteId: string;
  /** En la papelera, desde `Proyectos/Lumbre` (sigue viva): vuelve allí al restaurarla. */
  trashedPublicFolderNoteId: string;
  /** En la papelera, desde `Diario/2026` (privada): lleva `BAIT_FOLDER`, nunca sale. */
  trashedPrivateFolderNoteId: string;
  /** En la papelera, con `#secreto/personal`: lleva `BAIT_TAG`, nunca sale. */
  trashedPrivateTagNoteId: string;
  /** En la papelera porque se BORRÓ su carpeta, `Diario/Viejo` (subcarpeta de una privada,
   *  ahora lápida): lleva `BAIT_FOLDER`, nunca sale. Restaurarla la dejaría en la raíz. */
  trashedDeletedPrivateFolderNoteId: string;
  /** En la papelera porque se borró su carpeta, `Proyectos/Antiguo` (pública, ahora
   *  lápida): sale en la papelera y vuelve a la raíz al restaurarla, como en Hebra. */
  trashedDeletedPublicFolderNoteId: string;
  /** Nota visible con UNA versión anterior visible (`VERSIONED_OLD_BODY`); su cuerpo
   *  actual es `VERSIONED_NEW_BODY`. */
  versionedNoteId: string;
  versionedNoteVersionId: number;
  /** Nota visible HOY cuya versión anterior llevaba `#secreto/personal` y `BAIT_TAG`: esa
   *  versión no se lista, no se lee ni se restaura. */
  formerlyPrivateNoteId: string;
  formerlyPrivateVersionId: number;
  /** Nota visible (carpeta `Adjuntos`) con seis adjuntos `![[sha256:H|nombre]]`: PNG,
   *  texto, PDF (los tres con bytes), uno de 5 MiB + 1 cuyo tamaño se sabe por su fila
   *  pero cuyos bytes no están, un ZIP (tipo no permitido) y uno sin bytes ni fila. */
  attachmentsNoteId: string;
  attachments: { png: string; text: string; pdf: string; big: string; zip: string; missing: string };
  /** En `Diario/2026` (privada): un adjunto de texto con `BAIT_FOLDER` en nombre y bytes. */
  privateAttachmentNoteId: string;
  privateAttachmentSha: string;
  /** Dos notas VIVAS con el mismo título, en carpetas distintas (para `ambiguous_title`). */
  duplicateTitle: string;
  duplicateNoteAId: string;
  duplicateNoteBId: string;
  /** Copia de conflicto de `publicNoteId` (`noteSave` forzado a `redirected`). */
  conflictCopyId: string;
  /** Un enlace real y un `[[…]]` literal DENTRO de una valla de código: el segundo no
   *  cuenta como enlace (SPEC.md §5, `hebra_links`; hallazgo del coordinador, 26 sep
   *  2026, sobre `deriveNote` vs. un regex propio). */
  codeFenceNoteId: string;
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

/** Guarda `body` en una nota que ya existe, con los derivados y la base de lo leído. */
async function saveBody(engine: SqliteLibraryEngine, id: string, body: string): Promise<void> {
  const row = (await engine.noteRead(id))!;
  const derived = deriveNote(body);
  await engine.noteSave({
    id,
    body,
    title: derived.title,
    titleNorm: derived.titleNorm,
    excerpt: derived.excerpt,
    expectedLocalSeq: row.localSeq,
    baseBodySha256: row.bodySha256,
    tags: derived.tags,
    links: derived.links,
    blobRefs: derived.blobRefs,
    props: derived.props
  });
}

export async function buildTestLibrary(sqlitePath: string): Promise<TestLibrary> {
  const { db, conn } = openNodeSqliteConn(sqlitePath);
  // Los bytes de los adjuntos en el MISMO sitio que usará el puerto (`<dataDir>/blobs`).
  const engine = await SqliteLibraryEngine.open(conn, 'test-fixture', {
    blobs: new FsBlobStore(dirname(sqlitePath))
  });

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

  // Papelera (ampliación de D2, 30 sep 2026): notas visibles y ocultas en la papelera,
  // también las que llegaron ahí porque se borró su carpeta (`folderTrash` deja la carpeta
  // como lápida y no toca el `folder_id` de sus notas).
  const trashedPublicFolderNote = await createNote(
    engine,
    lumbre.id,
    '# Borrador de Lumbre tirado\nTexto público en la papelera.\n'
  );
  await engine.noteTrash(trashedPublicFolderNote.id);
  const trashedPrivateFolderNote = await createNote(
    engine,
    diario2026.id,
    `# Diario tirado\n${BAIT_FOLDER}: en la papelera, nunca debe salir.\n`
  );
  await engine.noteTrash(trashedPrivateFolderNote.id);
  const trashedPrivateTagNote = await createNote(
    engine,
    null,
    `# Secreto tirado\n#secreto/personal\n${BAIT_TAG}: en la papelera, nunca debe salir.\n`
  );
  await engine.noteTrash(trashedPrivateTagNote.id);
  const diarioViejo = await engine.folderCreate(diario.id, 'Viejo');
  const trashedDeletedPrivateFolderNote = await createNote(
    engine,
    diarioViejo.id,
    `# Diario viejo\n${BAIT_FOLDER}: su carpeta privada se borró.\n`
  );
  await engine.folderTrash(diarioViejo.id);
  const antiguo = await engine.folderCreate(proyectos.id, 'Antiguo');
  const trashedDeletedPublicFolderNote = await createNote(
    engine,
    antiguo.id,
    '# Nota de carpeta borrada\nSu carpeta pública se borró.\n'
  );
  await engine.folderTrash(antiguo.id);

  // Versiones anteriores: el motor guarda el cuerpo que un guardado sustituye (el primero
  // de una nota, sin esperar los 5 minutos). `createNote` guarda sobre el cuerpo vacío
  // (sin versión); el segundo guardado deja la primera redacción como versión.
  // En su propia carpeta, `Historial`, para no mover los recuentos de la raíz.
  const historial = await engine.folderCreate(null, 'Historial');
  const versionedNote = await createNote(engine, historial.id, VERSIONED_OLD_BODY);
  await saveBody(engine, versionedNote.id, VERSIONED_NEW_BODY);
  const formerlyPrivate = await createNote(
    engine,
    historial.id,
    `# Nota que fue secreta\n#secreto/personal\n${BAIT_TAG}: esto era privado.\n`
  );
  await saveBody(engine, formerlyPrivate.id, '# Nota que fue secreta\n\nYa no es privada.\n');
  const onlyVersion = (noteId: string): number => {
    const { items } = engine.noteVersionsList(noteId);
    if (items.length !== 1) throw new Error(`test-library: se esperaba una versión, hay ${items.length}`);
    return items[0]!.id;
  };

  const codeFenceNote = await createNote(
    engine,
    null,
    `# Nota con código\nEnlaza de verdad a [[${publicNoteTitle}]].\n\n` +
      '```\n[[Nota pública 2 de Lumbre]] (esto es código, no un enlace)\n```\n'
  );

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

  // Adjuntos (solo lectura, 30 sep 2026): los bytes por `blobPut` del motor, como los
  // guarda Hebra; el grande solo con su fila (tamaño conocido, bytes en el relé).
  const png = (await engine.blobPut(ATTACHMENT_PNG, { mime: 'image/png' })).sha256;
  const text = (await engine.blobPut(new TextEncoder().encode(ATTACHMENT_TEXT), { mime: 'text/plain' }))
    .sha256;
  const pdf = (await engine.blobPut(ATTACHMENT_PDF, { mime: 'application/pdf' })).sha256;
  const zip = (await engine.blobPut(ATTACHMENT_ZIP, { mime: 'application/zip' })).sha256;
  const big = sha256Of('adjunto grande que solo está en el relé');
  db.prepare(
    'INSERT INTO blobs(sha256, byte_length, mime, present, uploaded) VALUES (?, ?, ?, 0, 1)'
  ).run(big, ATTACHMENT_BIG_BYTES, 'image/png');
  const missing = sha256Of('adjunto que nadie tiene');
  const adjuntos = await engine.folderCreate(null, 'Adjuntos');
  const attachmentsNote = await createNote(
    engine,
    adjuntos.id,
    '# Nota con adjuntos\n\n' +
      `![[sha256:${png}|foto.png]]\n` +
      `![[sha256:${text}|${BAIT_ATTACHMENT}.txt]]\n` +
      `![[sha256:${pdf}|plano.pdf]]\n` +
      `![[sha256:${big}|grande.png]]\n` +
      `![[sha256:${zip}|comprimido.zip]]\n` +
      `![[sha256:${missing}|perdido.png]]\n`
  );
  const privateAttachment = (
    await engine.blobPut(new TextEncoder().encode(`${BAIT_FOLDER} en un adjunto privado\n`), {
      mime: 'text/plain'
    })
  ).sha256;
  const privateAttachmentNote = await createNote(
    engine,
    diario2026.id,
    `# Diario con adjunto\n\n![[sha256:${privateAttachment}|${BAIT_FOLDER}.txt]]\n`
  );

  const versionedNoteVersionId = onlyVersion(versionedNote.id);
  const formerlyPrivateVersionId = onlyVersion(formerlyPrivate.id);

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
    trashedPublicFolderNoteId: trashedPublicFolderNote.id,
    trashedPrivateFolderNoteId: trashedPrivateFolderNote.id,
    trashedPrivateTagNoteId: trashedPrivateTagNote.id,
    trashedDeletedPrivateFolderNoteId: trashedDeletedPrivateFolderNote.id,
    trashedDeletedPublicFolderNoteId: trashedDeletedPublicFolderNote.id,
    versionedNoteId: versionedNote.id,
    versionedNoteVersionId: versionedNoteVersionId,
    formerlyPrivateNoteId: formerlyPrivate.id,
    formerlyPrivateVersionId: formerlyPrivateVersionId,
    attachmentsNoteId: attachmentsNote.id,
    attachments: { png, text, pdf, big, zip, missing },
    privateAttachmentNoteId: privateAttachmentNote.id,
    privateAttachmentSha: privateAttachment,
    duplicateTitle,
    duplicateNoteAId: duplicateA.id,
    duplicateNoteBId: duplicateB.id,
    conflictCopyId: conflictResult.redirectedTo,
    codeFenceNoteId: codeFenceNote.id
  };
}
