import { Request, Response } from 'express';
import { env } from '../../config/env';
import { TelegramService } from './telegram.service';
import { prisma } from '../../config/prisma';
import { DriveService } from '../sheets/drive.service';

// AI Module
import { extractFromImage, extractFromText, applyUserCorrection } from '../ai/ai.service';
import { isAIError, isOCRBlur, isOCRForeign, isOCRNormal } from '../ai/ai.types';

// Session & Transaction
import { createSession, getPendingSession, updateSessionStatus, resetSessionToPending } from '../session/session.service';
import { saveConfirmedTransaction } from '../transaction/transaction.save';

const BTN_CONFIRM = 'btn_confirm';
const BTN_EDIT    = 'btn_edit';
const BTN_CANCEL  = 'btn_cancel';

const MONTHS_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

const OB_ACCOUNT_TYPES = [
  { id: 'ob_BANK',        title: '🏦 Bank' },
  { id: 'ob_E_WALLET',    title: '📱 E-Wallet' },
  { id: 'ob_CASH',        title: '💵 Tunai / Cash' },
  { id: 'ob_CREDIT_CARD', title: '💳 Kartu Kredit' },
  { id: 'ob_INVESTMENT',  title: '📈 Investasi' },
];

// =============================================================================
// EXPRESS HANDLER
// =============================================================================
export const receiveTelegramMessage = (req: Request, res: Response) => {
  res.status(200).json({ status: 'received' });
  setImmediate(() => {
    processTelegramPayload(req.body).catch((err) => {
      console.error('❌ Telegram webhook error:', err);
    });
  });
};

