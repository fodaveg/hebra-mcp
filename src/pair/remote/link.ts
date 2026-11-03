import {
  DeviceLinkRequester,
  HttpDeviceLinkTransport,
  HttpLibraryTransport,
  verifyGrantedAccess,
  type DeviceLinkPoll,
  type DeviceLinkVaultPage,
  type GrantedAccessPreview,
  type LumbreConnection
} from '../../hebra';
import type { Fetcher } from '../lumbre';
import { LINK_PLATFORM } from '../device-link';

function reader(connection: LumbreConnection, fetcher: Fetcher) {
  const transport = new HttpLibraryTransport(async () => connection, fetcher);
  return async (syncVaultId: string, since: number, limit: number): Promise<DeviceLinkVaultPage> => {
    const page = await transport.getChanges(syncVaultId, since, limit);
    return { records: page.records, next: page.next, more: page.more };
  };
}

export interface RemoteLinkRequest {
  readonly createdAt: string;
  readonly initialRemainingMs: number;
  poll(): Promise<DeviceLinkPoll>;
  verify(granted: Extract<DeviceLinkPoll, { kind: 'granted' }>): Promise<GrantedAccessPreview>;
  complete(): Promise<void>;
  cancel(): Promise<void>;
}

export async function startRemoteLink(input: {
  connection: LumbreConnection;
  label: string;
  fetcher: Fetcher;
}): Promise<RemoteLinkRequest> {
  const transport = new HttpDeviceLinkTransport({ get: async () => input.connection }, input.fetcher);
  const requester = await DeviceLinkRequester.start(transport, {
    label: input.label,
    platform: LINK_PLATFORM
  });
  return {
    createdAt: requester.createdAt,
    initialRemainingMs: requester.initialRemainingMs,
    poll: () => requester.poll(),
    verify: (granted) => verifyGrantedAccess({
      recoveryCode: granted.recoveryCode,
      apiOrigin: input.connection.apiOrigin,
      requestCreatedAt: requester.createdAt,
      approverSyncVaultId: granted.approverSyncVaultId,
      approverVaultCreatedAt: granted.approverVaultCreatedAt,
      vaultCount: granted.vaultCount,
      readChanges: reader(input.connection, input.fetcher)
    }),
    complete: () => requester.complete(),
    cancel: () => requester.cancel()
  };
}
