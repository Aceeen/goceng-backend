import { Request, Response } from 'express';
import { env } from '../../config/env';

/**
 * Validates the Webhook challenge sent by Meta during setup.
 */
export const verifyEndpoint = (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed' } });
  }
};

/**
 * Handles incoming WhatsApp messages asynchronously (Fire-and-forget).
 */
export const receiveMessage = (req: Request, res: Response) => {
  // Fire and forget pattern as required by Meta (must respond 200 OK within seconds).
  res.status(200).json({ status: 'received' });

  // Process asynchronously
  setImmediate(() => {
    processAsyncPayload(req.body).catch((err) => {
      console.error('Error processing webhook payload async:', err);
    });
  });
};

const processAsyncPayload = async (payload: any) => {
  console.log('--- Processing webhook payload asynchronously ---');
  // AI extractions, logic, etc., go here
  // Handled by other modules...
};
