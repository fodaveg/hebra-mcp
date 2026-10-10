/**
 * Esquemas de entrada de las herramientas de lectura (SPEC.md §5), con los límites de la
 * tabla. Los tramos por defecto (`limit`) se aplican en cada `tools/*.ts`, no aquí: así
 * el esquema deja el campo opcional y el JSON Schema publicado no promete un valor fijo
 * que luego se recorta.
 */
import { z } from 'zod';

/** Paginación común (SPEC.md §5): `limit` acotado por herramienta y `cursor` opaco, el
 *  `nextCursor` de la página anterior. */
const cursorField = z
  .string()
  .optional()
  .describe('`nextCursor` de la página anterior (opaco). Ausente: primera página.');

/** Campos que se pueden pedir con `fields` (`id` sale siempre). */
export const SEARCH_FIELDS = [
  'title',
  'folderPath',
  'tags',
  'snippet',
  'heading',
  'updatedAt',
  'isConflictCopy'
] as const;
export const LIST_NOTES_FIELDS = [
  'title',
  'folderPath',
  'tags',
  'excerpt',
  'updatedAt',
  'isConflictCopy'
] as const;

export const searchInputShape = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: cursorField,
  folder: z.string().optional()
    .describe('Ruta de carpeta, como `path` de hebra_list_folders.'),
  /** Igual que en `hebra_list_notes`: con `folder`, incluye su subárbol. */
  subfolders: z.boolean().optional(),
  tag: z.string().optional(),
  fields: z
    .array(z.enum(SEARCH_FIELDS))
    .min(1)
    .optional()
    .describe('Solo estos campos de cada resultado (`id` siempre). Ausente: todos.')
};

export const listNotesInputShape = {
  folder: z.string().optional()
    .describe('Ruta de carpeta, como `path` de hebra_list_folders.'),
  /** Con `folder`, incluye también las notas de sus subcarpetas (carpetas reales,
   *  decisión de David del 27 sep 2026). Ausente o `false`: solo las directas, como
   *  siempre. Sin `folder`, no tiene efecto. */
  subfolders: z.boolean().optional(),
  tag: z.string().optional(),
  cursor: cursorField,
  limit: z.number().int().min(1).max(100).optional(),
  fields: z
    .array(z.enum(LIST_NOTES_FIELDS))
    .min(1)
    .optional()
    .describe('Solo estos campos de cada nota (`id` siempre). Ausente: todos.')
};

/** Apartado de una nota (D11). Sin `.min()`/`.max()`: los límites los aplica la herramienta
 *  con `invalid_input`, sin eco de la entrada. `headingOccurrence` sin `heading` es
 *  `invalid_input`. */
const headingField = z
  .string()
  .optional()
  .describe('Título de un apartado (de hebra_note_outline). Con él, solo ese apartado.');
const headingOccurrenceField = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Si el título se repite, cuál (`occurrence` de hebra_note_outline). Solo con `heading`.');

export const readNoteInputShape = {
  id: z.string().optional(),
  title: z.string().optional(),
  heading: headingField,
  headingOccurrence: headingOccurrenceField
};

/** `hebra_note_outline` (D11): como `hebra_read_note` para elegir la nota. */
export const noteOutlineInputShape = {
  id: z.string().optional(),
  title: z.string().optional(),
  maxLevel: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe('Solo los encabezados de este nivel (1-6) o menor.'),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: cursorField
};

/** `limit` y `cursor` valen para `outgoing` y `backlinks` a la vez; `nextCursor` existe
 *  si a alguna de las dos le queda algo. Sin `limit`, todo. */
