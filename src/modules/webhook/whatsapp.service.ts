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
}
