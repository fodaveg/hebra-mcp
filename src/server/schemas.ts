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

export const readNoteInputShape = {
  id: z.string().optional(),
  title: z.string().optional()
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

/** Sin `.max()`: el límite de `text` lo aplica `append-to-note.ts`. */
export const appendToNoteInputShape = {
  id: z.string(),
  text: z.string()
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
