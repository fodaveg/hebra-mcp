/**
 * `openNodeLibraryPort` con `journalMode: 'WAL'` en el escritor y `SqliteLibraryEngine.
 * openReadOnly` en el lector (lote L6d, sobre `bb0f3d13` de Hebra): dos conexiones
 * `node:sqlite` de VERDAD sobre el MISMO fichero, sin pasar por `LibraryInstance` ni el
 * bloqueo de `src/lock/` (eso ya lo prueba `test/sync/writer-lock.node.test.ts`; aquí se
 * aísla el comportamiento de `src/store/node-port.ts` y `src/store/sqlite-conn-node.ts`).
 *
 * Tres cosas, en el orden en que fallarían si `sqlite-conn-node.ts` volviera a
 * interceptar pragmas o esquema a mano en vez de dejárselo al motor:
 * 1. El lector abre una base que YA creó el escritor (con su esquema) sin fallar con
 *    `attempt to write a readonly database`.
 * 2. Lo que el escritor confirma con `noteSave`, el lector lo ve sin reabrir la conexión
 *    (WAL: lecturas concurrentes con el escritor).
 * 3. Una escritura contra el lector rechaza con `busy_other_instance` (`StoreError`) ANTES
 *    de llegar al motor: `node:sqlite` en modo `readOnly` ni se prueba.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';

const ports: NodeLibraryPort[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('escritor WAL + lector de solo lectura sobre el mismo fichero', () => {
  it('el lector ve lo que el escritor confirma y no puede escribir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hebra-mcp-reader-writer-'));
    dirs.push(dataDir);
    const sqlitePath = join(dataDir, 'library.sqlite');

    const writer = await openNodeLibraryPort({ sqlitePath, dataDir });
    ports.push(writer);
    expect(writer.mode).toBe('readWrite');
    expect(writer.writable).toBe(true);

    const created = await writer.noteCreate(null);
    await writer.noteSave({
      id: created.id,
      body: '# Nota del escritor\n\nTexto original.',
      title: 'Nota del escritor',
      titleNorm: 'nota del escritor',
      excerpt: 'Texto original.',
      expectedLocalSeq: created.localSeq,
      baseBodySha256: created.bodySha256
    });

    // 1: el lector abre la base ya creada por el escritor, sin tocar pragmas ni esquema.
    const reader = await openNodeLibraryPort({ sqlitePath, dataDir, mode: 'readOnly' });
    ports.push(reader);
    expect(reader.mode).toBe('readOnly');
    expect(reader.writable).toBe(false);

    // 2: WAL, sin reabrir la conexión del lector.
    const seenByReader = await reader.noteRead(created.id);
    expect(seenByReader?.body).toBe('# Nota del escritor\n\nTexto original.');

    await writer.noteSave({
      id: created.id,
      body: '# Nota del escritor\n\nTexto ampliado por el escritor.',
      title: 'Nota del escritor',
      titleNorm: 'nota del escritor',
      excerpt: 'Texto ampliado por el escritor.',
      expectedLocalSeq: seenByReader!.localSeq,
      baseBodySha256: seenByReader!.bodySha256
    });
    const updatedForReader = await reader.noteRead(created.id);
    expect(updatedForReader?.body).toBe('# Nota del escritor\n\nTexto ampliado por el escritor.');

    // 3: una escritura contra el lector rechaza antes de tocar el motor.
    await expect(reader.noteCreate(null)).rejects.toMatchObject({ code: 'busy_other_instance' });
  });
});
