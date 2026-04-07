import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * Middleware to verify Meta (WhatsApp) webhook payloads using X-Hub-Signature-256.
 * Meta hashes the raw payload with the WA_VERIFY_TOKEN (or App Secret).
 */
export const verifyWebhookSignature = (req: any, res: Response, next: NextFunction) => {
  const signature = req.headers['x-hub-signature-256'];
  
  if (!signature) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Signature' } });
  }

  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', env.WA_VERIFY_TOKEN)
    .update(req.rawBody || '')
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid Signature' } });
  }

  next();
};
