/**
 * Listener loopback del emparejado (SPEC.md §7.1): una obligación de la auditoría de
 * Lumbre por test. La (1) (`apiOrigin` falso ignorado) y la (6) (canje sin `Origin`) se
 * prueban aquí en su parte local y de punta a punta en `pair-flow.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOOPBACK_HOST,
  LoopbackError,
  openLoopbackListener,
  type LoopbackListener
} from '../../src/pair/loopback';

const CODE = 'ab'.repeat(32);

async function refused(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

describe('listener loopback', () => {
  let listener: LoopbackListener | undefined;
  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  it('(5) escucha en la IP literal 127.0.0.1, nunca en localhost', async () => {
    listener = await openLoopbackListener();
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    expect(listener.webOrigin).toBe(`http://127.0.0.1:${listener.port}`);
    expect(listener.webOrigin).not.toContain('localhost');
    const response = await fetch(`http://127.0.0.1:${listener.port}/otra`);
    expect(response.status).toBe(404);
  });

  it('(2) rechaza un code que no es hex de 64 y sigue escuchando', async () => {
    listener = await openLoopbackListener();
    const base = `${listener.webOrigin}/lumbre/connect`;
    for (const bad of ['xyz', 'AB'.repeat(32), 'ab'.repeat(31), `${CODE}0`, `${CODE}&code=${CODE}`]) {
      const response = await fetch(`${base}?code=${bad}`);
      expect(response.status).toBe(400);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect((await fetch(base)).status).toBe(400);
    expect((await fetch(`${base}?code=${CODE}`, { method: 'POST' })).status).toBe(405);
    // Sigue vivo: el código bueno llega después.
    const ok = await fetch(`${base}?code=${CODE}`);
    expect(ok.status).toBe(200);
    await expect(listener.code).resolves.toBe(CODE);
  });

  it('(1) ignora el apiOrigin de la query: solo entrega el código', async () => {
    listener = await openLoopbackListener();
    const response = await fetch(
      `${listener.webOrigin}/lumbre/connect?code=${CODE}&apiOrigin=${encodeURIComponent('https://evil.test')}`
    );
    expect(response.status).toBe(200);
    // `code` es una cadena: no hay ningún origen que quien lo recibe pueda usar.
    await expect(listener.code).resolves.toBe(CODE);
    expect(await response.text()).not.toContain('evil.test');
  });

  it('(3) una sola respuesta, no-referrer, sin recursos externos, y cierra el listener', async () => {
    listener = await openLoopbackListener();
    const url = `${listener.webOrigin}/lumbre/connect?code=${CODE}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<(script|link|img|iframe|style)\b|src=|href=/i);
    await expect(listener.code).resolves.toBe(CODE);
    // Cerrado: ni una segunda respuesta ni una conexión nueva.
    expect(await refused(url)).toBe(true);
  });

  it('caduca: rechaza con expired y cierra', async () => {
    listener = await openLoopbackListener({ timeoutMs: 50 });
    const url = `${listener.webOrigin}/lumbre/connect?code=${CODE}`;
    const failure = await listener.code.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LoopbackError);
    expect((failure as LoopbackError).code).toBe('expired');
    expect(await refused(url)).toBe(true);
  });
});
