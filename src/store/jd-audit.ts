/**
 * `hebra_jd_audit` (D18, SPEC.md §5): la auditoría del motor JD de jdex-manager
 * (`auditSystem`, `../jd.ts`) sobre lo VISIBLE de la biblioteca, en solo lectura y en la
 * instancia que recibe la llamada (lector o escritor: no escribe nada). Lo privado no existe
 * para el MCP: el estado se construye con el `LibraryPort` de `./jd-port.ts` y el filtro de
 * privados de la llamada, así que ningún hallazgo, mensaje ni recuento nombra ni cuenta lo
 * oculto.
 *
 * Lo que el motor necesita y Hebra no da tal cual, y cómo queda:
 * - La lista de ficheros de cada carpeta (`filePaths`): solo se construye para las carpetas
 *   que el motor mira por dentro (los números de gestión `.00` y `.02` a `.08` y las
 *   cabeceras), con sus subcarpetas: notas visibles (`Título.md`, con el nombre de fichero
 *   de Hebra) y ficheros sueltos visibles y vivos. Con eso salen `reserved-used-as-content`
 *   y `header-with-files`.
 * - El frontmatter YAML de cada nota del JDex: hebra-mcp no tiene un analizador de YAML (B4
 *   de D15) y el motor exige los tipos de YAML (`jd: 21.20` sin comillas es un número). Solo
 *   se le da `tipo` (de las propiedades que deriva Hebra), para que un ID retirado
 *   (`tipo: archivado`) no salga como nota sin carpeta, y se quitan de la salida
 *   `frontmatter-mismatch` y `missing-description`, que dependen del resto
 *   (`JD_AUDIT_NOT_CHECKED`).
 * - Fuera también `inbox-stale` (la fecha de cada fichero del inbox) y `missing-folder` (las
 *   carpetas configuradas del plugin: aquí se detectan, siempre existen).
 * Los arreglos (`fix`) no salen: el MCP no los aplica.
 */
import { deriveNote } from '../hebra';
import {
  auditSystem,
  countProblems,
  isHeader,
  isReserved,
  loadLibraryState,
  parseJdNumber,
  patternFor,
  portNoteFileStem,
  resolveSettings,
  type Finding,
  type FindingKind,
  type NoteMeta
} from '../jd';
import type { PrivacyConfig } from '../privacy/config';
import { FileFilter } from '../privacy/file-filter';
import type { PrivacyFilter } from '../privacy/filter';
import { isJdexFolderCandidate, JdLibraryPort } from './jd-port';
import type { HebraLibraryPort } from './types';
import type { NoteRow } from '../hebra';
import { jdRejected, type JdFolderView } from './jd-new-id';

/** Lo que esta auditoría no comprueba (ver la cabecera). */
export const JD_AUDIT_NOT_CHECKED: readonly FindingKind[] = [
  'frontmatter-mismatch',
  'missing-description',
  'inbox-stale',
  'missing-folder'
];

/** Un hallazgo como se enseña: sin el arreglo. */
export interface JdAuditFinding {
  kind: FindingKind;
  number?: string;
  paths: string[];
  message: string;
  informative?: true;
}

export interface JdAuditResult {
  resolved: { jdex: JdFolderView; templates: JdFolderView | null };
  /** Todos los hallazgos, en el orden del motor (la herramienta los pagina). */
  findings: JdAuditFinding[];
  /** Los que cuentan como problema (sin los informativos), de todos. */
  problems: number;
}

export interface JdAuditOptions {
  jdexFolderId?: string;
  templatesFolderId?: string;
}

/** ¿Mira el motor dentro de esta carpeta de ID? Las cabeceras y los números de gestión
 *  salvo `.01` (inbox) y `.09` (archivo), como `auditSystem`. */
function inspectedInside(id: string, label: string): boolean {
  if (isHeader(label)) return true;
  const number = parseJdNumber(id);
  return number?.kind === 'id' && isReserved(number) && !['01', '09'].includes(number.id.split('.')[1]!);
}

