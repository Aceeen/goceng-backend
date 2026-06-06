import { Request, Response } from 'express';
import { env } from '../../config/env';
import { TelegramService } from './telegram.service';
import { prisma } from '../../config/prisma';
import { DriveService } from '../sheets/drive.service';
import { SheetsService } from '../sheets/sheets.service';
import { BudgetService } from '../budget/budget.service';

// AI Module
import { extractFromImage, extractFromText, applyUserCorrection } from '../ai/ai.service';
import { isAIError, isOCRBlur, isOCRForeign, isOCRNormal } from '../ai/ai.types';

// Session & Transaction
import { createSession, getPendingSession, updateSessionStatus, resetSessionToPending } from '../session/session.service';
import { saveConfirmedTransaction } from '../transaction/transaction.save';

const BTN_CONFIRM = 'btn_confirm';
const BTN_EDIT    = 'btn_edit';
const BTN_CANCEL  = 'btn_cancel';

const activePrintLocks = new Set<string>();

const MONTHS_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

const USAGE_INSTRUCTIONS =
  `👋 *GOCENG — Asisten Keuanganmu* 🤖📊\n\n` +
  `Berikut cara mencatat transaksi secara otomatis:\n\n` +
  `💸 *Catat Pengeluaran*\n` +
  `Kirim pesan teks biasa. Contoh:\n` +
  `• _"Makan siang 25rb"_\n` +
  `• _"Beli kopi 30.000 di Starbucks"_\n\n` +
  `💰 *Catat Pemasukan (Income)*\n` +
  `Anda juga bisa mencatat pemasukan! Contoh:\n` +
  `• _"Gaji masuk 5.000.000"_\n` +
  `• _"Freelance 1.5jt"_\n\n` +
  `📸 *Gunakan Foto Struk*\n` +
  `Cukup kirim foto struk transaksi Anda langsung di sini.\n\n` +
  `🔄 *Sinkronisasi Manual (/sync)*\n` +
  `Ketik */sync* jika data di Google Sheets terasa tidak lengkap atau berbeda dengan yang ada di sini.\n` +
  `Lakukan ini terutama setelah:\n` +
  `• Baru saja login ulang Google\n` +
  `• Koneksi Google sempat terputus\n` +
  `• Ada transaksi/budget yang tidak muncul di spreadsheet\n\n` +
  `Gunakan menu di bawah untuk mengelola rekening, budget, pengeluaran rutin, atau mencetak laporan. 👇`;

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

    if (menuSession && (
      menuSessionData?.type === 'ADD_ACCOUNT' ||
      menuSessionData?.type === 'MENU_UBAH_SALDO' ||
      menuSessionData?.type === 'ROUTINE_ADD' ||
      menuSessionData?.type === 'ROUTINE_EDIT' ||
      menuSessionData?.type === 'BUDGET_SET' ||
      menuSessionData?.type === 'BUDGET_EDIT'
    )) {
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

    // Handle slash commands
    if (textBody?.startsWith('/')) {
      const command = textBody.trim().toLowerCase().split(/\s+/)[0];

      if (command === '/sync') {
        const hasMeta = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccount.id },
          select: { spreadsheetId: true, userId: true }
        });

        let exists = false;
        if (hasMeta?.spreadsheetId && hasMeta?.userId) {
          try {
            exists = await SheetsService.checkIfSpreadsheetExists(hasMeta.userId, hasMeta.spreadsheetId);
          } catch (err) {
            console.error('Error checking sheet existence in /sync:', err);
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
            const message = `File sheets tidak ditemukan. Klik tombol di bawah untuk membuat file baru secara otomatis. /sync untuk menyinkronkan data`;
            await TelegramService.sendInteractiveButtons(externalId, message, [
              { id: 'regenerate_sheets', title: '🖨️ Buat Ulang Spreadsheet' }
            ]);
          } else {
            await TelegramService.sendTextMessage(externalId,
              '⚠️ Google Sheets belum terhubung. Silakan login ulang Google terlebih dahulu lewat aplikasi.'
            );
          }
          return;
        }

        await TelegramService.sendTextMessage(externalId, '🔄 Memulai sinkronisasi data ke Google Sheets...');
        SheetsService.triggerFullSync(messagingAccount.id);
        await TelegramService.sendTextMessage(externalId,
          '✅ Sinkronisasi dimulai di latar belakang!\n\nSemua transaksi tahun ini, rekening, dan budget sedang disinkronkan ke spreadsheet-mu.'
        );
        return;
      }

      // All other slash commands (/menu, /start, /help, etc.)
      SheetsService.triggerAccountSync(messagingAccount.id);
      SheetsService.triggerBudgetSync(messagingAccount.id);
      await sendMainMenu(externalId, USAGE_INSTRUCTIONS);
      return;
    }

    if (textBody) {
      await handleTextMessage(externalId, messagingAccount.id, textBody, messageId!, categoryNames);
    } else if (mediaId) {
      await handleImageMessage(externalId, messagingAccount.id, mediaId, messageId!);
    } else {
      await sendMainMenu(externalId, USAGE_INSTRUCTIONS);
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
    { id: 'menu_budget',    title: '📊 Atur Budget' },
    { id: 'menu_cetak',     title: '🖨️ Cetak Laporan (SPS)' },
    { url: env.FRONTEND_URL, title: '🌐 Buka Web App' },
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
  if (buttonData === 'regenerate_sheets') {
    await TelegramService.sendTextMessage(externalId, '⏳ Sedang membuat ulang spreadsheet...');
    try {
      await SheetsService.regenerateSpreadsheet(account.id);
      SheetsService.triggerFullSync(account.id);
      await TelegramService.sendTextMessage(
        externalId,
        '✅ Spreadsheet berhasil dibuat ulang!\n\nSemua transaksi tahun ini, rekening, dan budget sedang disinkronkan di latar belakang.'
      );
    } catch (err) {
      console.error('Error regenerating spreadsheet via button callback:', err);
      await TelegramService.sendTextMessage(
        externalId,
        '❌ Gagal membuat ulang spreadsheet. Hubungkan kembali Google Anda.'
      );
    }
    return;
  }

  if (buttonData === 'menu_transaksi') {
    await TelegramService.sendTextMessage(
      externalId,
      '💳 Silakan kirim pesan atau foto struk transaksimu!\n\n_Contoh: "Makan siang 25rb" atau foto struk 📸_'
    );
    return;
  }

  if (buttonData === 'menu_rekening') {
    const accounts = await prisma.account.findMany({
      where: { messagingAccountId: account.id, isActive: true },
      select: { id: true, name: true, currentBalance: true },
      orderBy: { createdAt: 'asc' },
    });

    const buttons = accounts.map(a => ({
      id: `ubah_${a.id}`,
      title: `${a.name} (Rp ${Number(a.currentBalance).toLocaleString('id-ID')})`
    }));

    buttons.push({ id: 'menu_rekening_tambah', title: '➕ Tambah Rekening' });

    await TelegramService.sendInteractiveButtons(
      externalId,
      '💼 *Kelola Rekening*\n\nPilih rekening yang mau diubah saldonya atau tambah rekening baru:',
      buttons
    );
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

  if (buttonData === 'menu_budget') {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();

    // getBudgets already computes spent, remaining, and percentage for each budget
    const budgets = await BudgetService.getBudgets(account.id);

    const statusIcon = (level: string) =>
      level === 'OVER_BUDGET' ? '🚨' : level === 'WARNING' ? '⚠️' : '🟢';

    const buttons = budgets.map(b => ({
      id: `budget_edit_${b.id}`,
      title: `${statusIcon(b.status)} ${b.category.name}: ${b.percentage.toFixed(0)}% terpakai`
    }));

    buttons.push({ id: 'menu_budget_tambah', title: '➕ Tambah Budget Baru' });

    // Build a summary list above the buttons
    let summaryLines = '';
    if (budgets.length > 0) {
      summaryLines = budgets.map(b => {
        const icon = statusIcon(b.status);
        const spent = b.realized.toLocaleString('id-ID');
        const lim = b.limitAmount.toLocaleString('id-ID');
        const rem = (b.limitAmount - b.realized).toLocaleString('id-ID');
        return `${icon} *${b.category.name}*\n   Terpakai: Rp ${spent} / Rp ${lim} (${b.percentage.toFixed(0)}%)\n   Sisa: Rp ${rem}`;
      }).join('\n\n');
    }

    const headerText = budgets.length > 0
      ? `📊 *Budget Bulanan — ${MONTHS_ID[currentMonth - 1]} ${currentYear}*\n\n${summaryLines}\n\nKetuk budget untuk mengubah limit/menghapus:`
      : `📊 *Budget Bulanan — ${MONTHS_ID[currentMonth - 1]} ${currentYear}*\n\nBelum ada budget bulan ini. Tambahkan sekarang!`;

    await TelegramService.sendInteractiveButtons(externalId, headerText, buttons);
    return;
  }

  if (buttonData === 'menu_budget_tambah') {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();

    // Get all categories scoped for the user
    const allCategories = await prisma.category.findMany({
      where: {
        OR: [
          { isSystem: true },
          { messagingAccountId: account.id }
        ]
      },
      orderBy: { name: 'asc' }
    });

    // Get categories that already have a budget
    const existingBudgets = await prisma.budget.findMany({
      where: { messagingAccountId: account.id, month: currentMonth, year: currentYear },
      select: { categoryId: true }
    });
    const existingCatIds = new Set(existingBudgets.map(eb => eb.categoryId));

    // Filter out categories that already have a budget
    const availableCategories = allCategories.filter(c => !existingCatIds.has(c.id));

    if (!availableCategories.length) {
      await TelegramService.sendTextMessage(externalId, '❌ Semua kategori sudah diatur budgetnya untuk bulan ini.');
      return;
    }

    await TelegramService.sendInteractiveButtons(
      externalId,
      '📊 *Pilih Kategori untuk Budget Baru*:\n\nPilih kategori yang ingin diatur limit budgetnya:',
      availableCategories.map(c => ({ id: `budget_cat_${c.id}`, title: c.name }))
    );
    return;
  }

  if (buttonData?.startsWith('budget_edit_')) {
    const budgetId = buttonData.replace('budget_edit_', '');
    const budget = await prisma.budget.findUnique({
      where: { id: budgetId },
      include: { category: true }
    });
    if (!budget) {
      await TelegramService.sendTextMessage(externalId, '❌ Budget tidak ditemukan.');
      return;
    }

    // Compute how much has been spent this month for this category
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth   = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
    const agg = await prisma.transaction.aggregate({
      where: {
        messagingAccountId: account.id,
        categoryId: budget.categoryId,
        type: 'EXPENSE',
        isConfirmed: true,
        deletedAt: null,
        transactionDate: { gte: startOfMonth, lte: endOfMonth },
      },
      _sum: { amount: true },
    });
    const spent    = Number(agg._sum.amount ?? 0);
    const limit    = Number(budget.limitAmount);
    const remaining = Math.max(0, limit - spent);
    const pct      = limit > 0 ? (spent / limit) * 100 : 0;
    const statusIcon = pct >= 100 ? '🚨' : pct >= 80 ? '⚠️' : '🟢';
    const statusLabel = pct >= 100 ? 'TERLAMPAUI' : pct >= 80 ? 'Hampir Habis' : 'Aman';

    const buttons = [
      { id: `budget_change_limit_${budget.id}`, title: '✏️ Ubah Limit' },
      { id: `budget_delete_${budget.id}`, title: '🗑️ Hapus Budget' },
      { id: 'menu_budget', title: '⬅️ Kembali' }
    ];

    await TelegramService.sendInteractiveButtons(
      externalId,
      `📊 *Detail Budget: ${budget.category.name}*\n\n` +
      `• Limit Bulanan: *Rp ${limit.toLocaleString('id-ID')}*\n` +
      `• Terpakai: *Rp ${spent.toLocaleString('id-ID')}* (${pct.toFixed(0)}%)\n` +
      `• Sisa: *Rp ${remaining.toLocaleString('id-ID')}*\n` +
      `• Status: ${statusIcon} *${statusLabel}*\n` +
      `• Bulan/Tahun: *${MONTHS_ID[budget.month - 1]} ${budget.year}*\n` +
      `• Catatan: _${budget.notes || '-'}_`,
      buttons
    );
    return;
  }

  if (buttonData?.startsWith('budget_delete_')) {
    const budgetId = buttonData.replace('budget_delete_', '');
    try {
      await BudgetService.deleteBudget(budgetId, account.id);
      await TelegramService.sendTextMessage(externalId, '✅ Budget berhasil dihapus!');
      await handleMenuRouter(externalId, account, 'menu_budget', null);
    } catch (err) {
      await TelegramService.sendTextMessage(externalId, '❌ Gagal menghapus budget.');
    }
    return;
  }

  if (buttonData?.startsWith('budget_change_limit_')) {
    const budgetId = buttonData.replace('budget_change_limit_', '');
    const budget = await prisma.budget.findUnique({
      where: { id: budgetId },
      include: { category: true }
    });
    if (!budget) {
      await TelegramService.sendTextMessage(externalId, '❌ Budget tidak ditemukan.');
      return;
    }

    await TelegramService.sendTextMessage(
      externalId,
      `📊 Berapa limit budget baru untuk kategori *${budget.category.name}*?\n_Tulis angka saja, contoh: 1500000_`
    );

    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'BUDGET_EDIT', budgetId, categoryId: budget.categoryId, categoryName: budget.category.name, month: budget.month, year: budget.year }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── Cetak: generate PDF ──────────────────────────────────────────────────
  if (buttonData?.startsWith('cetak_')) {
    const parts = buttonData.split('_');
    const month = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    const sheetName = MONTHS_ID[month - 1];

    if (activePrintLocks.has(account.id)) {
      console.warn(`[Cetak] Duplicate print request (in-memory lock) ignored for user ${account.id}`);
      return;
    }
    activePrintLocks.add(account.id);

    // Check for transaction existence in that specific month and year
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const txCount = await prisma.transaction.count({
      where: {
        messagingAccountId: account.id,
        isConfirmed: true,
        deletedAt: null,
        transactionDate: { gte: startDate, lte: endDate }
      }
    });

    if (txCount === 0) {
      activePrintLocks.delete(account.id);
      await TelegramService.sendTextMessage(externalId, `❌ Tidak ada transaksi pada bulan *${sheetName} ${year}*. Laporan tidak dapat dicetak.`);
      return;
    }

    // Clean up any expired print locks first
    await prisma.transactionSession.deleteMany({
      where: {
        messagingAccountId: account.id,
        externalMessageId: `PRINT_${account.id}`,
        expiresAt: { lte: new Date() }
      }
    }).catch(() => {});

    // Create printing session lock using unique constraint on externalMessageId
    let printSession;
    try {
      printSession = await prisma.transactionSession.create({
        data: {
          messagingAccountId: account.id,
          platform: 'TELEGRAM',
          status: 'PENDING',
          externalMessageId: `PRINT_${account.id}`,
          extractedData: { type: 'PRINTING', month, year },
          rawPayload: {},
          expiresAt: new Date(Date.now() + 15000) // 15 seconds lock
        }
      });
    } catch (err: any) {
      activePrintLocks.delete(account.id);
      if (err.code === 'P2002') {
        console.warn(`[Cetak] Duplicate print request (DB constraint lock) ignored for user ${account.id}`);
        return;
      }
      throw err;
    }

    await TelegramService.sendTextMessage(externalId, `⏳ Sedang mencetak *${sheetName}*...`);

    if (!account.spreadsheetId) {
      activePrintLocks.delete(account.id);
      await TelegramService.sendTextMessage(externalId, '❌ Google Sheet belum terhubung.');
      await prisma.transactionSession.delete({ where: { id: printSession.id } }).catch(() => {});
      return;
    }

    try {
      const pdfBuffer = await DriveService.exportSheetByName(account.userId, account.spreadsheetId, sheetName);
      if (!pdfBuffer) {
        await TelegramService.sendTextMessage(externalId, `❌ Tab *${sheetName}* tidak ditemukan di spreadsheet.`);
        return;
      }

      await TelegramService.sendDocument(externalId, pdfBuffer, `GOCENG_${sheetName}.pdf`);
    } catch (err) {
      console.error('Failed to export and send PDF to Telegram:', err);
      await TelegramService.sendTextMessage(externalId, '❌ Gagal mencetak laporan PDF.');
    } finally {
      activePrintLocks.delete(account.id);
      if (printSession) {
        await prisma.transactionSession.delete({ where: { id: printSession.id } }).catch(() => {});
      }
    }
    return;
  }

  // ── Rutin main submenu ────────────────────────────────────────────────────
  if (buttonData === 'menu_rutin') {
    const routines = await prisma.routineExpense.findMany({
      where: { messagingAccountId: account.id, isActive: true },
      select: { id: true, title: true, amount: true, frequency: true },
      orderBy: { createdAt: 'asc' },
    });

    const FREQ_LABEL: Record<string, string> = { DAILY: 'Harian', WEEKLY: 'Mingguan', MONTHLY: 'Bulanan', ANNUALLY: 'Tahunan' };
    const buttons = routines.map(r => ({
      id: `rutin_sel_${r.id}`,
      title: `${r.title} — Rp ${Number(r.amount).toLocaleString('id-ID')} (${FREQ_LABEL[r.frequency]})`
    }));

    buttons.push({ id: 'menu_rutin_tambah', title: '➕ Tambah Rutin Baru' });

    await TelegramService.sendInteractiveButtons(
      externalId,
      '📅 *Pengeluaran Rutin*\n\nPilih rutin yang mau dikelola atau tambah rutin baru:',
      buttons
    );
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
      SheetsService.triggerAccountSync(account.id);
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
    SheetsService.triggerAccountSync(account.id);
    await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });
    await TelegramService.sendTextMessage(externalId, `✅ Saldo *${sessionData.accountName}* diperbarui: Rp ${balance.toLocaleString('id-ID')}`);
    return;
  }

  // ── BUDGET: selected category -> ask amount ──────────────────────────────
  if (buttonData?.startsWith('budget_cat_')) {
    const categoryId = buttonData.replace('budget_cat_', '');
    const cat = await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true } });
    if (!cat) { await TelegramService.sendTextMessage(externalId, '❌ Kategori tidak ditemukan.'); return; }

    await TelegramService.sendTextMessage(
      externalId,
      `📊 Berapa limit budget bulanan untuk kategori *${cat.name}*?\n_Tulis angka saja, contoh: 1000000_`
    );

    await prisma.transactionSession.create({ data: {
      messagingAccountId: account.id, platform: 'TELEGRAM', status: 'PENDING',
      extractedData: { type: 'BUDGET_SET', categoryId, categoryName: cat.name }, rawPayload: {},
      expiresAt: new Date(Date.now() + SESSION_TTL),
    }});
    return;
  }

  // ── BUDGET_SET / BUDGET_EDIT: receive limit amount ───────────────────────
  if ((sessionData?.type === 'BUDGET_SET' || sessionData?.type === 'BUDGET_EDIT') && textBody) {
    const limit = Number(textBody.replace(/[^0-9]/g, ''));
    if (isNaN(limit) || limit <= 0) {
      await TelegramService.sendTextMessage(externalId, '❌ Tulis angka saja, contoh: 1000000');
      return;
    }

    const month = sessionData.month ?? (new Date().getMonth() + 1);
    const year = sessionData.year ?? new Date().getFullYear();

    await BudgetService.upsertBudget(account.id, {
      categoryId: sessionData.categoryId,
      limitAmount: limit,
      month,
      year
    });

    await prisma.transactionSession.update({ where: { id: activeSession.id }, data: { status: 'SAVED' } });

    await TelegramService.sendTextMessage(
      externalId,
      `✅ *Budget Berhasil ${sessionData.type === 'BUDGET_EDIT' ? 'Diperbarui' : 'Diatur'}!*\n📁 Kategori: *${sessionData.categoryName}*\n💰 Limit Baru: *Rp ${limit.toLocaleString('id-ID')}*\n📅 Periode: ${MONTHS_ID[month - 1]} ${year}`
    );
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
    SheetsService.triggerAccountSync(messagingAccountId);
    await prisma.messagingAccount.update({ where: { id: messagingAccountId }, data: { isOnboarded: true } });
    await prisma.transactionSession.update({ where: { id: session.id }, data: { status: 'SAVED' } });
    await TelegramService.sendTextMessage(externalId,
      `✅ *Rekening ${sd.name} berhasil dibuat!*\n💰 Saldo awal: Rp ${balance.toLocaleString('id-ID')}\n\n` +
      `🎉 *GOCENG siap digunakan!*\n\n` +
      `Berikut cara cepat mencatat transaksi:\n` +
      `💸 *Catat Pengeluaran*: Kirim pesan teks seperti _"Makan siang 25rb"_ atau _"Beli kopi 30000"_\n` +
      `💰 *Catat Pemasukan (Income)*: Kirim pesan teks seperti _"Gaji masuk 5jt"_ atau _"Freelance 1.5jt"_\n` +
      `📸 *Gunakan Foto Struk*: Cukup kirim foto struk transaksi Anda langsung di sini`
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
      await sendMainMenu(externalId, USAGE_INSTRUCTIONS);
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
      console.warn(`[Telegram] Confirm button double clicked or session already processed for user ${messagingAccountId}`);
      return; // Exit silently to avoid duplicate inserts
    }

    try {
      const data = session.extractedData as any;
      const rawPayload = session.rawPayload as any;
      const mediaId = rawPayload?.mediaId;
      let imageUrl: string | undefined;

      if (mediaId) {
        const mediaData = await TelegramService.downloadMedia(mediaId);
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
      const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
      const saldo = Number(account?.currentBalance ?? 0).toLocaleString('id-ID');
      
      let msg = `✅ *Transaksi dicatat!*\n💰 Rp ${amount}\n💳 Sisa saldo ${account?.name ?? ''}: Rp ${saldo}`;

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
      
      await TelegramService.sendTextMessage(externalId, msg);
    } catch (err) {
      await updateSessionStatus(session.id, 'FAILED');
      await TelegramService.sendTextMessage(externalId, '❌ Gagal menyimpan. Coba lagi ya.');
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
      await TelegramService.sendTextMessage(externalId, '❌ Tidak ada rekening aktif.');
      return;
    }
    await TelegramService.sendInteractiveButtons(
      externalId,
      '🏦 Pilih rekening untuk transaksi ini:',
      accounts.map(a => ({ id: `btn_set_account_${a.id}`, title: a.name }))
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
      await sendForeignConfirmationMessage(externalId, merged, session.id);
    } else {
      await sendConfirmationMessage(externalId, merged, session.id);
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
        await sendForeignConfirmationMessage(externalId, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(externalId, merged, editingSession.id);
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
        await sendForeignConfirmationMessage(externalId, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(externalId, merged, editingSession.id);
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
        await sendForeignConfirmationMessage(externalId, merged, editingSession.id);
      } else {
        await sendConfirmationMessage(externalId, merged, editingSession.id);
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
      await sendForeignConfirmationMessage(externalId, merged, editingSession.id);
    } else {
      await sendConfirmationMessage(externalId, merged, editingSession.id);
    }
    return;
  }

  let corrected = await applyUserCorrection(correctionText, editingSession.extractedData as object);
  
  // 2. Fallback: If AI fails (no field matched) and user sent a text correction,
  // treat the input as the new transaction description.
  if (isAIError(corrected)) {
    console.log('[AI] Correction failed, falling back to description overwrite');
    const value = cleanText;
    if (value.length > 0) {
      corrected = { description: value };
    } else {
      await TelegramService.sendTextMessage(externalId, '😔 Gagal koreksi. Tulis lebih jelas ya.');
      return;
    }
  }

  const merged = { ...(editingSession.extractedData as object), ...corrected };
  await resetSessionToPending(editingSession.id, merged);
  const data = merged as any;
  if (data.case === 'FOREIGN') {
    await sendForeignConfirmationMessage(externalId, data, editingSession.id);
  } else {
    await sendConfirmationMessage(externalId, data, editingSession.id);
  }
};

// =============================================================================
// CONFIRMATION MESSAGES
// =============================================================================
const sendConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const amount = Number(data.totalAmount ?? data.amount ?? 0).toLocaleString('id-ID');
  const merchant = data.merchantName || '-';
  const description = data.description || '-';
  const category = data.suggestedCategory ?? 'Belum dikategorikan';

  const messagingAccount = await prisma.messagingAccount.findFirst({
    where: { platform: 'TELEGRAM', externalId },
    select: { id: true }
  });
  if (!messagingAccount) return;
  const messagingAccountId = messagingAccount.id;

  const account = data.accountId
    ? await prisma.account.findFirst({ where: { id: data.accountId, messagingAccountId, isActive: true } })
    : await prisma.account.findFirst({ where: { messagingAccountId, isActive: true }, orderBy: { createdAt: 'asc' } });
  
  const accountName = account ? account.name : 'Belum ditentukan';

  await TelegramService.sendInteractiveButtons(
    externalId,
    `🧾 *GOCENG mendeteksi transaksi:*\n\n` +
    `• 🏪 Merchant: ${merchant}\n` +
    `• 📝 Deskripsi: ${description}\n` +
    `• 💰 Total: Rp ${amount}\n` +
    `• 📁 Kategori: ${category}\n` +
    `• 🏦 Rekening: ${accountName}\n\n` +
    `Sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: 'btn_change_account', title: '🏦 Ubah Rekening' },
      { id: BTN_EDIT, title: '✏️ Edit' },
      { id: BTN_CANCEL, title: '❌ Batal' }
    ]
  );
};

const sendForeignConfirmationMessage = async (externalId: string, data: any, sessionId: string) => {
  const totalIDR = Number(data.totalAmount).toLocaleString('id-ID');
  const merchant = data.merchantName || '-';
  const description = data.description || '-';

  const messagingAccount = await prisma.messagingAccount.findFirst({
    where: { platform: 'TELEGRAM', externalId },
    select: { id: true }
  });
  if (!messagingAccount) return;
  const messagingAccountId = messagingAccount.id;

  const account = data.accountId
    ? await prisma.account.findFirst({ where: { id: data.accountId, messagingAccountId, isActive: true } })
    : await prisma.account.findFirst({ where: { messagingAccountId, isActive: true }, orderBy: { createdAt: 'asc' } });
  
  const accountName = account ? account.name : 'Belum ditentukan';

  await TelegramService.sendInteractiveButtons(
    externalId,
    `🌏 *Struk LUAR NEGERI:*\n\n` +
    `• 🏪 Merchant: ${merchant}\n` +
    `• 📝 Deskripsi: ${description}\n` +
    `• 💵 Nominal: ${data.originalCurrency} ${data.originalAmount}\n` +
    `• 💰 Total: Rp ${totalIDR}\n` +
    `• 🏦 Rekening: ${accountName}\n\n` +
    `Sudah benar?`,
    [
      { id: BTN_CONFIRM, title: '✅ Ya, Simpan' },
      { id: 'btn_change_account', title: '🏦 Ubah Rekening' },
      { id: BTN_EDIT, title: '✏️ Edit' },
      { id: BTN_CANCEL, title: '❌ Batal' }
    ]
  );
};
