/**
 * La base de los planes JD (`src/store/jd-plans.ts`) al llegar D19: una `jd-plans.sqlite` de
 * D18 (sin `kind` ni `applied_at`) gana las columnas al abrir y sus planes siguen valiendo como
 * de `hebra_jd_new_id`; un plan aplicado de mover se guarda 7 días y no cuenta para el tope de
 * los sin aplicar.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JD_MOVE_UNDO_RETENTION_MS,
  JD_PLAN_KEEP_MS,
  JD_PLANS_SQLITE_FILE,
  JD_STORED_PLANS_MAX,
  openJdPlansDatabase,
  sqliteJdPlanStore
} from '../../src/store/jd-plans';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function libraryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hebra-mcp-jd-plans-'));
  dirs.push(dir);
  return join(dir, 'library.sqlite');
}

describe('jd-plans.sqlite (D18, D19)', () => {
  it('una base de D18 gana kind y applied_at, y su plan sigue siendo de hebra_jd_new_id', () => {
    const library = libraryPath();
    const old = new DatabaseSync(join(library, '..', JD_PLANS_SQLITE_FILE));
    old.exec(`CREATE TABLE hebra_mcp_jd_plans (plan_id TEXT PRIMARY KEY, library_id TEXT NOT NULL,
      privacy_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, plan TEXT NOT NULL)`);
    old.prepare('INSERT INTO hebra_mcp_jd_plans VALUES (?, ?, ?, ?, ?)').run('p1', 'lib', 'sha', Date.now(), '{"a":1}');
    old.close();
    const db = openJdPlansDatabase(library);
    try {
      const store = sqliteJdPlanStore(db);
      expect(store.get('p1')).toMatchObject({ planId: 'p1', kind: 'new_id', appliedAt: null, plan: { a: 1 } });
    } finally {
      db.close();
    }
  });

  it('un plan aplicado dura 7 días y no cuenta para el tope; uno sin aplicar, un día', () => {
    const db = openJdPlansDatabase(libraryPath());
    try {
      const store = sqliteJdPlanStore(db);
      const now = Date.now();
      const base = { libraryId: 'lib', privacySha256: 'sha', plan: {} };
      store.insert({ ...base, planId: 'applied', createdAt: now - 2 * JD_PLAN_KEEP_MS, kind: 'move' });
      store.markApplied('applied', now - JD_PLAN_KEEP_MS - 1);
      store.insert({ ...base, planId: 'old', createdAt: now - JD_PLAN_KEEP_MS - 1, kind: 'move' });
      store.purgeExpired(now);
      expect(store.get('applied')?.appliedAt).not.toBeNull();
      expect(store.get('old')).toBeNull();
      // El tope solo echa planes sin aplicar.
      for (let i = 0; i < JD_STORED_PLANS_MAX + 1; i += 1) {
        store.insert({ ...base, planId: `p${i}`, createdAt: now + i, kind: 'new_id' });
      }
      expect(store.get('applied')).not.toBeNull();
      expect(store.get('p0')).toBeNull();
      // Descartar no borra uno aplicado, ni uno de la otra herramienta.
      store.delete('applied', 'move');
      expect(store.get('applied')).not.toBeNull();
      const last = `p${JD_STORED_PLANS_MAX}`;
      store.delete(last, 'move');
      expect(store.get(last)).not.toBeNull();
      store.delete(last, 'new_id');
      expect(store.get(last)).toBeNull();
      store.purgeExpired(now + JD_MOVE_UNDO_RETENTION_MS);
      expect(store.get('applied')).toBeNull();
    } finally {
      db.close();
    }
  });
});
