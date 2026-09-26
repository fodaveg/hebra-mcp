import { describe, it } from 'vitest';
import { SqliteLibraryEngine } from '../src/hebra';
import { openNodeSqliteConn } from '../src/store/sqlite-conn-node';
import { ALL_LIBRARY_CASES, MemoryBlobStore, runLibraryCase } from './hebra-testing';

/**
 * Casos compartidos del almacén (`vendor/hebra/src/lib/library/cases/library-cases.json`,
 * el mismo fichero que ejecutan `library-cases.test.ts` de Hebra contra sqlite-wasm y
 * `store/cases.rs` contra Rust; SPEC.md §10 L0), corridos aquí contra el adaptador
 * `node:sqlite` de `src/store/sqlite-conn-node.ts`.
 *
 * El dispatcher de cada operación (el switch por `step.op`) vive SOLO en Hebra, privado
 * (`cases/run-library-case.ts`), y `node-testing.ts` lo exporta ya corrido:
 * `runLibraryCase` (petición de hebra-mcp, `199c3d1d`). D5: antes este fichero tenía su
 * propia copia del switch, 90 de 112 líneas idénticas a las de Hebra; `hebra-mcp` es
 * público y Hebra no, así que no se repite (solo hacia delante: sin reescribir el
 * historial). `ALL_LIBRARY_CASES` es el mismo `library-cases.json`, ya parseado.
 *
 * `deviceLabel: 'Mac'` SOLO en esta fixture, porque el caso «sync §7 nota, fila 6»
 * compara `conflictDevice` con ese literal (lo trae `library-cases.json`, igual que lo
 * abre `library-cases.test.ts` de Hebra); el runtime de hebra-mcp declara 'Claude'
 * (L5, `src/store/node-port.ts`).
 */
describe('casos compartidos del almacén (adaptador node:sqlite)', () => {
  for (const testCase of ALL_LIBRARY_CASES) {
    it(testCase.name, async () => {
      const { conn } = openNodeSqliteConn(':memory:');
      const engine = await SqliteLibraryEngine.open(conn, 'Mac', { blobs: new MemoryBlobStore() });
      await runLibraryCase(engine, conn, testCase);
    });
  }
});
