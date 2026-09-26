import { afterEach, describe, expect, it } from 'vitest';
import { buildTestContext, type TestContext } from '../fixtures/test-context';
import { runStatus } from '../../src/server/tools/status';

describe('hebra_status', () => {
  let test: TestContext | undefined;
  afterEach(async () => {
    await test?.close();
    test = undefined;
  });

  it('L1: linked false y campos de sync a null (SPEC.md §10 L1)', async () => {
    test = await buildTestContext();
    const status = await runStatus(test.ctx);
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
});
