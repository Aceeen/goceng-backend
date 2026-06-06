import { env } from '../../config/env';

export class TelegramService {
  private static get apiUrl() {
    return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  }

  /**
   * Send a standard text message to a Telegram chat.
   */
  static async sendTextMessage(chatId: string, message: string): Promise<boolean> {
    if (!env.TELEGRAM_BOT_TOKEN) return false;

    try {
      const response = await fetch(`${this.apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
      });
      const data: any = await response.json();
      if (!response.ok) {
        console.error('[Telegram] sendTextMessage error:', data);
        return false;
      }
      return true;
    } catch (error) {
      console.error('[Telegram] sendTextMessage exception:', error);
      return false;
    }
  }

  /**
   * Send an interactive message with Inline Keyboard buttons.
   * Each button is either:
   *  - a callback button: { id: string; title: string }
   *  - a URL button:      { url: string; title: string }   ← opens a link
   */
  static async sendInteractiveButtons(
    chatId: string,
    text: string,
    buttons: ({ id: string; title: string } | { url: string; title: string })[]
  ): Promise<boolean> {
    if (!env.TELEGRAM_BOT_TOKEN) return false;

    // Telegram: one button per row for readability
    const inlineKeyboard = buttons.map((btn) => [
      'url' in btn
        ? { text: btn.title, url: btn.url }
        : { text: btn.title, callback_data: btn.id },
    ]);

    try {
      const response = await fetch(`${this.apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
      });
      return response.ok;
    } catch (error) {
      console.error('[Telegram] sendInteractiveButtons exception:', error);
      return false;
    }
  }

  /**
   * Downloads a photo from Telegram's servers by file_id.
   * Returns a Buffer and the content-type, or null on failure.
   */
  static async downloadMedia(fileId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!env.TELEGRAM_BOT_TOKEN) return null;

    try {
      // Step 1: Resolve the file_id to a download path
      const getFileRes = await fetch(`${this.apiUrl}/getFile?file_id=${fileId}`);
      const fileData: any = await getFileRes.json();

      if (!getFileRes.ok || !fileData.ok || !fileData.result?.file_path) {
        console.error('[Telegram] downloadMedia – failed to resolve file path:', fileData);
        return null;
      }

      // Step 2: Download the actual binary
      const downloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
      const bufferRes = await fetch(downloadUrl);

      if (!bufferRes.ok) return null;

      const arrayBuffer = await bufferRes.arrayBuffer();
      
      const filePath = fileData.result.file_path || '';
      const ext = filePath.split('.').pop()?.toLowerCase();
      let mimeType = 'image/jpeg';

      if (ext === 'png') {
        mimeType = 'image/png';
      } else if (ext === 'webp') {
        mimeType = 'image/webp';
      } else if (ext === 'pdf') {
        mimeType = 'application/pdf';
      } else if (ext === 'heic') {
        mimeType = 'image/heic';
      } else if (ext === 'heif') {
        mimeType = 'image/heif';
      } else if (ext === 'jpg' || ext === 'jpeg') {
        mimeType = 'image/jpeg';
      } else {
        const headerMime = bufferRes.headers.get('content-type');
        if (headerMime && headerMime !== 'application/octet-stream') {
          mimeType = headerMime;
        }
      }

      return { buffer: Buffer.from(arrayBuffer), mimeType };
    } catch (error) {
      console.error('[Telegram] downloadMedia exception:', error);
      return null;
    }
  }

  /**
   * Sends a PDF buffer to a Telegram chat as a document.
   */
  static async sendDocument(
    chatId: string,
    pdfBuffer: Buffer,
    fileName = 'Report.pdf'
  ): Promise<boolean> {
    if (!env.TELEGRAM_BOT_TOKEN) return false;

    try {
      const form = new FormData();
      const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
      form.append('chat_id', chatId);
      form.append('document', blob, fileName);

      const response = await fetch(`${this.apiUrl}/sendDocument`, {
        method: 'POST',
        body: form,
      });

      const data: any = await response.json();
      if (!data.ok) {
        console.error('[Telegram] sendDocument error:', data);
        return false;
      }
      return true;
    } catch (error) {
      console.error('[Telegram] sendDocument exception:', error);
      return false;
    }
  }
}
