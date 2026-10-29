/** H-L7: límite de revocar una descarga que ya ocurrió. Solo claves efímeras de prueba. */
import { expect, it } from 'vitest';
import { deriveRecordKey } from '../../vendor/hebra/src/lib/library/envelope';
import { decodeReservedEnvelope, encodeReservedEnvelope } from '../../vendor/hebra/src/lib/library/reserved-sync';
import {
  ACCOUNT_KEY_RECORD_ID, accountKeyDocData, accountKeyringFromDoc,
  generateAccountKeyEntry, parseAccountKeyDoc
} from '../../vendor/hebra/src/lib/spaces/account-key';
import { openSpaceKeyEnvelope, wrapSpaceKey } from '../../vendor/hebra/src/lib/spaces/space-key-envelope';

it('el cifrado personal ya recibido permite abrir la privada y un sobre antiguo sin nueva red', async () => {
  const personalKey = crypto.getRandomValues(new Uint8Array(32));
  const syncVaultId = 'e5'.repeat(16);
  const recordKey = await deriveRecordKey({ vaultKey: personalKey, syncVaultId, keyEpoch: 1 });
  const entry = await generateAccountKeyEntry();
  const doc = { schema: 1 as const, keys: [entry] };
  const owner = await accountKeyringFromDoc(doc);
  // El sobre v1 llama spaceId al syncVaultId (32 hex), no al UUID del espacio.
  const spaceId = 'd0'.repeat(16);
  const recipient = { type: 'member' as const, id: 'b7'.repeat(32) };
  const spaceKey = crypto.getRandomValues(new Uint8Array(32));
  const oldSpaceEnvelope = await wrapSpaceKey({
    spaceId, recipient, spaceKey, recipientPublicJwk: owner.currentPublicJwk
  });
  // Este snapshot representa SOLO el material que un relé antiguo ya hubiera entregado.
  // No afirma que ninguna cuenta real lo recibiera ni que hoy pueda pedir sobres nuevos.
  const oldPersonalEnvelope = await encodeReservedEnvelope({
    recordKey, syncVaultId, recordId: ACCOUNT_KEY_RECORD_ID, data: accountKeyDocData(doc)
  });
  const decoded = await decodeReservedEnvelope({
    recordKey, syncVaultId, recordId: ACCOUNT_KEY_RECORD_ID, envelope: oldPersonalEnvelope
  });
  const recovered = await accountKeyringFromDoc(await parseAccountKeyDoc(decoded));
  const opened = await openSpaceKeyEnvelope({
    envelope: oldSpaceEnvelope, spaceId, recipient, keyring: recovered
  });
  // Booleano: una regresión no vuelca bytes de claves en el diff del test.
  expect(opened.every((byte, index) => byte === spaceKey[index])).toBe(true);
});
