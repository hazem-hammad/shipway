import * as argon2 from 'argon2';

/** Hashes `password` with argon2id (argon2's default variant), returning a PHC-formatted digest. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

/**
 * Verifies `password` against a PHC-formatted argon2 `hash`. Returns `false` for a mismatch or for
 * a malformed/foreign hash rather than throwing, so callers can treat it as a plain boolean check.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
