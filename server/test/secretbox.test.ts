import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SecretBox } from '../src/lib/secretbox.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'secretbox-test-'));
}

describe('SecretBox', () => {
  it('round-trips plaintext (UTF-8 + multiline) through encrypt/decrypt', () => {
    const dir = tmpDir();
    const box = SecretBox.load(path.join(dir, 'secret.key'));
    const plaintext = 'hello\nmultiline 🚀 world\nこんにちは';

    const blob = box.encrypt(plaintext);
    const decrypted = box.decrypt(blob);

    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const dir = tmpDir();
    const box = SecretBox.load(path.join(dir, 'secret.key'));
    const plaintext = 'same plaintext every time';

    const blobA = box.encrypt(plaintext);
    const blobB = box.encrypt(plaintext);

    expect(blobA.equals(blobB)).toBe(false);
  });

  it('load twice reuses the same key so decrypt works across instances', () => {
    const dir = tmpDir();
    const keyPath = path.join(dir, 'secret.key');
    const boxA = SecretBox.load(keyPath);
    const plaintext = 'shared secret across instances';
    const blob = boxA.encrypt(plaintext);

    const boxB = SecretBox.load(keyPath);
    const decrypted = boxB.decrypt(blob);

    expect(decrypted).toBe(plaintext);
  });

  it('throws when a tampered byte is decrypted', () => {
    const dir = tmpDir();
    const box = SecretBox.load(path.join(dir, 'secret.key'));
    const blob = box.encrypt('do not tamper with this');

    const tampered = Buffer.from(blob);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex]! ^ 0xff) & 0xff;

    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('creates the key file with mode 0o600', () => {
    const dir = tmpDir();
    const keyPath = path.join(dir, 'secret.key');
    SecretBox.load(keyPath);

    const stats = fs.statSync(keyPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('generates a 32-byte key file when missing', () => {
    const dir = tmpDir();
    const keyPath = path.join(dir, 'secret.key');
    SecretBox.load(keyPath);

    const key = fs.readFileSync(keyPath);
    expect(key.length).toBe(32);
  });
});
