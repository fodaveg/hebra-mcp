/**
 * Lo que el servidor cuenta de sí mismo para que un cliente no adivine (SPEC.md §5,
 * «Capacidades»): las `instructions` del `initialize` y el bloque `capabilities` de
 * `hebra_status`. Solo describe el servidor: nunca contenido de notas ni los NOMBRES de
 * carpetas o etiquetas privadas (de la configuración de privados solo sale si hay
 * alguna, un booleano).
 */
import type { PrivacyConfig } from '../privacy/config';
import { ATTACHMENT_NAME_MAX_LENGTH } from '../store/attachment-content';
import { EDITS_MAX_COUNT, EDITS_TOTAL_MAX_LENGTH } from '../store/edits';
import { FOLDER_NAME_MAX_LENGTH } from '../store/folders';
import { OPERATION_ID_MAX_LENGTH } from '../store/operations';
import { APPEND_TEXT_MAX_LENGTH, CREATE_BODY_MAX_LENGTH } from '../store/writes';
import { LIMITS } from './pagination';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TEXT_MAX_CHARS } from './tools/attachments';

/** Herramientas que registra `register-tools.ts`, ordenadas. Una herramienta nueva se
 *  añade aquí Y en `test/fixtures/tool-names.ts` (un test compara ambas listas). */
export const CAPABILITY_TOOLS: readonly string[] = [
  'hebra_add_attachment',
  'hebra_append_to_note',
  'hebra_create_folder',
  'hebra_create_note',
  'hebra_edit_note',
  'hebra_links',
  'hebra_list_attachments',
  'hebra_list_folders',
  'hebra_list_notes',
  'hebra_list_tags',
  'hebra_list_trash',
  'hebra_list_versions',
  'hebra_move_note',
  'hebra_read_attachment',
  'hebra_read_note',
  'hebra_read_version',
  'hebra_rename_folder',
  'hebra_restore_note',
  'hebra_restore_version',
  'hebra_search',
  'hebra_set_archived',
  'hebra_set_favorite',
  'hebra_status',
  'hebra_trash_note'
];

/** Lo que este servidor NO hace (D2 y D9, SPEC.md §5), por si un cliente lo intenta.
 *  Desde D9 (3 oct 2026) crea y renombra carpetas y añade adjuntos; mover o borrar
 *  carpetas y cambiar o borrar adjuntos siguen fuera. */
const NOT_ALLOWED = [
  'purge_notes_or_empty_trash_or_irreversible_delete',
  'folder_move_or_delete',
  'attachment_change_or_delete'
] as const;

export interface Capabilities {
  server: { name: 'hebra-mcp'; version: string };
  tools: string[];
  pagination: { cursor: 'opaque'; endOfList: 'nextCursor is null' };
  limits: {
    search: { default: number; max: number };
    listNotes: { default: number; max: number };
    links: { max: number };
    listTags: { max: number };
    listFolders: { max: number };
    listTrash: { default: number; max: number };
    listVersions: { default: number; max: number };
    listAttachments: { max: number };
    createNoteBodyChars: number;
    appendTextChars: number;
    editNote: { maxEdits: number; maxTotalChars: number; operationIdChars: number };
    /** Leer adjuntos: bytes descifrados por adjunto. */
    attachmentBytes: number;
    /** `hebra_read_attachment` de texto: máximo de caracteres por tramo (`maxChars`). */
    attachmentTextChars: number;
    /** `hebra_add_attachment` (D9): bytes decodificados por adjunto añadido. */
    addAttachmentBytes: number;
    /** Nombre de un adjunto añadido y de una carpeta, tras recortar (D9). */
    attachmentNameChars: number;
    folderNameChars: number;
  };
  notAllowed: string[];
  /** ¿Hay carpetas o etiquetas privadas configuradas? Solo el booleano. */
  privacyConfigured: boolean;
}

export function buildCapabilities(version: string, privacy: PrivacyConfig): Capabilities {
  return {
    server: { name: 'hebra-mcp', version },
    tools: [...CAPABILITY_TOOLS],
    pagination: { cursor: 'opaque', endOfList: 'nextCursor is null' },
    limits: {
      search: { default: LIMITS.search.default, max: LIMITS.search.max },
      listNotes: { default: LIMITS.listNotes.default, max: LIMITS.listNotes.max },
      links: { max: LIMITS.links.max },
      listTags: { max: LIMITS.listTags.max },
      listFolders: { max: LIMITS.listFolders.max },
      listTrash: { default: LIMITS.listTrash.default, max: LIMITS.listTrash.max },
      listVersions: { default: LIMITS.listVersions.default, max: LIMITS.listVersions.max },
      listAttachments: { max: LIMITS.listAttachments.max },
      createNoteBodyChars: CREATE_BODY_MAX_LENGTH,
      appendTextChars: APPEND_TEXT_MAX_LENGTH,
      editNote: {
        maxEdits: EDITS_MAX_COUNT,
        maxTotalChars: EDITS_TOTAL_MAX_LENGTH,
        operationIdChars: OPERATION_ID_MAX_LENGTH
      },
      attachmentBytes: ATTACHMENT_MAX_BYTES,
      attachmentTextChars: ATTACHMENT_TEXT_MAX_CHARS,
      addAttachmentBytes: ATTACHMENT_MAX_BYTES,
      attachmentNameChars: ATTACHMENT_NAME_MAX_LENGTH,
      folderNameChars: FOLDER_NAME_MAX_LENGTH
    },
    notAllowed: [...NOT_ALLOWED],
    privacyConfigured: privacy.privateFolders.length > 0 || privacy.privateTags.length > 0
  };
}

/** `instructions` del servidor MCP (van en `initialize`): fijas, sin datos de la biblioteca. */
export const SERVER_INSTRUCTIONS = [
  'Hebra es una biblioteca de notas Markdown. Este servidor la lee, busca, crea, edita y organiza (mover, favorita, archivar), manda notas a la papelera y las saca (reversible), crea y renombra carpetas (hebra_create_folder, hebra_rename_folder) y añade adjuntos a una nota (hebra_add_attachment: PNG, JPEG, GIF, WebP, PDF, texto, Markdown, CSV o JSON en base64, hasta 5 MiB).',
  'Versiones anteriores de una nota (hebra_list_versions, hebra_read_version): solo las de este dispositivo; hebra_restore_version es una edición nueva y pide `expectedRevision` y un operationId nuevo.',
  'Las listas (hebra_search, hebra_list_notes, hebra_links, hebra_list_tags, hebra_list_folders, hebra_list_trash, hebra_list_versions, hebra_list_attachments) aceptan `limit` y `cursor`; pasa el `nextCursor` recibido para la página siguiente, que es null al final.',
  'hebra_search y hebra_list_notes aceptan `fields` para pedir solo algunos campos.',
  'Para editar: lee con hebra_read_note, usa su `revision` como expectedRevision en hebra_edit_note y un operationId nuevo por edición. hebra_add_attachment también pide un operationId nuevo por adjunto.',
  'No permite purgar notas, vaciar la papelera ni borrar de forma irreversible, ni mover o borrar carpetas, ni cambiar o borrar adjuntos (se leen con hebra_list_attachments y hebra_read_attachment, y se añaden con hebra_add_attachment). Algunas notas y carpetas pueden no estar disponibles por la configuración de privacidad del dueño; se comportan como si no existieran, y un nombre de carpeta que no se puede usar responde folder_unavailable.',
  'hebra_status devuelve el estado del sync y `capabilities` (versión, herramientas y límites).'
].join('\n');
