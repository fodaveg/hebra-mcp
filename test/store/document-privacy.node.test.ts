/**
 * B-N11 (R21): las guardas de privacidad de los documentos, con el motor real del MCP.
 * Oculto, inexistente, lápida y papelera dan el mismo `not_found`; la regla (b) sobre el hash
 * de un punto de control (nota oculta viva, de la papelera o bloqueada); los recursos de un
 * lote por fichero y por adjunto. En cada caso rechazado no se escribe nada.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveNote } from '../../src/hebra';
import type { PrivacyConfig } from '../../src/privacy/config';
import {
  assertCheckpointNotHidden,
  guardAsset,
  guardDocumentRead,
  guardDocumentWrite
} from '../../src/store/document-privacy';
import type { DocumentAsset } from '../../src/store/document-types';
import { lockedBody } from '../privacy/audit-harness';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const CONFIG: PrivacyConfig = { privateFolders: [['diario']], privateTags: ['secreto'] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function open(): Promise<NodeLibraryPort> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-document-privacy-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite') });
  ports.push(port);
  return port;
}

/** Un fichero suelto de texto en `folderId`; devuelve su id. */
async function addFile(port: NodeLibraryPort, folderId: string, name: string, text: string): Promise<string> {
  return port.writeExclusive(async (store) => {
    const bytes = new TextEncoder().encode(text);
    await store.blobPut(bytes, { mime: 'text/plain', expectedSha256: sha(text) });
    return (await store.fileCreate(folderId, name, sha(text))).id;
  });
}

/** Una nota con ese cuerpo en `folderId`; devuelve su id. */
async function addNote(port: NodeLibraryPort, folderId: string | null, body: string): Promise<string> {
  const created = await port.noteCreate(folderId);
  await port.noteSave({
    ...deriveNote(body),
    id: created.id,
    body,
    expectedLocalSeq: created.localSeq,
    baseBodySha256: created.bodySha256
  });
  return created.id;
}

interface World {
  port: NodeLibraryPort;
  visible: string;
  enDiario: string;
  enPapelera: string;
  /** Punto de control cuyo hash enlaza una nota oculta por etiqueta. */
  enlazadoOculta: string;
  enlazadoPapelera: string;
  enlazadoVisible: string;
  /** Adjuntos (hash) de notas. */
  adjuntoPublico: { noteId: string; attachmentId: string };
  adjuntoOculto: { noteId: string; attachmentId: string };
  adjuntoEnPapelera: { noteId: string; attachmentId: string };
  adjuntoCompartido: { noteId: string; attachmentId: string };
}

async function world(): Promise<World> {
  const port = await open();
  const { publica, diario } = await port.writeExclusive(async (store) => ({
    publica: (await store.folderCreate('root', 'Publica')).id,
    diario: (await store.folderCreate('root', 'Diario')).id
  }));
  const visible = await addFile(port, publica, 'visible.ods', 'documento visible');
  const enDiario = await addFile(port, diario, 'privado.ods', 'documento privado');
  const enPapelera = await addFile(port, publica, 'viejo.ods', 'documento viejo');
  await port.writeExclusive(async (store) => {
    await store.fileTrash(enPapelera);
  });

  // Notas que enlazan por hash unos bytes de punto de control.
  const link = (text: string, extra = ''): string => `# Nota\n${extra}\n![[sha256:${sha(text)}|x.ods]]\n`;
  await addNote(port, publica, link('punto oculto', '#secreto'));
  const enPapeleraNote = await addNote(port, publica, link('punto papelera', '#secreto'));
  await port.writeExclusive(async (store) => {
    await store.noteTrash(enPapeleraNote);
  });
  await addNote(port, publica, link('punto visible'));

  // Adjuntos: bytes reales en el almacén para que la nota los vea presentes.
  const adjunto = async (text: string, noteTags: string, trash = false, folder = publica) => {
    await port.writeExclusive(async (store) => {
      await store.blobPut(new TextEncoder().encode(text), { mime: 'text/plain', expectedSha256: sha(text) });
    });
    const noteId = await addNote(port, folder, `# Con adjunto\n${noteTags}\n![[sha256:${sha(text)}|a.txt]]\n`);
    if (trash) {
      await port.writeExclusive(async (store) => {
        await store.noteTrash(noteId);
      });
    }
    return { noteId, attachmentId: sha(text) };
  };
  const adjuntoPublico = await adjunto('adjunto publico', '');
  const adjuntoOculto = await adjunto('adjunto oculto', '#secreto');
  const adjuntoEnPapelera = await adjunto('adjunto papelera', '', true);
  // Unos bytes que una nota visible adjunta y otra oculta enlaza.
  const adjuntoCompartido = await adjunto('adjunto compartido', '');
  await addNote(port, publica, `# Escondida\n#secreto\n![[sha256:${sha('adjunto compartido')}|b.txt]]\n`);

  return {
    port,
    visible,
    enDiario,
    enPapelera,
    enlazadoOculta: sha('punto oculto'),
    enlazadoPapelera: sha('punto papelera'),
    enlazadoVisible: sha('punto visible'),
    adjuntoPublico,
    adjuntoOculto,
    adjuntoEnPapelera,
    adjuntoCompartido
  };
}

