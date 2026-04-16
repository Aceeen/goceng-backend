import { env } from '../../config/env';

export class WhatsAppService {
  /**
   * Mengirim pesan teks standar ke WhatsApp pengguna
   */
  static async sendTextMessage(to: string, message: string) {
    const url = `https://graph.facebook.com/v17.0/${env.WA_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();
      if (!response.ok) {
        console.error('Meta API Error:', data);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Failed invoking WhatsApp Cloud API:', error);
      return false;
    }
  }

  /**
   * Mengirim pesan Button (Interaktif) untuk konfirmasi Transaksi
   */
  static async sendInteractiveButtons(to: string, text: string, buttons: { id: string; title: string }[]) {
    const url = `https://graph.facebook.com/v17.0/${env.WA_PHONE_NUMBER_ID}/messages`;
    
    // WhatsApp Limits: Max 3 Buttons
    const formattedButtons = buttons.slice(0, 3).map(btn => ({
      type: 'reply',
      reply: { id: btn.id, title: btn.title }
    }));

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: formattedButtons }
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      return response.ok;
    } catch (error) {
      console.error('Failed sending WA Buttons:', error);
      return false;
    }
  }

  /**
   * Fetches an image buffer directly from Meta's servers using a media ID.
   */
  static async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      // Step 1: Get media URL from Meta
      const urlResponse = await fetch(`https://graph.facebook.com/v17.0/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}` }
      });
      
      const mediaData: any = await urlResponse.json();
      if (!urlResponse.ok || !mediaData.url) {
        console.error('Failed to resolve Media URL:', mediaData);
        return null;
      }

      // Step 2: Download actual binary buffer from resolved URL
      const bufferResponse = await fetch(mediaData.url, {
        headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}` }
      });

      if (!bufferResponse.ok) return null;

      const arrayBuffer = await bufferResponse.arrayBuffer();
      const mimeType = bufferResponse.headers.get('content-type') || 'image/jpeg';

      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType
      };
    } catch (error) {
      console.error('Error fetching WA media:', error);
      return null;
    }
  }

  /**
   * Uploads a raw binary Buffer to Meta's servers and sends it directly to a user's WhatsApp.
   */
  static async sendDocument(to: string, pdfBuffer: Buffer, fileName: string = 'Report.pdf') {
    if (!env.WA_PHONE_NUMBER_ID || !env.WA_ACCESS_TOKEN) return false;

    try {
      // 1. Upload Buffer to Meta Media Server
      const form = new FormData();
      const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
      form.append('file', blob, fileName);
      form.append('type', 'application/pdf');
      form.append('messaging_product', 'whatsapp');

      const uploadUrl = `https://graph.facebook.com/v17.0/${env.WA_PHONE_NUMBER_ID}/media`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}` },
        body: form
      });
      
      const uploadData: any = await uploadRes.json();
      if (!uploadData.id) {
        console.error('Failed to upload document to Meta:', uploadData);
        return false;
      }

      // 2. Dispatch the payload Media ID
      const msgUrl = `https://graph.facebook.com/v17.0/${env.WA_PHONE_NUMBER_ID}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'document',
        document: {
          id: uploadData.id,
          filename: fileName
        }
      };

      const sendRes = await fetch(msgUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await sendRes.json();
      console.log('✅ Document dispatched to WhatsApp successfully!');
      return data;
    } catch (error) {
      console.error('❌ Error sending WhatsApp document:', error);
      return false;
    }
  }
}