// =============================================================================
// MAIN ROUTER
// =============================================================================
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
      if (payload.message.text) textBody = payload.message.text;
      else if (payload.message.photo) {
        const photos = payload.message.photo;
        mediaId = photos[photos.length - 1].file_id;
      } else if (payload.message.document) {
        const doc = payload.message.document;
        const mimeType = doc.mime_type || '';
        if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
          mediaId = doc.file_id;
        }
      }
    }

    if (!externalId) return;

    // ── Auth check ──────────────────────────────────────────────────────────
    const messagingAccount = await prisma.messagingAccount.findFirst({
      where: { platform: 'TELEGRAM', externalId },
      select: { id: true, isOnboarded: true, userId: true, spreadsheetId: true },
    });

    if (!messagingAccount) {
      const loginLink = `${env.BACKEND_URL ?? env.FRONTEND_URL}/v1/auth/google?tg=${externalId}`;
      await TelegramService.sendTextMessage(
        externalId,
        `Halo! Selamat datang di *GOCENG* 🤖\n\nAkun Telegram kamu belum terhubung ke Google.\n\n[🔗 Login dengan Google](${loginLink})\n\nSetelah login, sapa saya kembali!`
      );
      return;
    }

    // ── Onboarding gate ─────────────────────────────────────────────────────
    if (!messagingAccount.isOnboarded) {
      await handleOnboarding(externalId, messagingAccount.id, textBody, buttonData);
      return;
    }

    // Load active session early to support multi-step button routing
    const menuSession = await prisma.transactionSession.findFirst({
      where: { messagingAccountId: messagingAccount.id, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    // ── Menu button routing ──────────────────────────────────────────────────
    if (buttonData && !buttonData.startsWith('btn_')) {
      await handleMenuRouter(externalId, messagingAccount, buttonData, textBody, menuSession || undefined);
      return;
    }

    // ── Transaction button routing ───────────────────────────────────────────
    if (buttonData?.startsWith('btn_')) {
      await handleButtonReply(externalId, messagingAccount.id, buttonData);
      return;
    }

    // ── Check for active menu sessions (multi-step flows) ───────────────────
    const menuSessionData = menuSession?.extractedData as any;

    if (menuSession && (menuSessionData?.type === 'ADD_ACCOUNT' || menuSessionData?.type === 'MENU_UBAH_SALDO' || menuSessionData?.type === 'ROUTINE_ADD' || menuSessionData?.type === 'ROUTINE_EDIT')) {
      await handleMenuRouter(externalId, messagingAccount, null, textBody, menuSession);
      return;
    }

    // ── EDITED session (AI correction) ──────────────────────────────────────
    const editingSession = await prisma.transactionSession.findFirst({
      where: { messagingAccountId: messagingAccount.id, status: 'EDITED', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (editingSession && textBody) {
      await handleEditCorrection(externalId, editingSession, textBody);
      return;
    }

    // ── New message ─────────────────────────────────────────────────────────
    const allCategories = await prisma.category.findMany({ select: { name: true }, orderBy: { name: 'asc' } });
    const categoryNames = allCategories.map((c) => c.name);

    // Handle slash commands
    if (textBody?.startsWith('/')) {
      await sendMainMenu(externalId);
      return;
    }

    if (textBody) {
      await handleTextMessage(externalId, messagingAccount.id, textBody, messageId!, categoryNames);
    } else if (mediaId) {
      await handleImageMessage(externalId, messagingAccount.id, mediaId, messageId!);
    } else {
      await sendMainMenu(externalId);
    }
  } catch (error) {
    console.error('❌ processTelegramPayload error:', error);
  }
};

// =============================================================================
// MAIN MENU
// =============================================================================
const sendMainMenu = async (externalId: string, preamble?: string) => {
  const text = preamble ? `${preamble}\n\nAda yang bisa dibantu? 😊` : 'Ada yang bisa dibantu? 😊';
  await TelegramService.sendInteractiveButtons(externalId, text, [
    { id: 'menu_transaksi', title: '💳 Tambah Transaksi' },
    { id: 'menu_rekening',  title: '💼 Kelola Rekening' },
    { id: 'menu_rutin',     title: '📅 Pengeluaran Rutin' },
    { id: 'menu_cetak',     title: '🖨️ Cetak Laporan (SPS)' },
  ]);
};

// =============================================================================
// MENU ROUTER — handles all menu_*, ob_*, cetak_*, ubah_* callbacks
// =============================================================================
const handleMenuRouter = async (
  externalId: string,
  account: { id: string; userId: string; spreadsheetId: string | null },
  buttonData: string | null,
  textBody: string | null,
  activeSession?: any
) => {
  const SESSION_TTL = 15 * 60 * 1000;
  const sessionData = activeSession?.extractedData as any;

  // ── Main menu options ────────────────────────────────────────────────────
  if (buttonData === 'menu_transaksi') {
    await TelegramService.sendTextMessage(
      externalId,
      '💳 Silakan kirim pesan atau foto struk transaksimu!\n\n_Contoh: "Makan siang 25rb" atau foto struk 📸_'
    );
    return;
  }

  if (buttonData === 'menu_rekening') {
    await TelegramService.sendInteractiveButtons(externalId, '💼 *Kelola Rekening*\n\nMau ngapain?', [
      { id: 'menu_rekening_tambah', title: '➕ Tambah Rekening' },
      { id: 'menu_rekening_ubah',   title: '✏️ Ubah Saldo' },
    ]);
    return;
  }

  if (buttonData === 'menu_cetak') {
    const now = new Date();
    const months = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ id: `cetak_${d.getMonth() + 1}_${d.getFullYear()}`, title: `${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}` });
    }
    await TelegramService.sendInteractiveButtons(externalId, '🖨️ *Cetak Laporan SPS*\n\nPilih bulan:', months);
    return;
  }

  // ── Cetak: generate PDF ──────────────────────────────────────────────────
  if (buttonData?.startsWith('cetak_')) {
    const parts = buttonData.split('_');
    const month = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    const sheetName = `${MONTHS_ID[month - 1]} ${year}`;

    await TelegramService.sendTextMessage(externalId, `⏳ Sedang mencetak *${sheetName}*...`);

    if (!account.spreadsheetId) {
      await TelegramService.sendTextMessage(externalId, '❌ Google Sheet belum terhubung.');
      return;
    }

    const pdfBuffer = await DriveService.exportSheetByName(account.userId, account.spreadsheetId, sheetName);
    if (!pdfBuffer) {
      await TelegramService.sendTextMessage(externalId, `❌ Tab *${sheetName}* tidak ditemukan di spreadsheet.`);
      return;
    }

    await TelegramService.sendDocument(externalId, pdfBuffer, `GOCENG_${sheetName}.pdf`);
    return;
  }

  // ── Rutin main submenu ────────────────────────────────────────────────────
  if (buttonData === 'menu_rutin') {
    await TelegramService.sendInteractiveButtons(externalId, '📅 *Pengeluaran Rutin*\n\nMau ngapain?', [
      { id: 'menu_rutin_tambah', title: '➕ Tambah Rutin Baru' },
      { id: 'menu_rutin_kelola', title: '📋 Lihat & Kelola Rutin' },
    ]);
    return;
  }

  // ── Rutin: start add flow ─────────────────────────────────────────────────
  if (buttonData === 'menu_rutin_tambah') {
    await TelegramService.sendTextMessage(externalId, '➕ *Tambah Pengeluaran Rutin*\n\n📝 Apa nama pengeluaran rutin ini?\n_Contoh: Sewa Kos, Netflix, Uang Bensin_');
    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'ROUTINE_ADD', step: 'ASK_TITLE' }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── Rutin: list for management ────────────────────────────────────────────
  if (buttonData === 'menu_rutin_kelola') {
    const routines = await prisma.routineExpense.findMany({
      where: { messagingAccountId: account.id, isActive: true },
      select: { id: true, title: true, amount: true, frequency: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!routines.length) {
      await TelegramService.sendTextMessage(externalId, '📋 Belum ada pengeluaran rutin. Tambah dulu ya!');
      return;
    }
    const FREQ_LABEL: Record<string, string> = { DAILY: 'Harian', WEEKLY: 'Mingguan', MONTHLY: 'Bulanan', ANNUALLY: 'Tahunan' };
    await TelegramService.sendInteractiveButtons(
      externalId, '📋 Pilih rutin yang mau dikelola:',
      routines.map(r => ({ id: `rutin_sel_${r.id}`, title: `${r.title} — Rp ${Number(r.amount).toLocaleString('id-ID')} (${FREQ_LABEL[r.frequency]})` }))
    );
    return;
  }

  // ── Rutin: selected — show actions ────────────────────────────────────────
  if (buttonData?.startsWith('rutin_sel_')) {
    const routineId = buttonData.replace('rutin_sel_', '');
    const routine = await prisma.routineExpense.findFirst({ where: { id: routineId, messagingAccountId: account.id }, select: { title: true, amount: true } });
    if (!routine) { await TelegramService.sendTextMessage(externalId, '❌ Rutin tidak ditemukan.'); return; }
    await TelegramService.sendInteractiveButtons(
      externalId,
      `📅 *${routine.title}*\nSaat ini: Rp ${Number(routine.amount).toLocaleString('id-ID')}\n\nMau ngapain?`,
      [
        { id: `rutin_edit_${routineId}`,  title: '✏️ Edit Jumlah' },
        { id: `rutin_del_${routineId}`,   title: '🗑️ Nonaktifkan' },
      ]
    );
    return;
  }

  // ── Rutin: delete (deactivate) ────────────────────────────────────────────
  if (buttonData?.startsWith('rutin_del_')) {
    const routineId = buttonData.replace('rutin_del_', '');
    const routine = await prisma.routineExpense.findFirst({ where: { id: routineId, messagingAccountId: account.id }, select: { title: true } });
    if (!routine) { await TelegramService.sendTextMessage(externalId, '❌ Rutin tidak ditemukan.'); return; }
    await prisma.routineExpense.update({ where: { id: routineId }, data: { isActive: false } });
    await TelegramService.sendTextMessage(externalId, `✅ *${routine.title}* berhasil dinonaktifkan.`);
    return;
  }

  // ── Rutin: start edit amount ──────────────────────────────────────────────
  if (buttonData?.startsWith('rutin_edit_')) {
    const routineId = buttonData.replace('rutin_edit_', '');
    const routine = await prisma.routineExpense.findFirst({ where: { id: routineId, messagingAccountId: account.id }, select: { title: true, amount: true } });
    if (!routine) { await TelegramService.sendTextMessage(externalId, '❌ Rutin tidak ditemukan.'); return; }
    await TelegramService.sendTextMessage(externalId, `✏️ Jumlah baru untuk *${routine.title}*?\n_Tulis angka saja, contoh: 350000_`);
    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'ROUTINE_EDIT', routineId, routineTitle: routine.title }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── ROUTINE_EDIT: receive new amount ──────────────────────────────────────
  if (sessionData?.type === 'ROUTINE_EDIT' && textBody) {
    const amount = Number(textBody.replace(/[^0-9]/g, ''));
    if (!amount) { await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 350000'); return; }
    await prisma.routineExpense.update({ where: { id: sessionData.routineId }, data: { amount } });
    await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });
    await TelegramService.sendTextMessage(externalId, `✅ *${sessionData.routineTitle}* diperbarui: Rp ${amount.toLocaleString('id-ID')}`);
    return;
  }

  // ── ROUTINE_ADD multi-step ─────────────────────────────────────────────────
  if (sessionData?.type === 'ROUTINE_ADD') {
    const FREQ_BTNS = [
      { id: 'rutin_freq_DAILY',    title: '📆 Harian' },
      { id: 'rutin_freq_WEEKLY',   title: '🗓️ Mingguan' },
      { id: 'rutin_freq_MONTHLY',  title: '📅 Bulanan' },
      { id: 'rutin_freq_ANNUALLY', title: '🗃️ Tahunan' },
    ];

    if (sessionData.step === 'ASK_TITLE' && textBody) {
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { extractedData: { ...sessionData, step: 'ASK_AMOUNT', title: textBody.trim() } } });
      await TelegramService.sendTextMessage(externalId, `💰 Berapa jumlah *${textBody.trim()}* setiap periodenya?\n_Tulis angka saja, contoh: 500000_`);
      return;
    }

    if (sessionData.step === 'ASK_AMOUNT' && textBody) {
      const amount = Number(textBody.replace(/[^0-9]/g, ''));
      if (!amount) { await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 500000'); return; }
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { extractedData: { ...sessionData, step: 'ASK_FREQUENCY', amount } } });
      await TelegramService.sendInteractiveButtons(externalId, '🔁 Seberapa sering pengeluaran ini terjadi?', FREQ_BTNS);
      return;
    }

    if (sessionData.step === 'ASK_FREQUENCY' && buttonData?.startsWith('rutin_freq_')) {
      const frequency = buttonData.replace('rutin_freq_', '');
      const accounts = await prisma.account.findMany({ where: { messagingAccountId: account.id, isActive: true }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
      if (!accounts.length) { await TelegramService.sendTextMessage(externalId, '❌ Tidak ada rekening aktif.'); return; }
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { extractedData: { ...sessionData, step: 'ASK_ACCOUNT', frequency } } });
      await TelegramService.sendInteractiveButtons(externalId, '🏦 Dari rekening mana biaya ini dipotong?',
        accounts.map(a => ({ id: `rutin_acc_${a.id}`, title: a.name }))
      );
      return;
    }

    if (sessionData.step === 'ASK_ACCOUNT' && buttonData?.startsWith('rutin_acc_')) {
      const accountId = buttonData.replace('rutin_acc_', '');
      await prisma.routineExpense.create({ data: {
        messagingAccountId: account.id,
        accountId,
        title: sessionData.title,
        amount: sessionData.amount,
        frequency: sessionData.frequency,
        startDate: new Date(),
        isActive: true,
      }});
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });
      const FREQ_LABEL: Record<string, string> = { DAILY: 'Harian', WEEKLY: 'Mingguan', MONTHLY: 'Bulanan', ANNUALLY: 'Tahunan' };
      await TelegramService.sendTextMessage(externalId,
        `✅ *${sessionData.title}* ditambahkan!\n` +
        `💰 Rp ${Number(sessionData.amount).toLocaleString('id-ID')} — ${FREQ_LABEL[sessionData.frequency]}\n` +
        `📅 Mulai: Hari ini`
      );
      return;
    }
  }

  // ── Tambah Rekening ───────────────────────────────────────────────────────
  if (buttonData === 'menu_rekening_tambah') {
    await TelegramService.sendTextMessage(externalId, '➕ *Tambah Rekening Baru*\n\n📝 Apa nama rekeningnya?\n_Contoh: BCA, GoPay, Tunai_');
    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'ADD_ACCOUNT', step: 'ASK_ACCOUNT_NAME' }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── Ubah Saldo: show account list ────────────────────────────────────────
  if (buttonData === 'menu_rekening_ubah') {
    const accounts = await prisma.account.findMany({
      where: { messagingAccountId: account.id, isActive: true },
      select: { id: true, name: true, currentBalance: true }, orderBy: { createdAt: 'asc' },
    });
    if (!accounts.length) {
      await TelegramService.sendTextMessage(externalId, '❌ Belum ada rekening. Tambah rekening dulu ya!');
      return;
    }
    await TelegramService.sendInteractiveButtons(
      externalId, '✏️ Pilih rekening yang mau diubah saldonya:',
      accounts.map(a => ({ id: `ubah_${a.id}`, title: `${a.name} (Rp ${Number(a.currentBalance).toLocaleString('id-ID')})` }))
    );
    return;
  }

  // ── Ubah Saldo: account selected → ask new balance ───────────────────────
  if (buttonData?.startsWith('ubah_')) {
    const accountId = buttonData.replace('ubah_', '');
    const acc = await prisma.account.findFirst({ where: { id: accountId, messagingAccountId: account.id }, select: { name: true } });
    if (!acc) { await TelegramService.sendTextMessage(externalId, '❌ Rekening tidak ditemukan.'); return; }

    await TelegramService.sendTextMessage(externalId, `✏️ Berapa saldo baru rekening *${acc.name}*?\n_Tulis angka, contoh: 1500000_`);
    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'MENU_UBAH_SALDO', accountId, accountName: acc.name }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── ADD_ACCOUNT multi-step ───────────────────────────────────────────────
  if (sessionData?.type === 'ADD_ACCOUNT') {
    if (sessionData.step === 'ASK_ACCOUNT_NAME' && textBody) {
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { extractedData: { type: 'ADD_ACCOUNT', step: 'ASK_ACCOUNT_TYPE', name: textBody.trim() } } });
      await TelegramService.sendInteractiveButtons(externalId, `Rekening *${textBody.trim()}* — jenis apa?`, OB_ACCOUNT_TYPES);
      return;
    }
    if (sessionData.step === 'ASK_ACCOUNT_TYPE' && buttonData?.startsWith('ob_')) {
      const accountType = buttonData.replace('ob_', '');
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { extractedData: { ...sessionData, step: 'ASK_INITIAL_BALANCE', accountType } } });
      await TelegramService.sendTextMessage(externalId, `Berapa saldo awal rekening *${sessionData.name}*?\n_Tulis angka, contoh: 500000_`);
      return;
    }
    if (sessionData.step === 'ASK_INITIAL_BALANCE' && textBody) {
      const balance = Number(textBody.replace(/[^0-9]/g, ''));
      if (isNaN(balance)) { await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 500000'); return; }
      await prisma.account.create({ data: { messagingAccountId: account.id, name: sessionData.name, type: sessionData.accountType, initialBalance: balance, currentBalance: balance } });
      await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });
      await TelegramService.sendTextMessage(externalId, `✅ Rekening *${sessionData.name}* ditambahkan! Saldo: Rp ${balance.toLocaleString('id-ID')}`);
      return;
    }
  }

  // ── MENU_UBAH_SALDO: receive new balance ─────────────────────────────────
  if (sessionData?.type === 'MENU_UBAH_SALDO' && textBody) {
    const balance = Number(textBody.replace(/[^0-9]/g, ''));
    if (isNaN(balance)) { await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 1500000'); return; }
    await prisma.account.update({ where: { id: sessionData.accountId }, data: { currentBalance: balance } });
    await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });
    await TelegramService.sendTextMessage(externalId, `✅ Saldo *${sessionData.accountName}* diperbarui: Rp ${balance.toLocaleString('id-ID')}`);
    return;
  }

  // Fallback
  await sendMainMenu(externalId);
};

