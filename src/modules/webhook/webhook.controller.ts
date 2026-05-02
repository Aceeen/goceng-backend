// src/modules/webhook/webhook.controller.ts

import { Request, Response } from 'express';
import { env } from '../../config/env';
import { WhatsAppService } from './whatsapp.service';
import { prisma } from '../../config/prisma';
import fs from 'fs';
import path from 'path';

// ─── AI Module ────────────────────────────────────────────────────────────────
import { extractFromImage, extractFromText, applyUserCorrection } from '../ai/ai.service';
import {
  isAIError, isOCRBlur, isOCRForeign, isOCRNormal,
  OCRNormalResult, OCRForeignResult, NLPResult,
} from '../ai/ai.types';

// ─── Session & Transaction ────────────────────────────────────────────────────
import {
  createSession,
  getPendingSession,
  updateSessionStatus,
  resetSessionToPending,
} from '../session/session.service';
import { saveConfirmedTransaction } from '../transaction/transaction.save';

const BTN_CONFIRM = 'btn_confirm';
const BTN_EDIT    = 'btn_edit';
const BTN_CANCEL  = 'btn_cancel';

// =============================================================================
// VERIFY ENDPOINT
// =============================================================================
export const verifyEndpoint = (req: Request, res: Response) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Verification failed' } });
  }
};

// =============================================================================
// RECEIVE MESSAGE — fire-and-forget
// =============================================================================
export const receiveMessage = (req: Request, res: Response) => {
  res.status(200).json({ status: 'received' });
  setImmediate(() => {
    processAsyncPayload(req.body).catch((err) => {
      console.error('❌ Error processing webhook async:', err);
    });
  });
};

