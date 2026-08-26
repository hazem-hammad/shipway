import { describe, expect, it } from 'vitest';
import { hashAuthPassword, isValidAuthUser, renderHtpasswd } from '../src/system/htpasswd.js';

describe('isValidAuthUser', () => {
  it('accepts ordinary usernames', () => {
    for (const user of ['client', 'go-digital', 'a.b_c', 'user@example.com', 'A1']) {
      expect(isValidAuthUser(user), user).toBe(true);
    }
  });

  it('rejects anything that could break the user:hash line or the config', () => {
    for (const user of ['', 'has space', 'colon:here', 'new\nline', 'sl/ash', 'a'.repeat(65)]) {
      expect(isValidAuthUser(user), JSON.stringify(user)).toBe(false);
    }
  });
});

describe('renderHtpasswd', () => {
  it('renders a single user:hash line with a trailing newline', () => {
    expect(renderHtpasswd('client', '$apr1$abc$def')).toBe('client:$apr1$abc$def\n');
  });

  it('throws rather than emitting a malformed file', () => {
    expect(() => renderHtpasswd('bad user', '$apr1$x')).toThrow(/invalid basic-auth user/);
    expect(() => renderHtpasswd('client', 'has:colon')).toThrow(/invalid basic-auth hash/);
    expect(() => renderHtpasswd('client', 'has\nnewline')).toThrow(/invalid basic-auth hash/);
  });
});

describe('hashAuthPassword', () => {
  it('produces an apr1 crypt string — the format nginx implements internally', async () => {
    const hash = await hashAuthPassword('hunter2');
    expect(hash).toMatch(/^\$apr1\$[./A-Za-z0-9]{1,8}\$[./A-Za-z0-9]{22}$/);
  });

  it('salts: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashAuthPassword('hunter2'), hashAuthPassword('hunter2')]);
    expect(a).not.toBe(b);
  });

  it('rejects an empty password', async () => {
    await expect(hashAuthPassword('')).rejects.toThrow(/must not be empty/);
  });
});
