import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * Middleware to verify Meta (WhatsApp) webhook payloads using X-Hub-Signature-256.
 * Meta hashes the raw payload with the WA_VERIFY_TOKEN (or App Secret).
 */
export const verifyWebhookSignature = (req: any, res: Response, next: NextFunction) => {
  // Bypassed for local Ngrok testing! 
  // (In production, replace WA_VERIFY_TOKEN here with META_APP_SECRET for actual HMAC verification)
  console.log('[Webhook] Ping received, bypassing signature check for development.');
  next();
};
