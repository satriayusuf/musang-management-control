import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Generate an application-level id with a domain prefix, e.g. agt_…, ses_…, cmd_… */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** sha256 hex digest — used for agent tokens and pairing codes at rest. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Verify a raw agent token against the stored sha256 hash. */
export function verifyAgentToken(rawToken: string, storedHash: string | null): boolean {
  if (!rawToken || !storedHash) return false;
  return hashEquals(sha256Hex(rawToken), storedHash);
}

/** Generate a new raw agent token (only ever returned once, at registration). */
export function generateAgentToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Generate a human-typable one-time pairing code, e.g. "K7QX-4MZD". */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

/** True when a pairing code can no longer be used (expired or already used). */
export function isPairingCodeExpired(expiresAt: Date, usedAt: Date | null, now: Date = new Date()): boolean {
  if (usedAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

// --- Password hashing (scrypt, node:crypto — no native deps) ---

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

/** Hash a password as `scrypt$N$r$p$<salt b64>$<hash b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Verify a password against a stored scrypt hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = (await scryptAsync(password, salt, expected.length, { N, r, p })) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
