import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { runStatus } from '../../src/server/tools/status';
import { AGENT_REVOKED_REASON } from '../../src/status/pairing-revocation';

describe('hebra_status', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('L1: linked false y campos de sync a null (SPEC.md §10 L1)', async () => {
    test = await buildTestContext();
    const { capabilities, ...status } = await runStatus(test.ctx);
    expect(capabilities.server.name).toBe('hebra-mcp');
    expect(status).toEqual({
      linked: false,
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: null,
      errorsByCode: null,
      writer: null,
      revoked: null
    });
  });

  it('D24: con revoked y sin otro motivo, el del agente revocado o desactivado desde Hebra', async () => {
    test = await buildTestContext();
    const revoked = { linked: true, lastSyncAt: null, lastSyncOutcome: 'http_401', pendingUpload: 0,
      errorsByCode: {}, writer: 'this' as const, revoked: true };
    const { revokedReason } = await runStatus({ ...test.ctx, status: { getStatus: () => revoked } });
    expect(revokedReason).toBe(AGENT_REVOKED_REASON);
    expect(revokedReason).toContain('revocado o desactivado desde Hebra');
    expect(revokedReason).toContain('lo vuelve a intentar solo');
    expect(revokedReason).toContain('Ajustes de Hebra');
    expect(revokedReason).toContain('sin reiniciar ni volver a emparejar');
    expect(revokedReason).not.toContain('hebra-mcp pair');
    // Castellano llano: sin rayas largas, puntos centrados ni comillas latinas.
    expect(revokedReason).not.toMatch(/[—·«»]/u);
    // Sin revocar, sin motivo.
    const fine = await runStatus({ ...test.ctx, status: { getStatus: () => ({ ...revoked, revoked: false }) } });
    expect(fine).not.toHaveProperty('revokedReason');
  });
});
