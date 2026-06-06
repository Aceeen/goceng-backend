// src/modules/webhook/webhook.controller.ts

import { Request, Response } from 'express';
import { env } from '../../config/env';
import { WhatsAppService } from './whatsapp.service';
import { DriveService } from '../sheets/drive.service';
import { SheetsService } from '../sheets/sheets.service';
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

const activePrintLocks = new Set<string>();

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

    // ── Cek akun terdaftar ────────────────────────────────────────────────
    const messagingAccount = await prisma.messagingAccount.findFirst({ where: { platform: 'WHATSAPP', externalId: fromNumber } });
    if (!messagingAccount) {
      const loginLink = `${(env as any).FRONTEND_URL}/login?platform=WHATSAPP&id=${fromNumber}`;
      await WhatsAppService.sendTextMessage(
        fromNumber,
        `Halo! Selamat datang di *GOCENG* 🤖📊\n\nNomor Anda belum terdaftar. Silakan hubungkan akun Google:\n\n🔗 ${loginLink}\n\nSetelah login, sapa saya kembali!`
      );
      return;
    }

    // ── Ambil kategori untuk NLP ──────────────────────────────────────────
    const allCategories = await prisma.category.findMany({
      where: {
        OR: [
          { isSystem: true },
          { messagingAccountId: messagingAccount.id }
        ]
      },
      select: { name: true },
      orderBy: { name: 'asc' }
    });
    const categoryNames = allCategories.map((c) => c.name);

    // ── ROUTING: Tombol interaktif ────────────────────────────────────────
    if (msgType === 'interactive') {
      await handleButtonReply(fromNumber, messagingAccount.id, message.interactive.button_reply.id);
      return;
    }

    // ── ROUTING: Sesi EDITED (user kirim koreksi) ─────────────────────────
    const editingSession = await prisma.transactionSession.findFirst({
      where: { messagingAccountId: messagingAccount.id, status: 'EDITED', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (editingSession && msgType === 'text') {
      await handleEditCorrection(fromNumber, editingSession, message.text.body);
      return;
    }

    // ── ROUTING: Pesan baru ───────────────────────────────────────────────
    if (msgType === 'text') {
      const textVal = message.text.body.trim().toLowerCase();
      if (textVal === '/sync' || textVal === 'sync') {
        const hasMeta = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccount.id },
          select: { spreadsheetId: true, userId: true }
        });

        let exists = false;
        if (hasMeta?.spreadsheetId && hasMeta?.userId) {
          try {
            exists = await SheetsService.checkIfSpreadsheetExists(hasMeta.userId, hasMeta.spreadsheetId);
          } catch (err) {
            console.error('Error checking sheet existence in WhatsApp /sync:', err);
          }
        }

        if (!hasMeta?.spreadsheetId || !exists) {
          if (hasMeta?.spreadsheetId) {
            await prisma.messagingAccount.update({
              where: { id: messagingAccount.id },
              data: { spreadsheetId: null }
            });
          }

          const tokenRecord = hasMeta?.userId
            ? await prisma.oAuthToken.findUnique({ where: { userId: hasMeta.userId } })
            : null;

          if (tokenRecord) {
            const messageText = `File sheets tidak ditemukan. Klik tombol di bawah untuk membuat file baru secara otomatis. /sync untuk menyinkronkan data`;
            await WhatsAppService.sendInteractiveButtons(fromNumber, messageText, [
              { id: 'regenerate_sheets', title: 'Buat Ulang Sheet' }
            ]);
          } else {
            await WhatsAppService.sendTextMessage(fromNumber,
              '⚠️ Google Sheets belum terhubung. Silakan login ulang Google terlebih dahulu lewat aplikasi.'
            );
          }
          return;
        }

        await WhatsAppService.sendTextMessage(fromNumber, '🔄 Memulai sinkronisasi data ke Google Sheets...');
        SheetsService.triggerFullSync(messagingAccount.id);
        await WhatsAppService.sendTextMessage(fromNumber,
          '✅ Sinkronisasi dimulai di latar belakang!\n\nSemua transaksi tahun ini, rekening, dan budget sedang disinkronkan ke spreadsheet-mu.'
        );
        return;
      }

      await handleTextMessage(fromNumber, messagingAccount.id, message.text.body, messageId, categoryNames);
    } else if (msgType === 'image') {
      await handleImageMessage(fromNumber, messagingAccount.id, message.image.id, messageId);
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
  fromNumber: string, messagingAccountId: string,
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

  const session = await createSession(messagingAccountId, 'WHATSAPP', result, { text }, messageId);
  await sendConfirmationMessage(fromNumber, result, session.id);
};