export const linksInputShape = {
  id: z.string(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: cursorField
};

/** Sin `limit`, todas (como antes de paginar). */
export const listTagsInputShape = {
  limit: z.number().int().min(1).max(500).optional(),
  cursor: cursorField
};

export const listFoldersInputShape = {
  limit: z.number().int().min(1).max(500).optional(),
  cursor: cursorField
};

/** Sin `.max()` a propósito (SPEC.md §5, L3b): el límite de `body` lo aplica
 *  `create-note.ts` con `invalid_input`, sin eco de la entrada. */
export const createNoteInputShape = {
  body: z.string(),
  folder: z.string().optional()
    .describe('Ruta de carpeta, como `path` de hebra_list_folders.')
};

/** Sin `.max()`: el límite de `text` y el de `operationId` los aplica `append-to-note.ts`. */
export const appendToNoteInputShape = {
  id: z.string(),
  text: z.string(),
  heading: z
    .string()
    .optional()
    .describe('Título de un apartado (de hebra_note_outline): el texto va al final de ese apartado, subapartados incluidos. Sin él, al final de la nota.'),
  headingOccurrence: headingOccurrenceField,
  operationId: z
    .string()
    .optional()
    .describe('Opcional: id único de este añadido (un UUID). Reintentar con el mismo no vuelve a añadir el texto (durante 24 h) y devuelve la misma respuesta con `replayed: true`.')
};

/** Sin `.min()`/`.max()`: número de sustituciones, tamaños y `operationId` los aplica
 *  `edit-note.ts` con `invalid_input`, sin eco de la entrada. */
export const editNoteInputShape = {
  id: z.string(),
  edits: z.array(
    z.object({
      find: z.string().describe('Texto EXACTO del cuerpo leído; tiene que aparecer una sola vez.'),
      replace: z.string()
    })
  ),
  expectedRevision: z.string().describe('La `revision` que devolvió hebra_read_note.'),
  operationId: z
    .string()
    .describe('Id único de esta edición (un UUID). Reintentar con el mismo no la repite.')
};

/** Organización de notas (D2 ampliada): todo por id, los de `hebra_list_notes`/
 *  `hebra_list_folders`. La raíz es la carpeta `"root"`. */
const FOLDER_ID_HINT = 'Id de carpeta de hebra_list_folders ("root" es la raíz).';

/** Carpetas (D9, 3 oct 2026): crear y renombrar. Sin `.max()` en `name`: el nombre lo
 *  valida `src/store/folders.ts` con `invalid_input`, sin eco de la entrada. */
const FOLDER_NAME_HINT =
  'Nombre de la carpeta (hasta 255 caracteres, sin "/"; se recortan los espacios de los extremos).';

export const createFolderInputShape = {
  name: z.string().describe(FOLDER_NAME_HINT),
  parent: z
    .string()
    .optional()
    .describe('Ruta de la carpeta padre, como `path` de hebra_list_folders. Sin `parent` ni `parentId`, la raíz.'),
  parentId: z
    .string()
    .optional()
    .describe('Id de la carpeta padre (hebra_list_folders; "root" es la raíz), en vez de `parent`.')
};

export const renameFolderInputShape = {
  folderId: z.string().describe(FOLDER_ID_HINT),
  name: z.string().describe(FOLDER_NAME_HINT)
};

/** Añadir un adjunto (D9). Sin `.max()`: el tamaño (5 MiB decodificados), el nombre y
 *  `operationId` los aplica `add-attachment.ts` con sus códigos, sin eco de la entrada. */
export const addAttachmentInputShape = {
  id: z.string(),
  name: z
    .string()
    .describe('Nombre del fichero, con extensión (p. ej. `captura.png`). Sin | [ ] \\ # ni saltos de línea.'),
  dataBase64: z
    .string()
    .describe('Contenido en base64 estándar (como mucho 5 MiB decodificados); se ignoran espacios y saltos de línea.'),
  mimeType: z
    .string()
    .optional()
    .describe('Tipo declarado. Las imágenes y el PDF se reconocen por su contenido; para texto, Markdown, CSV o JSON basta este tipo o la extensión del nombre.'),
  operationId: z
    .string()
    .describe('Id único de esta operación (un UUID). Reintentar con el mismo no vuelve a añadir el adjunto.')
};

export const moveNoteInputShape = {
  id: z.string(),
  folderId: z.string().describe(FOLDER_ID_HINT)
};

export const setFavoriteInputShape = {
  id: z.string(),
  favorite: z.boolean()
};

export const setArchivedInputShape = {
  id: z.string(),
  archived: z.boolean()
};

/** Papelera (ampliación de D2, 30 sep 2026): mandar y sacar, por id. Nada de purgar ni
 *  vaciar la papelera. */
export const trashNoteInputShape = {
  id: z.string()
};

export const restoreNoteInputShape = {
  id: z.string().describe('Id de una nota de hebra_list_trash.')
};

export const listTrashInputShape = {
  cursor: cursorField,
  limit: z.number().int().min(1).max(100).optional()
};

/** Ficheros sueltos (D10, 9 oct 2026): listar, mandar a la papelera y sacar, por id. Nada
 *  de purgar, crear, renombrar, mover, reemplazar ni leer su contenido. Sin
 *  `.min()`/`.max()` en `name`: su longitud (1–255) la aplica `files.ts` con
 *  `invalid_input`, sin eco de la entrada. */
export const listFilesInputShape = {
  folder: z.string().optional()
    .describe('Ruta de carpeta, como `path` de hebra_list_folders.'),
  /** Igual que en `hebra_list_notes`: con `folder`, incluye su subárbol. */
  subfolders: z.boolean().optional(),
  name: z
    .string()
    .optional()
    .describe('Solo los ficheros cuyo nombre contiene este texto, sin distinguir mayúsculas (1 a 255 caracteres).'),
  trashed: z
    .boolean()
    .optional()
    .describe('`true`: los ficheros de la papelera, el último en entrar primero. Ausente o `false`: los vivos, por nombre.'),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: cursorField
};

export const trashFileInputShape = {
  id: z.string().describe('Id de un fichero de hebra_list_files.')
};

export const restoreFileInputShape = {
  id: z.string().describe('Id de un fichero de hebra_list_files con `trashed: true`.')
};

/** Versiones anteriores (ampliación de D2, 30 sep 2026). */
const VERSION_ID = z.number().int().min(1).describe('versionId de hebra_list_versions.');

export const listVersionsInputShape = {
  id: z.string(),
  limit: z.number().int().min(1).max(200).optional().describe('Máximo de resultados por página.'),
  cursor: cursorField
};

export const readVersionInputShape = {
  id: z.string(),
  versionId: VERSION_ID
};

/** Sin `.min()`/`.max()` en `operationId`: como `editNoteInputShape`, lo aplica
 *  `versions.ts` con `invalid_input`. */
export const restoreVersionInputShape = {
  id: z.string(),
  versionId: VERSION_ID,
  expectedRevision: z.string().describe('La `revision` que devolvió hebra_read_note.'),
  operationId: z
    .string()
    .describe('Id único de esta restauración (un UUID). Reintentar con el mismo no la repite.')
};

/** Adjuntos en solo lectura (ampliación de D2, 30 sep 2026). */
export const listAttachmentsInputShape = {
  id: z.string(),
  limit: z.number().int().min(1).max(200).optional().describe('Máximo de resultados por página.'),
  cursor: cursorField
};

export const readAttachmentInputShape = {
  id: z.string(),
  attachmentId: z.string().describe('attachmentId de hebra_list_attachments (SHA-256).'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Solo adjuntos de texto: carácter por el que empezar. Por defecto 0.'),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe('Solo adjuntos de texto: cuántos caracteres devolver. Por defecto y máximo 100 000.')
};