// =============================================================================
// PROCESS ASYNC
// =============================================================================
const processAsyncPayload = async (payload: any) => {
  try {
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const fromNumber = message.from as string;
    const messageId  = message.id  as string;
    const msgType    = message.type as string;

    console.log(`[Webhook] Pesan dari ${fromNumber}, tipe: ${msgType}`);

    // ── Cek user terdaftar ────────────────────────────────────────────────
    const user = await prisma.user.findFirst({ where: { whatsappNumber: fromNumber } });
    if (!user) {
      const loginLink = `${(env as any).FRONTEND_URL}/login?wa=${fromNumber}`;
      await WhatsAppService.sendTextMessage(
        fromNumber,
        `Halo! Selamat datang di *GOCENG* 🤖📊\n\nNomor Anda belum terdaftar. Silakan hubungkan akun Google:\n\n🔗 ${loginLink}\n\nSetelah login, sapa saya kembali!`
      );
      return;
    }

    // ── Ambil kategori untuk NLP ──────────────────────────────────────────
    const allCategories = await prisma.category.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    const categoryNames = allCategories.map((c) => c.name);

    // ── ROUTING: Tombol interaktif ────────────────────────────────────────
    if (msgType === 'interactive') {
      await handleButtonReply(fromNumber, user.id, message.interactive.button_reply.id);
      return;
    }

    // ── ROUTING: Sesi EDITED (user kirim koreksi) ─────────────────────────
    const editingSession = await prisma.transactionSession.findFirst({
      where: { userId: user.id, status: 'EDITED', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (editingSession && msgType === 'text') {
      await handleEditCorrection(fromNumber, editingSession, message.text.body);
      return;
    }

    // ── ROUTING: Pesan baru ───────────────────────────────────────────────
    if (msgType === 'text') {
      await handleTextMessage(fromNumber, user.id, message.text.body, messageId, categoryNames);
    } else if (msgType === 'image') {
      await handleImageMessage(fromNumber, user.id, message.image.id, messageId);
    } else {
      await WhatsAppService.sendTextMessage(fromNumber, '📎 GOCENG hanya bisa memproses pesan teks atau foto struk ya!');
    }
  } catch (error) {
    console.error('❌ processAsyncPayload error:', error);
  }
};

// =============================================================================
// HANDLER: Teks → NLP
// =============================================================================
const handleTextMessage = async (
  fromNumber: string, userId: string,
  text: string, messageId: string, categoryNames: string[]
) => {
  await WhatsAppService.sendTextMessage(fromNumber, '⏳ Sedang memproses pesan kamu...');

  const result = await extractFromText(text, categoryNames);

  if (isAIError(result)) {
    const msg = result.error === 'NO_AMOUNT'
      ? '❓ Nominal tidak ditemukan. Coba tulis seperti:\n• _"Makan siang 25rb"_\n• _"Bensin 50000"_\n• _"Bayar listrik 200rb"_'
      : '😔 Layanan AI sedang sibuk. Coba lagi dalam beberapa menit.';
    await WhatsAppService.sendTextMessage(fromNumber, msg);
    return;
  }

  const session = await createSession(userId, result, { text }, messageId);
  await sendConfirmationMessage(fromNumber, result, session.id);
};

// =============================================================================
// HANDLER: Gambar → OCR (3 case)
// =============================================================================
const handleImageMessage = async (
  fromNumber: string, userId: string,
  mediaId: string, messageId: string
) => {
  await WhatsAppService.sendTextMessage(fromNumber, '🔍 Sedang membaca struk kamu...');


// 🔥 Ambil gambar dari folder lokal
const imagePath = path.resolve(process.cwd(), 'scripts/notakorea.jpeg');

const buffer = fs.readFileSync(imagePath);
const base64 = buffer.toString('base64');

// langsung kirim ke AI
const result = await extractFromImage(base64, 'image/jpeg');

  // ── Error dari Gemini ─────────────────────────────────────────────────────
  if (isAIError(result)) {
    await WhatsAppService.sendTextMessage(fromNumber, '😔 Layanan AI sedang sibuk. Coba lagi dalam beberapa menit.');
    return;
  }

  // ── CASE 1: BLUR — foto tidak terbaca ────────────────────────────────────
  if (isOCRBlur(result)) {
    await WhatsAppService.sendTextMessage(
      fromNumber,
      `📸 *Foto struk tidak bisa dibaca*\n\n${result.message}\n\n` +
      `Tips agar struk terbaca dengan baik:\n` +
      `• Foto di tempat yang cukup cahaya\n` +
      `• Pastikan struk tidak terlipat\n` +
      `• Jangan terlalu jauh atau terlalu dekat\n` +
      `• Hindari bayangan di atas struk\n\n` +
      `Coba foto ulang dan kirim kembali ya! 🙏`
    );
    return;
  }

  // ── CASE 2: NORMAL — struk IDR ───────────────────────────────────────────
  if (isOCRNormal(result)) {
    const session = await createSession(userId, result, { mediaId }, messageId);
    await sendConfirmationMessage(fromNumber, result, session.id);
    return;
  }

  // ── CASE 3: FOREIGN — struk luar negeri ──────────────────────────────────
  if (isOCRForeign(result)) {
    const session = await createSession(userId, result, { mediaId }, messageId);
    await sendForeignConfirmationMessage(fromNumber, result, session.id);
    return;
  }
};

// =============================================================================
// HANDLER: Tombol YA SIMPAN / EDIT / BATAL
// =============================================================================
const handleButtonReply = async (fromNumber: string, userId: string, buttonId: string) => {
  const session = await getPendingSession(userId);

  if (!session) {
    await WhatsAppService.sendTextMessage(
      fromNumber,
      '⏰ Sesi konfirmasi sudah kedaluwarsa (15 menit). Kirim ulang transaksimu ya!'
    );
    return;
  }

  if (buttonId === BTN_CONFIRM) {
    try {
      const data = session.extractedData as any;
      const { account } = await saveConfirmedTransaction(userId, data);

      await updateSessionStatus(session.id, 'SAVED');

      const amount   = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
      const saldo    = Number(account?.currentBalance ?? 0).toLocaleString('id-ID');
      const merchant = data.merchantName ?? data.description ?? '-';
      const category = data.suggestedCategory ?? 'Tidak dikategorikan';

      // Tambah info kurs jika nota luar negeri
      const foreignInfo = data.case === 'FOREIGN'
        ? `• 💱 Kurs: 1 ${data.originalCurrency} = Rp ${Number(data.exchangeRate).toLocaleString('id-ID')}\n` +
          `• 💵 Total asli: ${data.originalCurrency} ${data.originalAmount}\n`
        : '';

      await WhatsAppService.sendTextMessage(
        fromNumber,
        `✅ *Transaksi berhasil dicatat!*\n\n` +
        `📋 *Ringkasan:*\n` +
        `• 🏪 Merchant: ${merchant}\n` +
        `• 💰 Total: Rp ${amount}\n` +
        `${foreignInfo}` +
        `• 📁 Kategori: ${category}\n` +
        `• 🏦 Rekening: ${account?.name ?? '-'}\n\n` +
        `💰 *Sisa saldo ${account?.name ?? 'rekening'}: Rp ${saldo}*`
      );
    } catch (err) {
      console.error('Gagal simpan transaksi:', err);
      await updateSessionStatus(session.id, 'FAILED');
      await WhatsAppService.sendTextMessage(fromNumber, '❌ Gagal menyimpan transaksi. Coba lagi ya.');
    }
    return;
  }

  if (buttonId === BTN_EDIT) {
    await updateSessionStatus(session.id, 'EDITED');
    await WhatsAppService.sendTextMessage(
      fromNumber,
      '✏️ Apa yang ingin dikoreksi?\n\nContoh:\n' +
      '• _"Harganya 55000"_\n' +
      '• _"Kategori: Transportasi"_\n' +
      '• _"Tanggalnya kemarin"_\n' +
      '• _"Merchantnya Alfamart"_\n' +
      '• _"Kursnya 16500"_ _(untuk nota luar negeri)_'
    );
    return;
  }

  if (buttonId === BTN_CANCEL) {
    await updateSessionStatus(session.id, 'CANCELLED');
    await WhatsAppService.sendTextMessage(fromNumber, '🚫 Transaksi dibatalkan. Kirim pesan baru kapan saja!');
  }
};

// =============================================================================
// HANDLER: Koreksi teks setelah EDIT
// =============================================================================
const handleEditCorrection = async (
  fromNumber: string, editingSession: any, correctionText: string
) => {
  await WhatsAppService.sendTextMessage(fromNumber, '✏️ Menerapkan koreksimu...');
const match = correctionText.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?/);

if (match) {
  const raw = Number(match[1].replace(',', '.'));
  const unit = match[2];

  let amount = raw;
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') amount = raw * 1000;
  if (unit === 'jt' || unit === 'juta') amount = raw * 1000000;

  const merged = {
    ...(editingSession.extractedData as any),
    amount,
    totalAmount: amount
  };

  await resetSessionToPending(editingSession.id, merged);
  await sendConfirmationMessage(fromNumber, merged, editingSession.id);
  return;
}
  const corrected = await applyUserCorrection(correctionText, editingSession.extractedData as object);

  if (isAIError(corrected)) {
    await WhatsAppService.sendTextMessage(fromNumber, '😔 Gagal menerapkan koreksi. Tulis lebih jelas ya.');
    return;
  }

  const merged = { ...(editingSession.extractedData as object), ...corrected };
  await resetSessionToPending(editingSession.id, merged);

  // Kirim konfirmasi sesuai case
  const data = merged as any;
  if (data.case === 'FOREIGN') {
    await sendForeignConfirmationMessage(fromNumber, data, editingSession.id);
  } else {
    await sendConfirmationMessage(fromNumber, data, editingSession.id);
  }

};

// =============================================================================
// HELPER: Pesan konfirmasi untuk struk NORMAL / teks
// =============================================================================
const sendConfirmationMessage = async (
  fromNumber: string,
  data: Partial<OCRNormalResult & NLPResult> & Record<string, any>,
  sessionId: string
) => {
  const amount     = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
  const merchant   = data.merchantName ?? data.description ?? 'Tidak diketahui';
  const category   = data.suggestedCategory ?? 'Belum dikategorikan';
  const confidence = Math.round((data.confidence ?? 1) * 100);
  const date       = data.transactionDate
    ? new Date(data.transactionDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'Hari ini';
const itemText =
  Array.isArray(data.items) && data.items.length > 0
    ? data.items
        .map((item: any, index: number) => {
          const qty = Number(item.quantity ?? 1);
          const total = Number(item.totalPrice ?? item.unitPrice ?? 0).toLocaleString('id-ID');

          return `${index + 1}. ${item.name} x${qty} - Rp ${total}`;
        })
        .join('\n')
    : '-';
  await WhatsAppService.sendInteractiveButtons(
    fromNumber,
    `🧾 *GOCENG mendeteksi transaksi:*\n\n` +
    `• 🏪 Merchant: *${merchant}*\n` +
    `• 💰 Total: *Rp ${amount}*\n` +
    `• 📁 Kategori: *${category}*\n` +
    `• 📅 Tanggal: *${date}*\n` +
    `• 🤖 Keyakinan AI: *${confidence}%*\n\n` +
    `🛒 *Detail Item:*\n${itemText}\n\n` +
    `Apakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: BTN_EDIT,    title: '✏️ Edit'       },
      { id: BTN_CANCEL,  title: '❌ Batal'      },
    ]
  );
};

// =============================================================================
// HELPER: Pesan konfirmasi khusus struk FOREIGN (luar negeri)
// =============================================================================
const sendForeignConfirmationMessage = async (
  fromNumber: string,
  data: OCRForeignResult & Record<string, any>,
  sessionId: string
) => {
  const totalIDR       = Number(data.totalAmount).toLocaleString('id-ID');
  const originalAmount = Number(data.originalAmount).toLocaleString('en-US');
  const exchangeRate   = Number(data.exchangeRate).toLocaleString('id-ID');
  const merchant       = data.merchantName ?? 'Tidak diketahui';
  const category       = data.suggestedCategory ?? 'Belum dikategorikan';
  const confidence     = Math.round((data.confidence ?? 1) * 100);
  const date           = data.transactionDate
    ? new Date(data.transactionDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })
    : 'Hari ini';
const itemText =
  Array.isArray(data.items) && data.items.length > 0
    ? data.items
        .map((item: any, index: number) => {
          const qty = Number(item.quantity ?? 1);
          const total = Number(item.totalPrice ?? item.unitPrice ?? 0).toLocaleString('id-ID');

          return `${index + 1}. ${item.name} x${qty} - Rp ${total}`;
        })
        .join('\n')
    : '-';
  await WhatsAppService.sendInteractiveButtons(
    fromNumber,
    `🌏 *GOCENG mendeteksi struk LUAR NEGERI:*\n\n` +
    `• 🏪 Merchant: *${merchant}*\n` +
    `• 💵 Total asli: *${data.originalCurrency} ${originalAmount}*\n` +
    `• 💱 Kurs pakai: *1 ${data.originalCurrency} = Rp ${exchangeRate}*\n` +
    `• 💰 Total IDR: *Rp ${totalIDR}*\n` +
    `• 📁 Kategori: *${category}*\n` +
    `• 📅 Tanggal: *${date}*\n` +
    `• 🤖 Keyakinan AI: *${confidence}%*\n\n` +
    `⚠️ _Kurs adalah perkiraan. Koreksi jika perlu._\n\n` +
    `🛒 *Detail Item:*\n${itemText}\n\n` +
    `Apakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: BTN_EDIT,    title: '✏️ Edit Kurs'  },
      { id: BTN_CANCEL,  title: '❌ Batal'      },
    ]
  );
};