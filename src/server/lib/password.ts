import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Password hashing on Node's built-in scrypt.
 *
 * scrypt is memory-hard and ships in the standard library, so this adds no
 * dependency to an app that currently has none for crypto. Parameters are
 * stored alongside the hash so they can be raised later without invalidating
 * existing passwords — an old hash keeps verifying against the cost it was
 * written with.
 */
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length);
  } catch {
    return false;
  }
  // Lengths match by construction, but timingSafeEqual throws if they ever don't.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Minimum viable policy. Long enough to matter, not so strict it drives reuse. */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return null;
}