// =============================================================================
// ONBOARDING FLOW
// =============================================================================
const handleOnboarding = async (externalId: string, messagingAccountId: string, textBody: string | null, buttonData: string | null) => {
  const session = await prisma.transactionSession.findFirst({
    where: { messagingAccountId, status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  const sd = session?.extractedData as any;

  if (!session || sd?.type !== 'ONBOARDING') {
    await TelegramService.sendTextMessage(externalId,
      `👋 Selamat datang di *GOCENG*! Akun kamu berhasil terhubung 🎉\n\nSebelum mulai, setup *rekening pertama* kamu.\n\n📝 Apa nama rekeningmu?\n_Contoh: BCA, GoPay, Dompet Tunai_`
    );
    await prisma.transactionSession.create({ data: {
      messagingAccountId, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'ONBOARDING', step: 'ASK_ACCOUNT_NAME' }, rawPayload: {},
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }});
    return;
  }

  if (sd.step === 'ASK_ACCOUNT_NAME' && textBody) {
    await prisma.transactionSession.update({ where: { id: session.id }, data: { extractedData: { type: 'ONBOARDING', step: 'ASK_ACCOUNT_TYPE', name: textBody.trim() } } });
    await TelegramService.sendInteractiveButtons(externalId, `Oke, rekening *${textBody.trim()}*! Jenis apa?`, OB_ACCOUNT_TYPES);
    return;
  }

  if (sd.step === 'ASK_ACCOUNT_TYPE' && buttonData?.startsWith('ob_')) {
    const accountType = buttonData.replace('ob_', '');
    await prisma.transactionSession.update({ where: { id: session.id }, data: { extractedData: { ...sd, step: 'ASK_INITIAL_BALANCE', accountType } } });
    await TelegramService.sendTextMessage(externalId, `Berapa saldo awal *${sd.name}*?\n_Tulis angka saja, contoh: 500000 (tulis 0 jika mulai dari nol)_`);
    return;
  }

  if (sd.step === 'ASK_INITIAL_BALANCE' && textBody) {
    const balance = Number(textBody.replace(/[^0-9]/g, ''));
    if (isNaN(balance)) { await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 500000'); return; }
    await prisma.account.create({ data: { messagingAccountId, name: sd.name, type: sd.accountType, initialBalance: balance, currentBalance: balance } });
    await prisma.messagingAccount.update({ where: { id: messagingAccountId }, data: { isOnboarded: true } });
    await prisma.transactionSession.update({ where: { id: session.id }, data: { status: 'SAVED' } });
    await TelegramService.sendTextMessage(externalId,
      `✅ *Rekening ${sd.name} berhasil dibuat!*\n💰 Saldo awal: Rp ${balance.toLocaleString('id-ID')}\n\n🎉 GOCENG siap! Kamu bisa:\n• Kirim pesan _"Makan siang 25rb"_\n• Foto struk belanja 📸`
    );
    return;
  }

  // Fallback hints
  if (sd.step === 'ASK_ACCOUNT_NAME') await TelegramService.sendTextMessage(externalId, '📝 Ketik nama rekeningmu, contoh: _BCA_');
  else if (sd.step === 'ASK_ACCOUNT_TYPE') await TelegramService.sendInteractiveButtons(externalId, 'Pilih jenis rekening:', OB_ACCOUNT_TYPES);
  else if (sd.step === 'ASK_INITIAL_BALANCE') await TelegramService.sendTextMessage(externalId, '💰 Tulis saldo awal dalam angka, contoh: _500000_');
};

// =============================================================================
// TEXT MESSAGE → AI
// =============================================================================
const handleTextMessage = async (externalId: string, messagingAccountId: string, text: string, messageId: string, categoryNames: string[]) => {
  await TelegramService.sendTextMessage(externalId, '⏳ Sedang memproses...');
  const result = await extractFromText(text, categoryNames);

  if (isAIError(result)) {
    if (result.error === 'NO_AMOUNT') {
      await sendMainMenu(externalId, 'Tidak ada nominal yang terdeteksi.');
    } else {
      await TelegramService.sendTextMessage(externalId, '😔 Layanan AI sedang sibuk. Coba lagi dalam beberapa menit.');
    }
    return;
  }

  const session = await createSession(messagingAccountId, 'TELEGRAM', result, { text }, messageId);
  await sendConfirmationMessage(externalId, result, session.id);
};

// =============================================================================
// IMAGE MESSAGE → OCR
// =============================================================================
const handleImageMessage = async (externalId: string, messagingAccountId: string, mediaId: string, messageId: string) => {
  await TelegramService.sendTextMessage(externalId, '🔍 Sedang membaca struk...');
  const mediaData = await TelegramService.downloadMedia(mediaId);
  if (!mediaData) { await TelegramService.sendTextMessage(externalId, '❌ Gagal mengunduh foto.'); return; }

  const result = await extractFromImage(mediaData.buffer.toString('base64'), mediaData.mimeType);

  if (isAIError(result)) { await TelegramService.sendTextMessage(externalId, '😔 Layanan AI sedang sibuk.'); return; }
  if (isOCRBlur(result)) { await TelegramService.sendTextMessage(externalId, '📸 Foto tidak terbaca. Coba foto ulang!'); return; }

  if (isOCRNormal(result)) {
    const session = await createSession(messagingAccountId, 'TELEGRAM', result, { mediaId }, messageId);
    await sendConfirmationMessage(externalId, result, session.id);
    return;
  }
  if (isOCRForeign(result)) {
    const session = await createSession(messagingAccountId, 'TELEGRAM', result, { mediaId }, messageId);
    await sendForeignConfirmationMessage(externalId, result as any, session.id);
    return;
  }
};

// =============================================================================
// BUTTON REPLY (Confirm / Edit / Cancel transaction)
// =============================================================================
const handleButtonReply = async (externalId: string, messagingAccountId: string, buttonId: string) => {
  const session = await getPendingSession(messagingAccountId);
  if (!session) {
    await TelegramService.sendTextMessage(externalId, '⏰ Sesi expired. Kirim ulang transaksimu!');
    return;
  }

  if (buttonId === BTN_CONFIRM) {
    try {
      const data = session.extractedData as any;
      const { account } = await saveConfirmedTransaction(messagingAccountId, data);
      await updateSessionStatus(session.id, 'SAVED');
      const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
      const saldo = Number(account?.currentBalance ?? 0).toLocaleString('id-ID');
      await TelegramService.sendTextMessage(externalId, `✅ *Transaksi dicatat!*\n💰 Rp ${amount}\n💳 Sisa saldo ${account?.name ?? ''}: Rp ${saldo}`);
    } catch (err) {
      await updateSessionStatus(session.id, 'FAILED');
      await TelegramService.sendTextMessage(externalId, '❌ Gagal menyimpan. Coba lagi ya.');
    }
    return;
  }

  if (buttonId === BTN_EDIT) {
    await updateSessionStatus(session.id, 'EDITED');
    await TelegramService.sendTextMessage(externalId, '✏️ Apa yang ingin dikoreksi?\n_Contoh: "Harganya 55000" atau "Kategori: Transportasi"_');
    return;
  }

  if (buttonId === BTN_CANCEL) {
    await updateSessionStatus(session.id, 'CANCELLED');
    await TelegramService.sendTextMessage(externalId, '🚫 Transaksi dibatalkan.');
  }
};

// =============================================================================
// EDIT CORRECTION
// =============================================================================
const handleEditCorrection = async (externalId: string, editingSession: any, correctionText: string) => {
  await TelegramService.sendTextMessage(externalId, '✏️ Menerapkan koreksi...');
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
  if (isAIError(corrected)) { await TelegramService.sendTextMessage(externalId, '😔 Gagal koreksi. Tulis lebih jelas ya.'); return; }
  const merged = { ...(editingSession.extractedData as object), ...corrected };
  await resetSessionToPending(editingSession.id, merged);
  await sendConfirmationMessage(externalId, merged as any, editingSession.id);
};

// =============================================================================
// CONFIRMATION MESSAGES
// =============================================================================
const sendConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
  const merchant = data.merchantName ?? data.description ?? 'Tidak diketahui';
  const category = data.suggestedCategory ?? 'Belum dikategorikan';
  await TelegramService.sendInteractiveButtons(
    externalId,
    `🧾 *GOCENG mendeteksi transaksi:*\n\n• 🏪 ${merchant}\n• 💰 Rp ${amount}\n• 📁 ${category}\n\nSudah benar?`,
    [{ id: BTN_CONFIRM, title: '✅ Ya, Simpan' }, { id: BTN_EDIT, title: '✏️ Edit' }, { id: BTN_CANCEL, title: '❌ Batal' }]
  );
};

const sendForeignConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const totalIDR = Number(data.totalAmount).toLocaleString('id-ID');
  await TelegramService.sendInteractiveButtons(
    externalId,
    `🌏 *Struk LUAR NEGERI:*\n\n• 💵 ${data.originalCurrency} ${data.originalAmount}\n• 💰 Rp ${totalIDR}\n\nSudah benar?`,
    [{ id: BTN_CONFIRM, title: '✅ Ya, Simpan' }, { id: BTN_EDIT, title: '✏️ Edit' }, { id: BTN_CANCEL, title: '❌ Batal' }]
  );
};
