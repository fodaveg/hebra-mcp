/**
 * Biblioteca de M1 (revisión de seguridad del plan de memoria, 6 nov 2026): `hebra_grep` y
 * `hebra_replace_in_notes` sin `ids` sueltan del filtro lo ya decidido (`PrivacyFilter.forget`),
 * y tienen que responder igual que cargando la biblioteca entera. Sobre la de siempre
 * (`auditHarness`, `AUDIT_CONFIG`: carpeta `Diario` y etiqueta `secreto` privadas), con más notas
 * que los dos primeros tramos de `hebra_grep` (128 y 256) y que varios lotes de 64:
 * - `Lote` (pública): `LOTE_VISIBLE` notas visibles con `remolacha N` y `#huerta`; las de rango
 *   PAR por id llevan además `Q7` (dos letras: sin prefiltro de subcadena), así que en el primer
 *   lote de 64 la última recorrida (rango 63) no es la de la última coincidencia (rango 62).
 * - Ocultas con lo mismo: en `Lote` con `#secreto`, con `#secreto/hondo` y bloqueadas (A1); en
 *   `Diario` (carpeta privada); bajo una subcarpeta de `Diario` ya lápida (A2, oculta), y en la
 *   papelera.
 * - Bajo `SubPublica` (en la raíz), ya lápida: visibles (A2, se suben hasta la raíz).
 * - `aguja_rara` en una visible de la raíz y en una oculta por etiqueta: el patrón raro que
 *   recorre todos los tramos.
 */
import { legacyFolderTombstone } from './test-library';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from '../privacy/audit-harness';

export const LOTE_VISIBLE = 260;
export const RARE = 'aguja_rara';

export interface ForgetLibrary {
  /** Las visibles de `Lote`, ordenadas por id (el orden de `hebra_grep`). */
  loteVisible: string[];
  /** Las visibles bajo la lápida pública. */
  underDeletedPublic: string[];
  /** Todas las vivas ocultas de este escenario. */
  hidden: string[];
  trashed: string[];
  rareVisible: string;
}

function byId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function forgetLibraryHarness(): Promise<AuditHarness<ForgetLibrary>> {
  return auditHarness<ForgetLibrary>(async (engine, library) => {
    const lote = await engine.folderCreate(null, 'Lote');
    const out: ForgetLibrary = { loteVisible: [], underDeletedPublic: [], hidden: [], trashed: [], rareVisible: '' };
    const body = (title: string, index: number, extra = ''): string =>
      `# ${title} ${index}\n#huerta${extra}\nremolacha ${index}\n`;

    for (let index = 0; index < LOTE_VISIBLE; index += 1) {
      out.loteVisible.push((await createNote(engine, lote.id, body('Lote', index))).id);
    }
    out.loteVisible.sort(byId);
    // `Q7` en las de rango par por id.
    for (let rank = 0; rank < out.loteVisible.length; rank += 2) {
      await saveBody(engine, out.loteVisible[rank]!, `${body('Lote', rank)}Q7 par\n`);
    }

    for (let index = 0; index < 60; index += 1) {
      out.hidden.push((await createNote(engine, lote.id, `${body('Secreta', index, '\n#secreto')}Q7\n`)).id);
    }
    for (let index = 0; index < 30; index += 1) {
      out.hidden.push((await createNote(engine, lote.id, `${body('Honda', index, '\n#secreto/hondo')}Q7\n`)).id);
    }
    for (let index = 0; index < 30; index += 1) {
      const note = await createNote(engine, lote.id, body('Bloqueada', index));
      await saveBody(engine, note.id, lockedBody(`Bloqueada ${index}`, []));
      out.hidden.push(note.id);
    }
    for (let index = 0; index < 30; index += 1) {
      out.hidden.push((await createNote(engine, library.folders.diario2026, `${body('Diario', index)}Q7\n`)).id);
    }
    const privateSub = await engine.folderCreate(library.folders.diario, 'SubPrivadaM1');
    for (let index = 0; index < 15; index += 1) {
      out.hidden.push((await createNote(engine, privateSub.id, body('LapidaPrivada', index))).id);
    }
    await legacyFolderTombstone(engine, privateSub.id);
    const publicSub = await engine.folderCreate(null, 'SubPublica');
    for (let index = 0; index < 15; index += 1) {
      out.underDeletedPublic.push((await createNote(engine, publicSub.id, body('LapidaPublica', index))).id);
    }
    await legacyFolderTombstone(engine, publicSub.id);
    for (let index = 0; index < 20; index += 1) {
      const note = await createNote(engine, lote.id, `${body('Papelera', index)}${RARE}\n`);
      await engine.noteTrash(note.id);
      out.trashed.push(note.id);
    }
    out.rareVisible = (await createNote(engine, null, `# Rara visible\n${RARE}\n`)).id;
    out.hidden.push((await createNote(engine, null, `# Rara oculta\n#secreto\n${RARE}\n`)).id);
    return out;
  }, AUDIT_CONFIG);
}