// =============================================================================
// HANDLER: Gambar → OCR (3 case)
// =============================================================================
const handleImageMessage = async (
  fromNumber: string, messagingAccountId: string,
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
    const session = await createSession(messagingAccountId, 'WHATSAPP', result, { mediaId }, messageId);
    await sendConfirmationMessage(fromNumber, result, session.id);
    return;
  }

  // ── CASE 3: FOREIGN — struk luar negeri ──────────────────────────────────
  if (isOCRForeign(result)) {
    const session = await createSession(messagingAccountId, 'WHATSAPP', result, { mediaId }, messageId);
    await sendForeignConfirmationMessage(fromNumber, result, session.id);
    return;
  }
};

// =============================================================================
// HANDLER: Tombol YA SIMPAN / EDIT / BATAL
// =============================================================================
const handleButtonReply = async (fromNumber: string, messagingAccountId: string, buttonId: string) => {
  if (buttonId === 'regenerate_sheets') {
    await WhatsAppService.sendTextMessage(fromNumber, '⏳ Sedang membuat ulang spreadsheet...');
    try {
      await SheetsService.regenerateSpreadsheet(messagingAccountId);
      SheetsService.triggerFullSync(messagingAccountId);
      await WhatsAppService.sendTextMessage(
        fromNumber,
        '✅ Spreadsheet berhasil dibuat ulang!\n\nSemua transaksi tahun ini, rekening, dan budget sedang disinkronkan di latar belakang.'
      );
    } catch (err) {
      console.error('Error regenerating spreadsheet via WA button callback:', err);
      await WhatsAppService.sendTextMessage(
        fromNumber,
        '❌ Gagal membuat ulang spreadsheet. Hubungkan kembali Google Anda.'
      );
    }
    return;
  }

  if (buttonId.startsWith('cetak_')) {
    const parts = buttonId.split('_');
    const month = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const sheetName = MONTHS_ID[month - 1];

    if (activePrintLocks.has(messagingAccountId)) {
      console.warn(`[Cetak] Duplicate print request (in-memory lock) ignored for user ${messagingAccountId}`);
      return;
    }
    activePrintLocks.add(messagingAccountId);

    // Check for transaction existence in that specific month and year
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const txCount = await prisma.transaction.count({
      where: {
        messagingAccountId,
        isConfirmed: true,
        deletedAt: null,
        transactionDate: { gte: startDate, lte: endDate }
      }
    });

    if (txCount === 0) {
      activePrintLocks.delete(messagingAccountId);
      await WhatsAppService.sendTextMessage(fromNumber, `❌ Tidak ada transaksi pada bulan *${sheetName} ${year}*. Laporan tidak dapat dicetak.`);
      return;
    }

    // Clean up any expired print locks first
    await prisma.transactionSession.deleteMany({
      where: {
        messagingAccountId,
        externalMessageId: `PRINT_${messagingAccountId}`,
        expiresAt: { lte: new Date() }
      }
    }).catch(() => {});

    // Create printing session lock using unique constraint on externalMessageId
    let printSession;
    try {
      printSession = await prisma.transactionSession.create({
        data: {
          messagingAccountId,
          platform: 'WHATSAPP',
          status: 'PENDING',
          externalMessageId: `PRINT_${messagingAccountId}`,
          extractedData: { type: 'PRINTING', month, year },
          rawPayload: {},
          expiresAt: new Date(Date.now() + 15000) // 15 seconds lock
        }
      });
    } catch (err: any) {
      activePrintLocks.delete(messagingAccountId);
      if (err.code === 'P2002') {
        console.warn(`[Cetak] Duplicate print request (DB constraint lock) ignored for user ${messagingAccountId}`);
        return;
      }
      throw err;
    }

    await WhatsAppService.sendTextMessage(fromNumber, `⏳ Sedang mencetak laporan *${sheetName}*...`);

    const account = await prisma.messagingAccount.findUnique({
      where: { id: messagingAccountId }
    });

    if (!account?.spreadsheetId) {
      activePrintLocks.delete(messagingAccountId);
      await WhatsAppService.sendTextMessage(fromNumber, '❌ Google Sheet belum terhubung.');
      await prisma.transactionSession.delete({ where: { id: printSession.id } }).catch(() => {});
      return;
    }

    try {
      const pdfBuffer = await DriveService.exportSheetByName(account.userId, account.spreadsheetId, sheetName);
      if (!pdfBuffer) {
        await WhatsAppService.sendTextMessage(fromNumber, `❌ Tab *${sheetName}* tidak ditemukan di spreadsheet.`);
        return;
      }

      await WhatsAppService.sendDocument(fromNumber, pdfBuffer, `GOCENG_Laporan_${sheetName}_${year}.pdf`);
    } catch (error) {
      console.error('Failed to export and send PDF to WhatsApp:', error);
      await WhatsAppService.sendTextMessage(fromNumber, '❌ Gagal mencetak laporan PDF.');
    } finally {
      activePrintLocks.delete(messagingAccountId);
      if (printSession) {
        await prisma.transactionSession.delete({ where: { id: printSession.id } }).catch(() => {});
      }
    }
    return;
  }

  const session = await getPendingSession(messagingAccountId);

  if (!session) {
    await WhatsAppService.sendTextMessage(
      fromNumber,
      '⏰ Sesi konfirmasi sudah kedaluwarsa (15 menit). Kirim ulang transaksimu ya!'
    );
    return;
  }

  if (buttonId === BTN_CONFIRM) {
    // Atomically claim the session by transitioning status from PENDING to CONFIRMED
    const updated = await prisma.transactionSession.updateMany({
      where: {
        id: session.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() }
      },
      data: {
        status: 'CONFIRMED'
      }
    });

    if (updated.count === 0) {
      console.warn(`[WhatsApp] Confirm button double clicked or session already processed for user ${messagingAccountId}`);
      return; // Exit silently to avoid duplicate inserts
    }

    try {
      const data = session.extractedData as any;
      const rawPayload = session.rawPayload as any;
      const mediaId = rawPayload?.mediaId;
      let imageUrl: string | undefined;

      if (mediaId) {
        const mediaData = await WhatsAppService.downloadMedia(mediaId);
        if (mediaData) {
          const accountMeta = await prisma.messagingAccount.findUnique({
            where: { id: messagingAccountId },
            select: { userId: true },
          });
          if (accountMeta?.userId) {
            const fileName = `receipt_${Date.now()}`;
            const uploadedUrl = await DriveService.uploadReceipt(
              accountMeta.userId,
              messagingAccountId,
              mediaData.buffer,
              mediaData.mimeType,
              fileName
            );
            if (uploadedUrl) {
              imageUrl = uploadedUrl;
            }
          }
        }
      }

      const { account, budgetInfo } = await saveConfirmedTransaction(messagingAccountId, data, imageUrl);

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

      let msg = `✅ *Transaksi berhasil dicatat!*\n\n` +
        `📋 *Ringkasan:*\n` +
        `• 🏪 Merchant: ${merchant}\n` +
        `• 💰 Total: Rp ${amount}\n` +
        `${foreignInfo}` +
        `• 📁 Kategori: ${category}\n` +
        `• 🏦 Rekening: ${account?.name ?? '-'}\n\n` +
        `💰 *Sisa saldo ${account?.name ?? 'rekening'}: Rp ${saldo}*`;

      if (budgetInfo) {
        const spent = budgetInfo.currentSpent.toLocaleString('id-ID');
        const lim = budgetInfo.limitAmount.toLocaleString('id-ID');
        const remaining = budgetInfo.remaining.toLocaleString('id-ID');
        const pct = budgetInfo.percentage.toFixed(0);

        if (budgetInfo.warningLevel === 'EXCEEDED') {
          msg += `\n\n🚨 *Budget ${budgetInfo.categoryName} TERLAMPAUI!*\nTerpakai: Rp ${spent} dari Rp ${lim} (${pct}%)`;
        } else if (budgetInfo.warningLevel === 'WARNING') {
          msg += `\n\n⚠️ *Budget ${budgetInfo.categoryName} hampir habis!*\nTerpakai: Rp ${spent} dari Rp ${lim} (${pct}%)\nSisa: *Rp ${remaining}*`;
        } else {
          msg += `\n\n📊 *Budget ${budgetInfo.categoryName}:* Rp ${spent} / Rp ${lim} (${pct}%)\nSisa: *Rp ${remaining}*`;
        }
      }

      await WhatsAppService.sendTextMessage(fromNumber, msg);
    } catch (err) {
      console.error('Gagal simpan transaksi:', err);
      await updateSessionStatus(session.id, 'FAILED');
      await WhatsAppService.sendTextMessage(fromNumber, '❌ Gagal menyimpan transaksi. Coba lagi ya.');
    }
    return;
  }

  if (buttonId === 'btn_change_account') {
    const accounts = await prisma.account.findMany({
      where: { messagingAccountId, isActive: true },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' }
    });
    if (!accounts.length) {
      await WhatsAppService.sendTextMessage(fromNumber, '❌ Tidak ada rekening aktif.');
      return;
    }
    await WhatsAppService.sendInteractiveButtons(
      fromNumber,
      '🏦 Pilih rekening untuk transaksi ini:',
      accounts.map((a: any) => ({ id: `btn_set_account_${a.id}`, title: a.name }))
    );
    return;
  }

  if (buttonId.startsWith('btn_set_account_')) {
    const accountId = buttonId.replace('btn_set_account_', '');
    const merged = { ...(session.extractedData as any), accountId };
    
    await prisma.transactionSession.update({
      where: { id: session.id },
      data: { extractedData: merged }
    });

    if (merged.case === 'FOREIGN') {
      await sendForeignConfirmationMessage(fromNumber, merged, session.id);
    } else {
      await sendConfirmationMessage(fromNumber, merged, session.id);
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

  const cleanText = correctionText.trim();

  // 1. Direct Regex Prefix Parsing to ensure instant, deterministic updates
  const descPrefixPattern = /^\s*(?:deskripsi|description|deskripsinya)\s*[:\s\-]?\s*(.+)$/i;
  const descMatch = cleanText.match(descPrefixPattern);
  if (descMatch) {
    const value = descMatch[1].trim();
    if (value) {
      const merged = { ...(editingSession.extractedData as any), description: value };
      await resetSessionToPending(editingSession.id, merged);
      if (merged.case === 'FOREIGN') {
        await sendForeignConfirmationMessage(fromNumber, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(fromNumber, merged, editingSession.id);
      }
      return;
    }
  }

  const merchantPrefixPattern = /^\s*(?:merchant|merchantnya|toko|tokonya)\s*[:\s\-]?\s*(.+)$/i;
  const merchantMatch = cleanText.match(merchantPrefixPattern);
  if (merchantMatch) {
    const value = merchantMatch[1].trim();
    if (value) {
      const merged = { ...(editingSession.extractedData as any), merchantName: value };
      await resetSessionToPending(editingSession.id, merged);
      if (merged.case === 'FOREIGN') {
        await sendForeignConfirmationMessage(fromNumber, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(fromNumber, merged, editingSession.id);
      }
      return;
    }
  }

  const categoryPrefixPattern = /^\s*(?:kategori|kategorinya|category|categoryname)\s*[:\s\-]?\s*(.+)$/i;
  const categoryMatch = cleanText.match(categoryPrefixPattern);
  if (categoryMatch) {
    const value = categoryMatch[1].trim();
    if (value) {
      const merged = { ...(editingSession.extractedData as any), suggestedCategory: value };
      await resetSessionToPending(editingSession.id, merged);
      if (merged.case === 'FOREIGN') {
        await sendForeignConfirmationMessage(fromNumber, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(fromNumber, merged, editingSession.id);
      }
      return;
    }
  }

  // Only treat the message as a pure "amount update" when it contains ONLY a number
  // (with optional whitespace and unit suffix). If the user mentions any field keyword
  // like "deskripsinya", "kategori", "merchantnya", etc., we must forward to AI so it
  // applies the correct field, rather than blindly overwriting the amount.
  const FIELD_KEYWORDS = /deskripsi|kategori|merchant|toko|tanggal|kurs|total|harga/i;
  const pureAmountPattern = /^\s*(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?\s*$/i;
  const pureAmountMatch = correctionText.match(pureAmountPattern);

  if (pureAmountMatch && !FIELD_KEYWORDS.test(correctionText)) {
    const raw = Number(pureAmountMatch[1].replace(',', '.'));
    const unit = pureAmountMatch[2];
    let amount = raw;
    if (unit === 'rb' || unit === 'ribu' || unit === 'k') amount = raw * 1000;
    if (unit === 'jt' || unit === 'juta') amount = raw * 1000000;
    const merged = { ...(editingSession.extractedData as any), amount, totalAmount: amount };
    await resetSessionToPending(editingSession.id, merged);
    if (merged.case === 'FOREIGN') {
      await sendForeignConfirmationMessage(fromNumber, merged, editingSession.id);
    } else {
      await sendConfirmationMessage(fromNumber, merged, editingSession.id);
    }
    return;
  }

  let corrected = await applyUserCorrection(correctionText, editingSession.extractedData as object);

  // 2. Fallback: If AI fails (no field matched) and user sent a text correction,
  // treat the input as the new transaction description.
  if (isAIError(corrected)) {
    console.log('[AI] WhatsApp correction failed, falling back to description overwrite');
    const value = cleanText;
    if (value.length > 0) {
      corrected = { description: value };
    } else {
      await WhatsAppService.sendTextMessage(fromNumber, '😔 Gagal menerapkan koreksi. Tulis lebih jelas ya.');
      return;
    }
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
  const merchant   = data.merchantName || '-';
  const description = data.description || '-';
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

  const messagingAccount = await prisma.messagingAccount.findFirst({
    where: { platform: 'WHATSAPP', externalId: fromNumber },
    select: { id: true }
  });
  if (!messagingAccount) return;
  const messagingAccountId = messagingAccount.id;

  const account = data.accountId
    ? await prisma.account.findFirst({ where: { id: data.accountId, messagingAccountId, isActive: true } })
    : await prisma.account.findFirst({ where: { messagingAccountId, isActive: true }, orderBy: { createdAt: 'asc' } });
  
  const accountName = account ? account.name : 'Belum ditentukan';

  await WhatsAppService.sendInteractiveButtons(
    fromNumber,
    `🧾 *GOCENG mendeteksi transaksi:*\n\n` +
    `• 🏪 Merchant: *${merchant}*\n` +
    `• 📝 Deskripsi: *${description}*\n` +
    `• 💰 Total: *Rp ${amount}*\n` +
    `• 📁 Kategori: *${category}*\n` +
    `• 🏦 Rekening: *${accountName}*\n` +
    `• 📅 Tanggal: *${date}*\n` +
    `• 🤖 Keyakinan AI: *${confidence}%*\n\n` +
    `🛒 *Detail Item:*\n${itemText}\n\n` +
    `Apakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: 'btn_change_account', title: '🏦 Ubah Rekening' },
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
  const merchant       = data.merchantName || '-';
  const description    = data.description || '-';
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

  const messagingAccount = await prisma.messagingAccount.findFirst({
    where: { platform: 'WHATSAPP', externalId: fromNumber },
    select: { id: true }
  });
  if (!messagingAccount) return;
  const messagingAccountId = messagingAccount.id;

  const account = data.accountId
    ? await prisma.account.findFirst({ where: { id: data.accountId, messagingAccountId, isActive: true } })
    : await prisma.account.findFirst({ where: { messagingAccountId, isActive: true }, orderBy: { createdAt: 'asc' } });
  
  const accountName = account ? account.name : 'Belum ditentukan';

  await WhatsAppService.sendInteractiveButtons(
    fromNumber,
    `🌏 *GOCENG mendeteksi struk LUAR NEGERI:*\n\n` +
    `• 🏪 Merchant: *${merchant}*\n` +
    `• 📝 Deskripsi: *${description}*\n` +
    `• 💵 Total asli: *${data.originalCurrency} ${originalAmount}*\n` +
    `• 💱 Kurs pakai: *1 ${data.originalCurrency} = Rp ${exchangeRate}*\n` +
    `• 💰 Total IDR: *Rp ${totalIDR}*\n` +
    `• 📁 Kategori: *${category}*\n` +
    `• 🏦 Rekening: *${accountName}*\n` +
    `• 📅 Tanggal: *${date}*\n` +
    `• 🤖 Keyakinan AI: *${confidence}%*\n\n` +
    `⚠️ _Kurs adalah perkiraan. Koreksi jika perlu._\n\n` +
    `🛒 *Detail Item:*\n${itemText}\n\n` +
    `Apakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: 'btn_change_account', title: '🏦 Ubah Rekening' },
      { id: BTN_EDIT,    title: '✏️ Edit Kurs'  },
      { id: BTN_CANCEL,  title: '❌ Batal'      },
    ]
  );
};