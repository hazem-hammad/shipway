/**
 * Builds the single-line `auth_basic_user_file` content for a project's HTTP basic auth.
 *
 * apr1 (Apache MD5) is the hash format because nginx implements it internally, with no dependency
 * on the host's `crypt()` — a `$5$`/`$6$`/bcrypt hash would be stronger against offline cracking
 * but silently never matches on a build whose libc can't verify it, which fails as a lockout rather
 * than an error. Same choice setup/install.sh makes for the Mailpit htpasswd.
 *
 * The password is written to openssl's stdin rather than passed as an argument, so it never appears
 * in the process list.
 */
import { execFile } from 'node:child_process';

/** Rejects anything that would break the `user:hash` line format or the surrounding config. */
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;

export function isValidAuthUser(value: string): boolean {
  return USER_RE.test(value);
}

export async function hashAuthPassword(password: string): Promise<string> {
  if (password === '') {
    throw new Error('password must not be empty');
  }
  return new Promise((resolve, reject) => {
    const child = execFile('openssl', ['passwd', '-apr1', '-stdin'], (err, stdout) => {
      if (err) {
        reject(new Error(`failed to hash password: ${err.message}`));
        return;
      }
      const hash = stdout.trim();
      if (!hash.startsWith('$apr1$')) {
        reject(new Error('openssl produced an unexpected hash format'));
        return;
      }
      resolve(hash);
    });
    child.stdin?.end(`${password}\n`);
  });
}

/** `user:hash` plus a trailing newline — the whole htpasswd file for a project. */
export function renderHtpasswd(user: string, hash: string): string {
  if (!isValidAuthUser(user)) {
    throw new Error(`invalid basic-auth user: "${user}"`);
  }
  if (hash.includes('\n') || hash.includes(':')) {
    throw new Error('invalid basic-auth hash');
  }
  return `${user}:${hash}\n`;
}
