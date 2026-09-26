import { describe, expect, it } from 'vitest';
import { openNodeSqliteConn } from '../src/store/sqlite-conn-node';

/**
 * R3 de SPEC.md: diferencias de tipos entre `@sqlite.org/sqlite-wasm` (lo que espera
 * `sqlite-engine.ts`) y `node:sqlite` (lo que da de verdad el adaptador), medidas contra
 * el adaptador de `src/store/sqlite-conn-node.ts` directamente, sin pasar por el motor.
 */
describe('adaptador node:sqlite → SqliteConn (tipos, R3)', () => {
  it('exec sin bind ejecuta varias sentencias de una tirada (el esquema las trae así)', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER); INSERT INTO a VALUES (1);');
    expect(conn.selectValue('SELECT COUNT(*) FROM a')).toBe(1);
    expect(conn.selectValue("SELECT name FROM sqlite_master WHERE type='table' AND name='b'")).toBe(
      'b'
    );
  });

  it('exec CON bind es una sola sentencia, con parámetros posicionales ?1, ?2…', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, n INTEGER)');
    conn.exec('INSERT INTO t (id, n) VALUES (?1, ?2)', { bind: ['a', 1] });
    expect(conn.selectObject('SELECT * FROM t WHERE id = ?1', ['a'])).toEqual({ id: 'a', n: 1 });
  });

  it('un entero fuera de Number.MAX_SAFE_INTEGER no lanza: sale como Number con la misma pérdida de precisión que sqlite-wasm', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, big INTEGER)');
    // `node:sqlite` sin `readBigInts` lanzaría RangeError al leer esto; sqlite-wasm
    // jamás lanza (siempre da Number). El adaptador abre con `readBigInts: true` y
    // convierte cada bigint con `Number(...)`: mismo comportamiento observable.
    const huge = 9007199254740993n; // MAX_SAFE_INTEGER + 2, impar: fuerza a perder el bit bajo
    conn.exec('INSERT INTO t (id, big) VALUES (?1, ?2)', { bind: ['a', huge] });
    const row = conn.selectObject('SELECT * FROM t WHERE id = ?1', ['a'])!;
    expect(typeof row.big).toBe('number');
    expect(row.big).toBe(Number(huge));
  });

  it('un entero normal (timestamps, local_seq…) vuelve como Number, no BigInt', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, ts INTEGER)');
    const now = Date.now();
    conn.exec('INSERT INTO t (id, ts) VALUES (?1, ?2)', { bind: ['a', now] });
    const row = conn.selectObject('SELECT * FROM t WHERE id = ?1', ['a'])!;
    expect(typeof row.ts).toBe('number');
    expect(row.ts).toBe(now);
    // `Number(bigint) === 1` con `===` estricto es `false`; si el adaptador dejara
    // pasar un bigint tal cual, `fromBit`/`===` del motor (`sqlite-engine.ts`) romperían
    // en silencio. Aquí se comprueba que NUNCA llega un bigint a quien lee la fila.
    expect(typeof row.ts).not.toBe('bigint');
  });

  it('selectValue también normaliza bigint a Number', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (n INTEGER)');
    conn.exec('INSERT INTO t (n) VALUES (?1)', { bind: [42] });
    const value = conn.selectValue('SELECT n FROM t');
    expect(value).toBe(42);
    expect(typeof value).not.toBe('bigint');
  });

  it('las filas no tienen prototipo null: un spread o un JSON.stringify se comportan como con sqlite-wasm', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, n INTEGER)');
    conn.exec('INSERT INTO t (id, n) VALUES (?1, ?2)', { bind: ['a', 1] });
    const row = conn.selectObject('SELECT * FROM t WHERE id = ?1', ['a'])!;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect({ ...row }).toEqual({ id: 'a', n: 1 });
  });

  it('undefined en un bind se coacciona a NULL en vez de que node:sqlite lo rechace', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, opt TEXT)');
    conn.exec('INSERT INTO t (id, opt) VALUES (?1, ?2)', { bind: ['a', undefined] });
    expect(conn.selectObject('SELECT * FROM t WHERE id = ?1', ['a'])).toEqual({
      id: 'a',
      opt: null
    });
  });

  it('un booleano en un bind se coacciona a 0/1 en vez de que node:sqlite lo rechace', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT, flag INTEGER)');
    conn.exec('INSERT INTO t (id, flag) VALUES (?1, ?2)', { bind: ['a', true] });
    conn.exec('INSERT INTO t (id, flag) VALUES (?1, ?2)', { bind: ['b', false] });
    expect(conn.selectValue('SELECT flag FROM t WHERE id = ?1', ['a'])).toBe(1);
    expect(conn.selectValue('SELECT flag FROM t WHERE id = ?1', ['b'])).toBe(0);
  });

  it('selectObject/selectValue sin filas devuelven undefined, igual que sqlite-wasm', () => {
    const { conn } = openNodeSqliteConn(':memory:');
    conn.exec('CREATE TABLE t (id TEXT)');
    expect(conn.selectObject('SELECT * FROM t WHERE id = ?1', ['nope'])).toBeUndefined();
    expect(conn.selectValue('SELECT id FROM t WHERE id = ?1', ['nope'])).toBeUndefined();
    expect(conn.selectObjects('SELECT * FROM t')).toEqual([]);
  });
});
