import { Request, Response } from 'express';
import { env } from '../../config/env';
import { WhatsAppService } from './whatsapp.service';

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
  try {
    // 1. Ekstraksi Body WhatsApp (Pipa standard)
    const entry = payload.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    
    if (!message) return; // Hanya proses jika ada message

    const fromNumber = message.from; 
    let incomingText = '';

    if (message.type === 'text') {
      incomingText = message.text.body;
    } else if (message.type === 'interactive') {
      // Jika user klik tombol konfirmasi
      incomingText = message.interactive.button_reply.id; 
    } else if (message.type === 'image') {
      incomingText = "[IMAGE_RECEIPT_DETECTED]"; // AI team will handle fetching media
    }

    console.log(`[Webhook] Menerima pesan dari ${fromNumber}: ${incomingText}`);

    // --- BATAS TUGAS INFRASTRUKTUR / PIPA --- 

    /* 
      // TODO (AI Team):
      // 1. Cek state user di database (Apakah sedang registrasi? Apakah sedang mengedit?)
      // 2. Lempar incomingText (atau image buffer) ke Gemini Prompts
      // 3. Terima JSON hasil OCR / Categorization
      // 4. Konfirmasi ulang ke user pakai WhatsAppService.sendInteractiveButtons()
    */

    // Contoh membalas untuk membuktikan pipa komunikasi lancar (Opsional untuk testing infrastruktur)
    // await WhatsAppService.sendTextMessage(fromNumber, "Pesan Anda sudah diterima sistem, tapi modul AI sedang dimatikan.");

  } catch (error) {
    console.error('Error processing webhook payload async:', error);
  }
};