/** Lo que cambiaría una escritura: carpetas, ficheros y número de blobs, tal como están. */
async function snapshot(port: NodeLibraryPort): Promise<string> {
  return port.writeExclusive(async (store) =>
    JSON.stringify({ folders: store.foldersList(), files: store.filesIndex() })
  );
}

/** Corre una guarda dentro de un turno, como lo hará el escritor de documentos. */
function inTurn<T>(
  port: NodeLibraryPort,
  run: (turn: { store: Parameters<Parameters<NodeLibraryPort['writeExclusive']>[0]>[0]; privacy: PrivacyConfig }) => T | Promise<T>
): Promise<T> {
  return port.writeExclusive(async (store) => run({ store, privacy: CONFIG }));
}

const NOT_FOUND = { code: 'not_found' };

describe('guardDocumentRead / guardDocumentWrite (R21)', () => {
  it('deja pasar un documento vivo y visible, con su hash y su nombre', async () => {
    const w = await world();
    const read = await inTurn(w.port, (turn) => guardDocumentRead(turn, w.visible));
    expect(read).toEqual({ id: w.visible, sha256: sha('documento visible'), name: 'visible.ods' });
    await expect(inTurn(w.port, (turn) => guardDocumentWrite(turn, w.visible))).resolves.toEqual(read);
  });

  it('oculto, inexistente, lápida y papelera dan el mismo not_found, y no escriben', async () => {
    const w = await world();
    const lapida = await addFile(w.port, (await inTurn(w.port, (t) => t.store.foldersList())).folders.find((f) => f.name === 'Publica')!.id, 'lapida.ods', 'x lapida');
    await w.port.writeExclusive(async (store) => {
      await store.fileTrash(lapida);
    });
    const before = await snapshot(w.port);
    for (const id of [w.enDiario, 'no-existe', w.enPapelera, lapida]) {
      const read = await inTurn(w.port, (turn) => guardDocumentRead(turn, id)).catch((error) => error);
      const write = await inTurn(w.port, (turn) => guardDocumentWrite(turn, id)).catch((error) => error);
      expect(read).toMatchObject(NOT_FOUND);
      expect(write).toMatchObject(NOT_FOUND);
      // Mismo error, mismo mensaje: nada distingue un oculto de un inexistente.
      expect(read.message).toBe(write.message);
    }
    expect(await snapshot(w.port)).toBe(before);
  });

  it('un fichero que enlaza una nota oculta por su hash es oculto para leer y escribir', async () => {
    const w = await world();
    const publica = (await inTurn(w.port, (t) => t.store.foldersList())).folders.find((f) => f.name === 'Publica')!.id;
    const enlazado = await addFile(w.port, publica, 'enlazado.ods', 'punto oculto');
    await expect(inTurn(w.port, (turn) => guardDocumentRead(turn, enlazado))).rejects.toMatchObject(NOT_FOUND);
    await expect(inTurn(w.port, (turn) => guardDocumentWrite(turn, enlazado))).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('regla (b) sobre el hash de un punto de control (R21)', () => {
  it('rechaza un hash que enlaza una nota oculta viva, de la papelera o bloqueada', async () => {
    const w = await world();
    const before = await snapshot(w.port);
    for (const hash of [w.enlazadoOculta, w.enlazadoPapelera]) {
      await expect(inTurn(w.port, (turn) => guardDocumentWrite(turn, w.visible, hash))).rejects.toMatchObject(
        NOT_FOUND
      );
      await expect(inTurn(w.port, (turn) => assertCheckpointNotHidden(turn, hash.toUpperCase()))).rejects.toMatchObject(
        NOT_FOUND
      );
    }
    expect(await snapshot(w.port)).toBe(before);
  });

  it('deja pasar un hash que solo enlaza una nota visible o que nadie enlaza', async () => {
    const w = await world();
    for (const hash of [w.enlazadoVisible, sha('nadie lo enlaza')]) {
      await expect(inTurn(w.port, (turn) => guardDocumentWrite(turn, w.visible, hash))).resolves.toMatchObject({
        id: w.visible
      });
    }
  });

  it('una nota bloqueada oculta por las etiquetas privadas oculta los ficheros (variante de D16)', async () => {
    const w = await world();
    await addNote(w.port, null, lockedBody('Bloqueada', [sha('punto bloqueado')]));
    const sinEtiquetas: PrivacyConfig = { privateFolders: [['diario']], privateTags: [] };
    // Con una etiqueta privada configurada, la bloqueada es oculta y no se sabe qué enlaza:
    // ni el documento ni un punto de control se tocan.
    await expect(inTurn(w.port, (turn) => guardDocumentRead(turn, w.visible))).rejects.toMatchObject(NOT_FOUND);
    await expect(
      inTurn(w.port, (turn) => assertCheckpointNotHidden(turn, sha('punto bloqueado')))
    ).rejects.toMatchObject(NOT_FOUND);
    // Sin etiquetas privadas la bloqueada deja de ser oculta y todo vuelve a pasar.
    await expect(
      w.port.writeExclusive(async (store) => guardDocumentRead({ store, privacy: sinEtiquetas }, w.visible))
    ).resolves.toMatchObject({ id: w.visible });
  });
});

describe('guardAsset (R21)', () => {
  const file = (fileId: string): DocumentAsset => ({ ref: 'r', fileId });
  const attachment = (a: { noteId: string; attachmentId: string }): DocumentAsset => ({ ref: 'r', ...a });

  it('base64: nada que filtrar', async () => {
    const w = await world();
    const asset: DocumentAsset = { ref: 'r', dataBase64: 'AAAA', mimeType: 'image/png' };
    await expect(inTurn(w.port, (turn) => guardAsset(turn, asset))).resolves.toEqual({ sha256: null });
  });

  it('un fichero visible pasa; oculto, inexistente y papelera dan not_found', async () => {
    const w = await world();
    await expect(inTurn(w.port, (turn) => guardAsset(turn, file(w.visible)))).resolves.toEqual({
      sha256: sha('documento visible')
    });
    for (const id of [w.enDiario, 'no-existe', w.enPapelera]) {
      await expect(inTurn(w.port, (turn) => guardAsset(turn, file(id)))).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('un adjunto de nota visible pasa; nota oculta, de la papelera, sin ese adjunto o inexistente, not_found', async () => {
    const w = await world();
    await expect(inTurn(w.port, (turn) => guardAsset(turn, attachment(w.adjuntoPublico)))).resolves.toEqual({
      sha256: w.adjuntoPublico.attachmentId
    });
    const sinAdjunto = { noteId: w.adjuntoPublico.noteId, attachmentId: sha('otro') };
    const casos = [
      w.adjuntoOculto,
      w.adjuntoEnPapelera,
      sinAdjunto,
      { noteId: 'no-existe', attachmentId: w.adjuntoPublico.attachmentId }
    ];
    for (const caso of casos) {
      await expect(inTurn(w.port, (turn) => guardAsset(turn, attachment(caso)))).rejects.toMatchObject(NOT_FOUND);
    }
  });

  it('un adjunto cuyos bytes enlaza también una nota oculta responde not_found', async () => {
    const w = await world();
    await expect(inTurn(w.port, (turn) => guardAsset(turn, attachment(w.adjuntoCompartido)))).rejects.toMatchObject(
      NOT_FOUND
    );
  });
});
