/**
 * Biblioteca de las herramientas de listas perezosas (`privacyLoad: 'lazy'`, A4 del plan de
 * memoria, 6 nov 2026): `hebra_search`, `hebra_grep` y `hebra_list_notes`. Sobre la de siempre
 * (`auditHarness`, configuración `AUDIT_CONFIG`: carpeta `Diario`, etiqueta `secreto`) añade
 * notas que comparten la palabra `zanahoria` y la etiqueta `verdura`, mezcladas para que las
 * páginas del motor traigan notas ocultas entre las visibles:
 * - `Huerto` (pública): 24 notas; ocultas por `#secreto`, por `#secreto/personal` y bloqueadas
 *   (A1), y algunas visibles sin `#verdura`; con `estado: listo` y enlaces a `Destino zanahoria`
 *   repartidos entre visibles y ocultas.
 * - `Huerto/Bancal` (pública): 6, la mitad con `#secreto`.
 * - `Diario/2026` (privada): 6, todas con la palabra y `#verdura`.
 * - En la papelera: 3, una de ellas en `Huerto`.
 * - `Destino zanahoria`: una visible en la raíz y una homónima oculta por etiqueta; `Destino
 *   oculto`, solo en la carpeta privada.
 *
 * Cada caso de los tests se pasa por `expectLazyEquivalent` (`./privacy-load.ts`), que compara
 * con la misma llamada cargando la biblioteca entera.
 */
import type { PrivacyConfig } from '../../src/privacy';
import { AUDIT_CONFIG, auditHarness, createNote, lockedBody, saveBody, type AuditHarness } from '../privacy/audit-harness';

export const WORD = 'zanahoria';

export interface LazyLists {
  /** Las de `Huerto` y `Bancal` que se ven, con y sin `#verdura`. */
  visibleIds: Set<string>;
  /** Las vivas que no se ven (por etiqueta, bloqueadas, en la carpeta privada). */
  hiddenIds: Set<string>;
  /** Las de la papelera. */
  trashedIds: Set<string>;
  /** Las visibles con `#verdura` (de `Huerto` y `Bancal`). */
  visibleTaggedIds: Set<string>;
  /** Las visibles de `Huerto` (sin `Bancal`). */
  visibleHuertoIds: Set<string>;
  /** Las visibles con `estado: listo`. */
  visibleReadyIds: Set<string>;
  /** Las visibles que enlazan a `Destino zanahoria`. */
  visibleLinkingIds: Set<string>;
  destinoVisibleId: string;
}

/** Cómo es la nota `index` de `Huerto`. */
function huertoKind(index: number): 'tag' | 'subtag' | 'locked' | 'visible' {
  if (index % 6 === 3) return 'locked';
  if (index % 4 === 1) return 'tag';
  if (index % 4 === 2) return 'subtag';
  return 'visible';
}

export async function lazyListsHarness(config: PrivacyConfig = AUDIT_CONFIG): Promise<AuditHarness<LazyLists>> {
  return auditHarness<LazyLists>(async (engine, library) => {
    const out: LazyLists = {
      visibleIds: new Set(),
      hiddenIds: new Set(),
      trashedIds: new Set(),
      visibleTaggedIds: new Set(),
      visibleHuertoIds: new Set(),
      visibleReadyIds: new Set(),
      visibleLinkingIds: new Set(),
      destinoVisibleId: ''
    };
    const huerto = await engine.folderCreate(null, 'Huerto');
    const bancal = await engine.folderCreate(huerto.id, 'Bancal');

    const destino = await createNote(engine, null, '# Destino zanahoria\nEl destino que se ve.\n');
    out.destinoVisibleId = destino.id;
    out.hiddenIds.add((await createNote(engine, null, '# Destino zanahoria\n#secreto\nHomónima oculta.\n')).id);
    out.hiddenIds.add(
      (await createNote(engine, library.folders.diario2026, '# Destino oculto\nSolo en la privada.\n')).id
    );

    for (let index = 0; index < 24; index += 1) {
      const kind = huertoKind(index);
      const tagged = kind !== 'visible' || index % 5 !== 0;
      const ready = index % 3 === 0;
      const linking = index % 2 === 0;
      const lines = [
        ...(ready ? ['---', 'estado: listo', '---'] : []),
        `# Huerto ${index}`,
        ...(tagged ? ['#verdura'] : []),
        ...(kind === 'tag' ? ['#secreto'] : kind === 'subtag' ? ['#secreto/personal'] : []),
        `Línea con ${WORD} ${index}.`,
        ...(linking ? ['Ver [[Destino zanahoria]].'] : []),
        ...(index === 7 ? ['Y [[Destino oculto]].'] : []),
        `Otra ${WORD} más.`
      ];
      const note = await createNote(engine, huerto.id, `${lines.join('\n')}\n`);
      if (kind === 'locked') await saveBody(engine, note.id, lockedBody(`Huerto ${index} ${WORD}`, []));
      if (kind === 'visible') {
        out.visibleIds.add(note.id);
        out.visibleHuertoIds.add(note.id);
        if (tagged) out.visibleTaggedIds.add(note.id);
        if (ready) out.visibleReadyIds.add(note.id);
        if (linking) out.visibleLinkingIds.add(note.id);
      } else {
        out.hiddenIds.add(note.id);
      }
    }

    for (let index = 0; index < 6; index += 1) {
      const hidden = index % 2 === 1;
      const note = await createNote(
        engine,
        bancal.id,
        `# Bancal ${index}\n#verdura${hidden ? '\n#secreto' : ''}\n${WORD} del bancal ${index}.\n`
      );
      if (hidden) {
        out.hiddenIds.add(note.id);
      } else {
        out.visibleIds.add(note.id);
        out.visibleTaggedIds.add(note.id);
      }
    }

    for (let index = 0; index < 6; index += 1) {
      const note = await createNote(
        engine,
        library.folders.diario2026,
        `# Diario ${index}\n#verdura\n${WORD} privada ${index}.\nVer [[Destino zanahoria]].\n`
      );
      out.hiddenIds.add(note.id);
    }

    for (const [folderId, body] of [
      [huerto.id, `# Tirada del huerto\n#verdura\n${WORD} tirada.\n`],
      [null, `# Tirada raíz\n#verdura\n${WORD} tirada.\n`],
      [library.folders.diario2026, `# Tirada privada\n#verdura\n${WORD} tirada.\n`]
    ] as const) {
      const note = await createNote(engine, folderId, body);
      await engine.noteTrash(note.id);
      out.trashedIds.add(note.id);
    }
    return out;
  }, config);
}
