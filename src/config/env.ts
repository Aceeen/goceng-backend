import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const envSchema = z.object({
  PORT: z.string().default('3001').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  FRONTEND_URL: z.string().url(),
  
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  GOOGLE_CLIENT_ID: z.string().min(1, 'Google Client ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'Google Client Secret is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),
  MASTER_SPREADSHEET_ID: z.string().min(1, 'Master Spreadsheet ID is required'),

  WA_VERIFY_TOKEN: z.string().min(1, 'WA Verify Token is required'),
  WA_ACCESS_TOKEN: z.string().min(1, 'WA Access Token is required'),
  WA_PHONE_NUMBER_ID: z.string().min(1, 'WA Phone Number ID is required'),

  JWT_SECRET: z.string().min(32, 'JWT Secret must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z.string().length(64, 'Token Encryption Key must be a 64-char hex string (32 bytes)'),
  INTERNAL_API_KEY: z.string().min(1, 'Internal API Key is required'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
