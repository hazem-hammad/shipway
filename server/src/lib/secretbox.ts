import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * SecretBox provides AES-256-GCM authenticated encryption for secrets at rest.
 *
 * Encrypted blob layout: [iv (12 bytes)][authTag (16 bytes)][ciphertext].
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /**
   * Loads the encryption key from `keyPath`. If the file does not exist, a new
   * random 32-byte key is generated and written to `keyPath` with mode 0600.
   */
  static load(keyPath: string): SecretBox {
    let key: Buffer;

    if (fs.existsSync(keyPath)) {
      key = fs.readFileSync(keyPath);
      if (key.length !== KEY_LENGTH) {
        throw new Error(`SecretBox: key file at ${keyPath} must be ${KEY_LENGTH} bytes, got ${key.length}`);
      }
    } else {
      key = randomBytes(KEY_LENGTH);
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
      fs.chmodSync(keyPath, 0o600);
    }

    return new SecretBox(key);
  }

  /** Encrypts `plaintext`, returning [iv][authTag][ciphertext]. */
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, authTag, ciphertext]);
  }

  /** Decrypts a blob produced by {@link encrypt}. Throws if the blob was tampered with. */
  decrypt(blob: Buffer): string {
    const iv = blob.subarray(0, IV_LENGTH);
    const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return plaintext.toString('utf8');
  }
}
