import { describe, expect, it } from 'vitest';
import {
  generateAgentToken,
  generatePairingCode,
  hashPassword,
  isPairingCodeExpired,
  sha256Hex,
  verifyAgentToken,
  verifyPassword,
} from '../../src/lib/crypto';

describe('crypto helpers', () => {
  it('sha256Hex matches the known SHA-256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agent token verifies against its stored hash only', () => {
    const token = generateAgentToken();
    const hash = sha256Hex(token);
    expect(verifyAgentToken(token, hash)).toBe(true);
    expect(verifyAgentToken('wrong-token', hash)).toBe(false);
    expect(verifyAgentToken(token, null)).toBe(false);
    expect(verifyAgentToken('', hash)).toBe(false);
  });

  it('generated tokens are unique', () => {
    expect(generateAgentToken()).not.toBe(generateAgentToken());
  });

  it('pairing codes have the XXXX-XXXX unambiguous format', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generatePairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('pairing expiry: expired timestamp or used code is unusable', () => {
    const now = new Date('2026-11-26T10:00:00Z');
    expect(isPairingCodeExpired(new Date(now.getTime() - 1000), null, now)).toBe(true);
    expect(isPairingCodeExpired(new Date(now.getTime() + 60_000), new Date(now), now)).toBe(true);
    expect(isPairingCodeExpired(new Date(now.getTime() + 60_000), null, now)).toBe(false);
  });

  it('password hash/verify roundtrip with scrypt', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
    await expect(verifyPassword('anything', 'not-a-real-hash')).resolves.toBe(false);
  });
});
