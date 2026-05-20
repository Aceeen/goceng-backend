import { Request, Response } from 'express';
import { env } from '../../config/env';
import { TelegramService } from './telegram.service';
import { prisma } from '../../config/prisma';

// AI Module
import { extractFromImage, extractFromText, applyUserCorrection } from '../ai/ai.service';
import { isAIError, isOCRBlur, isOCRForeign, isOCRNormal, OCRNormalResult, OCRForeignResult, NLPResult } from '../ai/ai.types';

// Session & Transaction
import { createSession, getPendingSession, updateSessionStatus, resetSessionToPending } from '../session/session.service';
import { saveConfirmedTransaction } from '../transaction/transaction.save';

const BTN_CONFIRM = 'btn_confirm';
const BTN_EDIT    = 'btn_edit';
const BTN_CANCEL  = 'btn_cancel';

export const receiveTelegramMessage = (req: Request, res: Response) => {
  // Telegram requires 200 OK immediately
  res.status(200).json({ status: 'received' });
  
  setImmediate(() => {
    processTelegramPayload(req.body).catch((err) => {
      console.error('❌ Error processing Telegram webhook async:', err);
    });
  });
};

const processTelegramPayload = async (payload: any) => {
  try {
    let externalId: string | null = null;
    let messageId: string | null = null;
    let textBody: string | null = null;
    let mediaId: string | null = null;
    let buttonData: string | null = null;

    if (payload.callback_query) {
      externalId = payload.callback_query.message.chat.id.toString();
      buttonData = payload.callback_query.data;
    } else if (payload.message) {
      externalId = payload.message.chat.id.toString();
      messageId = payload.message.message_id.toString();

      if (payload.message.text) {
        textBody = payload.message.text;
      } else if (payload.message.photo) {
        // Get the highest resolution photo
        const photos = payload.message.photo;
        mediaId = photos[photos.length - 1].file_id;
      }
    }

    if (!externalId) return;

    // Check if user is registered via Google OAuth
    const messagingAccount = await prisma.messagingAccount.findFirst({ where: { platform: 'TELEGRAM', externalId } });
    if (!messagingAccount) {
      const backendUrl = env.BACKEND_URL ?? env.FRONTEND_URL;
      const loginLink = `${backendUrl}/v1/auth/google?tg=${externalId}`;
      await TelegramService.sendTextMessage(
        externalId,
        `Halo\\! Selamat datang di *GOCENG* 🤖📊\n\nAkun Telegram kamu belum terhubung ke Google\\. Klik tombol di bawah untuk login:\n\n[🔗 Login dengan Google](${loginLink})\n\nSetelah login, sapa saya kembali\\!`
      );
      return;
    }

    // ── ONBOARDING GATE: New users must set up an account first ──────────────
    if (!messagingAccount.isOnboarded) {
      await handleOnboarding(externalId, messagingAccount.id, textBody, buttonData);
      return;
    }

    const allCategories = await prisma.category.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    const categoryNames = allCategories.map((c) => c.name);

    // ── ROUTING: Buttons ──
    if (buttonData) {
      await handleButtonReply(externalId, messagingAccount.id, buttonData);
      return;
    }

    // ── ROUTING: EDITED Session (Corrections) ──
    const editingSession = await prisma.transactionSession.findFirst({
      where: { messagingAccountId: messagingAccount.id, status: 'EDITED', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (editingSession && textBody) {
      await handleEditCorrection(externalId, editingSession, textBody);
      return;
    }

    // ── ROUTING: New Message ──
    if (textBody) {
      await handleTextMessage(externalId, messagingAccount.id, textBody, messageId!, categoryNames);
    } else if (mediaId) {
      await handleImageMessage(externalId, messagingAccount.id, mediaId, messageId!);
    } else {
      await TelegramService.sendTextMessage(externalId, '📎 GOCENG hanya bisa memproses pesan teks atau foto struk ya!');
    }
  } catch (error) {
    console.error('❌ processTelegramPayload error:', error);
  }
};

// =============================================================================
// ONBOARDING FLOW: Name → Type → Initial Balance → Done
// =============================================================================
const OB_ACCOUNT_TYPES: { id: string; title: string }[] = [
  { id: 'ob_BANK',        title: '🏦 Bank' },
  { id: 'ob_E_WALLET',    title: '📱 E-Wallet' },
  { id: 'ob_CASH',        title: '💵 Tunai / Cash' },
  { id: 'ob_CREDIT_CARD', title: '💳 Kartu Kredit' },
  { id: 'ob_INVESTMENT',  title: '📈 Investasi' },
];

const handleOnboarding = async (
  externalId: string,
  messagingAccountId: string,
  textBody: string | null,
  buttonData: string | null
) => {
  const ONBOARDING_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

  // Look for an active onboarding session
  const session = await prisma.transactionSession.findFirst({
    where: { messagingAccountId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  const sessionData = session?.extractedData as any;

  // ── STEP 0: No session yet → welcome + ask for account name ──────────────
  if (!session || sessionData?.type !== 'ONBOARDING') {
    await TelegramService.sendTextMessage(
      externalId,
      `👋 Selamat datang di *GOCENG*! Akun kamu berhasil terhubung 🎉\n\n` +
      `Sebelum mulai mencatat transaksi, ayo setup *rekening pertama* kamu.\n\n` +
      `📝 Apa nama rekeningmu?\n_Contoh: BCA, GoPay, Dompet Tunai_`
    );
    await prisma.transactionSession.create({
      data: {
        messagingAccountId,
        platform: 'TELEGRAM',
        status: 'PENDING',
        extractedData: { type: 'ONBOARDING', step: 'ASK_ACCOUNT_NAME' },
        rawPayload: {},
        expiresAt: new Date(Date.now() + ONBOARDING_EXPIRY_MS),
      },
    });
    return;
  }

  const step = sessionData.step;

  // ── STEP 1: Received account name → ask type ──────────────────────────────
  if (step === 'ASK_ACCOUNT_NAME' && textBody) {
    await prisma.transactionSession.update({
      where: { id: session.id },
      data: { extractedData: { type: 'ONBOARDING', step: 'ASK_ACCOUNT_TYPE', name: textBody.trim() } },
    });
    await TelegramService.sendInteractiveButtons(
      externalId,
      `Oke, rekening *${textBody.trim()}*! Jenis rekeningnya apa?`,
      OB_ACCOUNT_TYPES
    );
    return;
  }

  // ── STEP 2: Received account type button → ask initial balance ────────────
  if (step === 'ASK_ACCOUNT_TYPE' && buttonData?.startsWith('ob_')) {
    const accountType = buttonData.replace('ob_', '');
    await prisma.transactionSession.update({
      where: { id: session.id },
      data: { extractedData: { ...sessionData, step: 'ASK_INITIAL_BALANCE', accountType } },
    });
    await TelegramService.sendTextMessage(
      externalId,
      `Berapa *saldo awal* rekening *${sessionData.name}*?\n\n` +
      `Tulis angka saja, contoh: _500000_ atau _1500000_\n` +
      `(Tulis 0 jika ingin mulai dari nol)`
    );
    return;
  }

  // ── STEP 3: Received initial balance → create account ────────────────────
  if (step === 'ASK_INITIAL_BALANCE' && textBody) {
    const cleaned = textBody.replace(/[^0-9]/g, '');
    const initialBalance = Number(cleaned);
    if (isNaN(initialBalance) || cleaned === '') {
      await TelegramService.sendTextMessage(externalId, '❌ Format salah. Tulis angka saja, contoh: _500000_');
      return;
    }

    await prisma.account.create({
      data: {
        messagingAccountId,
        name: sessionData.name,
        type: sessionData.accountType,
        initialBalance,
        currentBalance: initialBalance,
      },
    });

    await prisma.messagingAccount.update({
      where: { id: messagingAccountId },
      data: { isOnboarded: true },
    });

    await prisma.transactionSession.update({
      where: { id: session.id },
      data: { status: 'SAVED' },
    });

    const balanceFormatted = initialBalance.toLocaleString('id-ID');
    await TelegramService.sendTextMessage(
      externalId,
      `✅ *Rekening ${sessionData.name} berhasil dibuat!*\n` +
      `💰 Saldo awal: Rp ${balanceFormatted}\n\n` +
      `🎉 GOCENG siap digunakan! Sekarang kamu bisa:\n` +
      `• Kirim pesan seperti _"Makan siang 25rb"_\n` +
      `• Foto struk belanja untuk dicatat otomatis 📸`
    );
    return;
  }

  // ── Fallback: wrong input at current step ─────────────────────────────────
  if (step === 'ASK_ACCOUNT_NAME') {
    await TelegramService.sendTextMessage(externalId, '📝 Ketik nama rekeningmu ya, contoh: _BCA_ atau _GoPay_');
  } else if (step === 'ASK_ACCOUNT_TYPE') {
    await TelegramService.sendInteractiveButtons(externalId, 'Pilih jenis rekening:', OB_ACCOUNT_TYPES);
  } else if (step === 'ASK_INITIAL_BALANCE') {
    await TelegramService.sendTextMessage(externalId, '💰 Tulis saldo awal dalam angka, contoh: _500000_');
  }
};

const handleTextMessage = async (externalId: string, messagingAccountId: string, text: string, messageId: string, categoryNames: string[]) => {
  await TelegramService.sendTextMessage(externalId, '⏳ Sedang memproses pesan kamu...');
  
  const result = await extractFromText(text, categoryNames);

  if (isAIError(result)) {
    const msg = result.error === 'NO_AMOUNT'
      ? '❓ Nominal tidak ditemukan. Coba tulis seperti:\n• _"Makan siang 25rb"_\n• _"Bensin 50000"_'
      : '😔 Layanan AI sedang sibuk. Coba lagi dalam beberapa menit.';
    await TelegramService.sendTextMessage(externalId, msg);
    return;
  }

  const session = await createSession(messagingAccountId, 'TELEGRAM', result, { text }, messageId);
  await sendConfirmationMessage(externalId, result, session.id);
};

const handleImageMessage = async (externalId: string, messagingAccountId: string, mediaId: string, messageId: string) => {
  await TelegramService.sendTextMessage(externalId, '🔍 Sedang membaca struk kamu...');

  // Download the file from Telegram servers to a buffer
  const mediaData = await TelegramService.downloadMedia(mediaId);
  if (!mediaData) {
    await TelegramService.sendTextMessage(externalId, '❌ Gagal mengunduh foto dari Telegram.');
    return;
  }

  const base64 = mediaData.buffer.toString('base64');
  const result = await extractFromImage(base64, mediaData.mimeType);

  if (isAIError(result)) {
    await TelegramService.sendTextMessage(externalId, '😔 Layanan AI sedang sibuk. Coba lagi dalam beberapa menit.');
    return;
  }

  if (isOCRBlur(result)) {
    await TelegramService.sendTextMessage(externalId, `📸 *Foto struk tidak bisa dibaca*\n\nCoba foto ulang ya!`);
    return;
  }

  if (isOCRNormal(result)) {
    const session = await createSession(messagingAccountId, 'TELEGRAM', result, { mediaId }, messageId);
    await sendConfirmationMessage(externalId, result, session.id);
    return;
  }

  if (isOCRForeign(result)) {
    const session = await createSession(messagingAccountId, 'TELEGRAM', result, { mediaId }, messageId);
    await sendForeignConfirmationMessage(externalId, result, session.id);
    return;
  }
};

const handleButtonReply = async (externalId: string, messagingAccountId: string, buttonId: string) => {
  const session = await getPendingSession(messagingAccountId);

  if (!session) {
    await TelegramService.sendTextMessage(externalId, '⏰ Sesi konfirmasi sudah kedaluwarsa (15 menit). Kirim ulang transaksimu ya!');
    return;
  }

  if (buttonId === BTN_CONFIRM) {
    try {
      const data = session.extractedData as any;
      const { account } = await saveConfirmedTransaction(messagingAccountId, data);

      await updateSessionStatus(session.id, 'SAVED');

      const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
      const saldo = Number(account?.currentBalance ?? 0).toLocaleString('id-ID');
      
      await TelegramService.sendTextMessage(
        externalId,
        `✅ *Transaksi berhasil dicatat!*\n\n💰 *Sisa saldo ${account?.name ?? 'rekening'}: Rp ${saldo}*`
      );
    } catch (err) {
      console.error('Gagal simpan transaksi:', err);
      await updateSessionStatus(session.id, 'FAILED');
      await TelegramService.sendTextMessage(externalId, '❌ Gagal menyimpan transaksi. Coba lagi ya.');
    }
    return;
  }

  if (buttonId === BTN_EDIT) {
    await updateSessionStatus(session.id, 'EDITED');
    await TelegramService.sendTextMessage(externalId, '✏️ Apa yang ingin dikoreksi?\n\nContoh:\n• _"Harganya 55000"_\n• _"Kategori: Transportasi"_');
    return;
  }

  if (buttonId === BTN_CANCEL) {
    await updateSessionStatus(session.id, 'CANCELLED');
    await TelegramService.sendTextMessage(externalId, '🚫 Transaksi dibatalkan.');
  }
};

const handleEditCorrection = async (externalId: string, editingSession: any, correctionText: string) => {
  await TelegramService.sendTextMessage(externalId, '✏️ Menerapkan koreksimu...');
  
  const match = correctionText.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)?/);
  if (match) {
    const raw = Number(match[1].replace(',', '.'));
    const unit = match[2];

    let amount = raw;
    if (unit === 'rb' || unit === 'ribu' || unit === 'k') amount = raw * 1000;
    if (unit === 'jt' || unit === 'juta') amount = raw * 1000000;

    const merged = { ...(editingSession.extractedData as any), amount, totalAmount: amount };
    await resetSessionToPending(editingSession.id, merged);
    await sendConfirmationMessage(externalId, merged, editingSession.id);
    return;
  }

  const corrected = await applyUserCorrection(correctionText, editingSession.extractedData as object);
  if (isAIError(corrected)) {
    await TelegramService.sendTextMessage(externalId, '😔 Gagal menerapkan koreksi. Tulis lebih jelas ya.');
    return;
  }

  const merged = { ...(editingSession.extractedData as object), ...corrected };
  await resetSessionToPending(editingSession.id, merged);
  await sendConfirmationMessage(externalId, merged as any, editingSession.id);
};

const sendConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
  const merchant = data.merchantName ?? data.description ?? 'Tidak diketahui';
  const category = data.suggestedCategory ?? 'Belum dikategorikan';

  await TelegramService.sendInteractiveButtons(
    externalId,
    `🧾 *GOCENG mendeteksi transaksi:*\n\n` +
    `• 🏪 Merchant: *${merchant}*\n` +
    `• 💰 Total: *Rp ${amount}*\n` +
    `• 📁 Kategori: *${category}*\n\n` +
    `Apakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: BTN_EDIT,    title: '✏️ Edit' },
      { id: BTN_CANCEL,  title: '❌ Batal' },
    ]
  );
};

const sendForeignConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const totalIDR = Number(data.totalAmount).toLocaleString('id-ID');
  await TelegramService.sendInteractiveButtons(
    externalId,
    `🌏 *GOCENG mendeteksi struk LUAR NEGERI:*\n\n` +
    `• 💰 Total IDR: *Rp ${totalIDR}*\n\nApakah data ini sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: BTN_EDIT,    title: '✏️ Edit' },
      { id: BTN_CANCEL,  title: '❌ Batal' },
    ]
  );
};
