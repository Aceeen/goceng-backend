import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex'); // 32 bytes (64 hex chars)

export function encryptToken(text: string): string {
  const iv = crypto.randomBytes(16); // 16 bytes for AES IV
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  
  // Return the iv and encrypted data concatenated, as a hex string
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encryptedText: string): string {
  const textParts = encryptedText.split(':');
  const ivPart = textParts.shift();
  if (!ivPart) throw new Error('Invalid encrypted text format');

  const iv = Buffer.from(ivPart, 'hex');
  const encryptedData = Buffer.from(textParts.join(':'), 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  
  return decrypted.toString('utf8');
}