/**
 * La auditoría (ver la cabecera), con el filtro y la configuración de la llamada. Los
 * errores del motor al resolver las carpetas (`jdex_not_found`, `templates_not_found`) se
 * lanzan como rechazos con ese código.
 */
export async function runJdAudit(
  port: HebraLibraryPort,
  filter: PrivacyFilter,
  privacy: PrivacyConfig,
  options: JdAuditOptions = {}
): Promise<JdAuditResult> {
  const rows = new Map<string, Promise<NoteRow | null>>();
  const jd = new JdLibraryPort(
    {
      folders: () => port.foldersList(),
      notes: () => port.notesVisibilityIndex(),
      noteRead: (id) => {
        let row = rows.get(id);
        if (!row) {
          row = port.noteRead(id);
          rows.set(id, row);
        }
        return row;
      },
      filter: () => filter
    },
    null
  );
  // Como al crear: solo una `00.00` visible vale como JDex indicado (`isJdexFolderCandidate`).
  if (options.jdexFolderId !== undefined && !isJdexFolderCandidate(filter, options.jdexFolderId)) {
    throw jdRejected('jdex_not_found');
  }
  const resolved = await resolveSettings(jd, options);
  if (!resolved.ok) throw jdRejected(resolved.code);
  const state = await loadLibraryState(jd, resolved.value);
  const { settings } = state.resolved;

  // Notas del JDex: solo `tipo` del frontmatter (ver la cabecera).
  const notes: NoteMeta[] = [];
  for (const note of state.jdexNotes) {
    const { body } = await jd.readNote(note.id);
    if (body === null) continue;
    const tipo = (deriveNote(body).props ?? []).find((prop) => prop.key.toLowerCase() === 'tipo')?.value;
    notes.push({ path: note.path, frontmatter: tipo === undefined ? null : { tipo } });
  }

  // Ficheros de las carpetas que el motor mira por dentro, con sus subcarpetas.
  const roots = state.index.ids
    .filter((entry) => entry.folderPath !== undefined && inspectedInside(entry.id, entry.label))
    .map((entry) => entry.folderPath!);
  const inspected = state.folders.filter((folder) =>
    roots.some((root) => folder.path === root || folder.path.startsWith(`${root}/`))
  );
  const filePaths: string[] = [];
  if (inspected.length > 0) {
    const files = await FileFilter.build(port, filter, privacy);
    const byId = new Map(inspected.map((folder) => [folder.id, folder.path]));
    for (const folder of inspected) {
      for (const note of await jd.listNotes(folder.id)) {
        filePaths.push(`${folder.path}/${portNoteFileStem(note.title)}.md`);
      }
    }
    for (const file of files.visibleFiles()) {
      const path = file.trashedAt === null ? byId.get(file.folderId) : undefined;
      if (path !== undefined) filePaths.push(`${path}/${file.name}`);
    }
  }

  const found: Finding[] = auditSystem({
    index: state.index,
    jdexFolder: state.resolved.jdex.path,
    notes,
    filePaths,
    folderPaths: state.folders.map((folder) => folder.path),
    patternFor: (category) => patternFor(settings, category),
    options: {
      noteWithoutFolderIsFinding: settings.noteWithoutFolderIsFinding,
      descriptionIsFinding: false,
      structureNotesAreFindings: settings.structureNotesAreFindings
    }
  });
  const shown = found.filter((finding) => !JD_AUDIT_NOT_CHECKED.includes(finding.kind));
  return {
    resolved: {
      jdex: { id: state.resolved.jdex.id, name: state.resolved.jdex.name },
      templates: state.resolved.templates
        ? { id: state.resolved.templates.id, name: state.resolved.templates.name }
        : null
    },
    findings: shown.map((finding) => ({
      kind: finding.kind,
      ...(finding.number !== undefined ? { number: finding.number } : {}),
      paths: [...finding.paths],
      message: finding.message,
      ...(finding.informative ? { informative: true as const } : {})
    })),
    problems: countProblems(shown)
  };
}
