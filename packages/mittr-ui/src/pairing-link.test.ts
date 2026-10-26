import { describe, expect, test } from 'bun:test';

import { parseConnectionPayload } from '../../ui/src/apps/mobileQrScan';
import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  parsePairingConnectionPayloadString,
} from '../../ui/src/lib/connectionPayload';

// The pairing link is a wire contract with the mobile apps, which only know
// upstream's scheme. MittrCraft keeps it as is until a branded mobile client
// ships; the brand files must not rename it (see scripts/mittr tests).
describe('a desktop pairing link', () => {
  const payload = buildPairingConnectionPayload({
    pairingId: 'pair_0123456789',
    secret: 'secret_abcdefghij',
    label: 'MittrCraft Dev',
    candidates: [{ type: 'lan', url: 'http://192.168.1.20:57133', priority: 0 }],
  });
  const link = encodePairingConnectionPayload(payload);

  test('is built on the mobile wire scheme', () => {
    expect(link.startsWith('openchamber://connect?')).toBe(true);
  });

  test('passes the mobile gate that QR scans and pasted links go through', () => {
    expect(parseConnectionPayload(link)).toEqual({ pairing: payload });
  });

  test('is imported back by the desktop, with and without URL parsing', () => {
    expect(parsePairingConnectionPayload(link)).toEqual(payload);
    expect(parsePairingConnectionPayloadString(link)).toEqual(payload);
  });
});
