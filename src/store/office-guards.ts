/**
 * Guardas del escritor MCP para la importación de ofimática (paquete C-29, R-04): lo que se
 * comprueba DENTRO del turno de `writeExclusive`, antes de escribir nada, con las mismas
 * reglas que `./file-verbs.ts` y `./file-relink.ts`.
 *
 * 1. Carpeta de destino viva y visible (si no, `not_found`, como `hebra_move_note`: una
 *    privada responde igual que una que no existe).
 * 2. Fichero de origen, si lo hay, visible y vivo (oculto, inexistente, lápida o en la
 *    papelera, `not_found`, todo igual).
 * 3. La nota resultante no puede quedar oculta por sus etiquetas (`not_found`, como al
 *    editar o mover una nota: decisión 4 de David).
 * 4. Rol de escritura del espacio de destino: NO añade código aquí. El rol ya lo comprueba
 *    el turno: `NodeLibraryPort.writeExclusive` llama a `assertSpaceUserWrite` antes de
 *    ejecutar el callback (H-L7), y cada mutación del `store` del turno (la lista
 *    `mutations` de `./node-port.ts`) y cada registro propio lo repiten. Un espacio de solo
 *    lectura (`minClient` mayor que el del cliente, copia de expulsado o autoridad
 *    congelada) rechaza con `client_outdated` y el callback ni llega a correr, así que
 *    estas guardas nunca se ejecutan sobre él. La prueba está en
 *    `test/store/office-guards.node.test.ts`.
 *
 * Nada de esto escribe: solo lee el almacén del turno. Quien convierte (C-26) llama a
 * `assertOfficeWritable` dentro de su turno, antes de `blobPut` o de crear la nota.
 */
import type { PrivacyConfig } from '../privacy/config';
import { writeRejected } from './errors';
import { looseFilesFilterInTurn, privacyInTurnFor, type NoteWriteStore } from './writes';

/** Lo que hace falta del turno para decidir. */
export interface OfficeGuardTurn {
  /** El almacén del turno de `writeExclusive`. */
  store: NoteWriteStore;
  /** La configuración de privados de quien pide. */
  privacy: PrivacyConfig;
}

/** A dónde va la importación y de dónde viene. */
export interface OfficeWriteTarget {
  /** Carpeta de destino, por id (`"root"` es la raíz). */
  folderId: string;
  /** Fichero suelto de origen, si la importación parte de uno de la biblioteca. */
  sourceFileId?: string;
  /** Etiquetas canónicas (con sus ancestros, como las da `deriveNote`) de la nota
   *  convertida. */
  resultTags?: readonly string[];
}

/**
 * Rechaza con `not_found`, sin escribir, una importación cuyo destino, origen o resultado
 * no se ven con la configuración de quien pide. El rol del espacio ya lo ha comprobado el
 * turno (ver la cabecera, punto 4). Si la configuración de privados no se puede aplicar,
 * `privacy_config_unresolved`.
 */
export function assertOfficeWritable(turn: OfficeGuardTurn, target: OfficeWriteTarget): void {
  const { store, privacy } = turn;
  if (target.folderId.length === 0) throw writeRejected('invalid_input');
  // El índice de ficheros solo se carga si hay origen que mirar.
  const source = target.sourceFileId === undefined ? undefined : looseFilesFilterInTurn(store, privacy, store.filesIndex());
  const live = source ? source.live : privacyInTurnFor(store, privacy, []);

  if (!live.folderExists(target.folderId) || live.isFolderHidden(target.folderId)) {
    throw writeRejected('not_found');
  }

  if (source) {
    const content = source.files.contentOf(target.sourceFileId!);
    if (!content || content.file.trashedAt !== null) throw writeRejected('not_found');
  }

  if (target.resultTags !== undefined && live.hidesAnyTag(target.resultTags)) {
    throw writeRejected('not_found');
  }
}
