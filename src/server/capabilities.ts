/**
 * Lo que el servidor cuenta de sí mismo para que un cliente no adivine (SPEC.md §5,
 * «Capacidades»): las `instructions` del `initialize` y el bloque `capabilities` de
 * `hebra_status`. Solo describe el servidor: nunca contenido de notas ni los NOMBRES de
 * carpetas o etiquetas privadas (de la configuración de privados solo sale si hay
 * alguna, un booleano).
 */
import type { PrivacyConfig } from '../privacy/config';
import { EDITS_MAX_COUNT, EDITS_TOTAL_MAX_LENGTH } from '../store/edits';
import { OPERATION_ID_MAX_LENGTH } from '../store/operations';
import { APPEND_TEXT_MAX_LENGTH, CREATE_BODY_MAX_LENGTH } from '../store/writes';
import { LIMITS } from './pagination';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TEXT_MAX_CHARS } from './tools/attachments';

/** Herramientas que registra `register-tools.ts`, ordenadas. Una herramienta nueva se
 *  añade aquí Y en `test/fixtures/tool-names.ts` (un test compara ambas listas). */
export const CAPABILITY_TOOLS: readonly string[] = [
  'hebra_append_to_note',
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
  'hebra_restore_note',
  'hebra_restore_version',
  'hebra_search',
  'hebra_set_archived',
  'hebra_set_favorite',
  'hebra_status',
  'hebra_trash_note'
];

/** Lo que este servidor NO hace (D2, SPEC.md §5), por si un cliente lo intenta. */
const NOT_ALLOWED = [
  'purge_notes_or_empty_trash_or_irreversible_delete',
  'folder_management',
  'attachment_writes'
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
    /** Adjuntos en solo lectura: bytes descifrados por adjunto. */
    attachmentBytes: number;
    /** `hebra_read_attachment` de texto: máximo de caracteres por tramo (`maxChars`). */
    attachmentTextChars: number;
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
      attachmentTextChars: ATTACHMENT_TEXT_MAX_CHARS
    },
    notAllowed: [...NOT_ALLOWED],
    privacyConfigured: privacy.privateFolders.length > 0 || privacy.privateTags.length > 0
  };
}

/** `instructions` del servidor MCP (van en `initialize`): fijas, sin datos de la biblioteca. */
export const SERVER_INSTRUCTIONS = [
  'Hebra es una biblioteca de notas Markdown. Este servidor la lee, busca, crea, edita y organiza (mover, favorita, archivar), y manda notas a la papelera y las saca (reversible).',
  'Versiones anteriores de una nota (hebra_list_versions, hebra_read_version): solo las de este dispositivo; hebra_restore_version es una edición nueva y pide `expectedRevision` y un operationId nuevo.',
  'Las listas (hebra_search, hebra_list_notes, hebra_links, hebra_list_tags, hebra_list_folders, hebra_list_trash, hebra_list_versions, hebra_list_attachments) aceptan `limit` y `cursor`; pasa el `nextCursor` recibido para la página siguiente, que es null al final.',
  'hebra_search y hebra_list_notes aceptan `fields` para pedir solo algunos campos.',
  'Para editar: lee con hebra_read_note, usa su `revision` como expectedRevision en hebra_edit_note y un operationId nuevo por edición.',
  'No permite purgar notas, vaciar la papelera ni borrar de forma irreversible, ni gestionar carpetas, ni añadir, cambiar o borrar adjuntos (los adjuntos solo se leen: hebra_list_attachments, hebra_read_attachment). Algunas notas pueden no estar disponibles por la configuración de privacidad del dueño; se comportan como si no existieran.',
  'hebra_status devuelve el estado del sync y `capabilities` (versión, herramientas y límites).'
].join('\n');
