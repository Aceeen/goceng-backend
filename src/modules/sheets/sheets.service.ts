import { sheetsAPI, oauth2Client } from '../../config/googleClient';
import { prisma } from '../../config/prisma';
import { decryptToken } from '../../utils/encryption';
import { env } from '../../config/env';

/**
 * Service handling Google Sheets Data sync operations.
 */
export class SheetsService {
  /**
   * Sets up oauth credentials for a specific user to perform Sheet operations.
   */
  private static async authenticateUser(userId: string) {
    const tokenRecord = await prisma.oAuthToken.findUnique({ where: { userId } });
    if (!tokenRecord) {
      throw new Error(`No OAuth token found for user ${userId}`);
    }

    // Decrypt the token that was securely saved
    const accessToken = decryptToken(tokenRecord.accessToken);
    const refreshToken = decryptToken(tokenRecord.refreshToken);

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }

  /**
   * Appends a new transaction to the user's spreadsheet.
   */
  static async appendTransaction(userId: string, spreadsheetId: string, transaction: any) {
    await this.authenticateUser(userId);

    // Prepare values according to technical document "3.5.1 Sheet: TRANSACTIONS"
    // ID, Tanggal, Tipe, Jumlah, Kategori, Deskripsi, Merchant, Rekening, Sumber, Saldo Setelah, Foto Struk, Dicatat Pada
    const values = [
      [
        transaction.id,
        transaction.transactionDate, // formatted date DD/MM/YYYY
        transaction.type,
        transaction.amount,
        transaction.category?.name || '',
        transaction.description || '',
        transaction.merchantName || '',
        transaction.account?.name || '',
        transaction.source,
        transaction.currentBalance, // balance after transaction
        transaction.imageUrl || '',
        new Date().toISOString() // Or custom DD/MM/YYYY HH:mm formatted string
      ],
    ];

    try {
      const response = await sheetsAPI.spreadsheets.values.append({
        spreadsheetId,
        range: 'TRANSACTIONS!A:L',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values,
        },
      });

      console.log(`✅ Transaction added to Sheets for user ${userId}. Updated cells: ${response.data.updates?.updatedCells}`);
      return response.data;
    } catch (error) {
      console.error(`❌ Failed to append transaction for user ${userId}:`, error);
      if (transaction?.messagingAccountId) {
        await this.handleOAuthError(error, transaction.messagingAccountId);
      }
      throw error;
    }
  }

  /**
   * Syncs all accounts of a messaging account to the user's spreadsheet.
   */
  static async syncAccountsToSheet(userId: string, spreadsheetId: string, messagingAccountId: string) {
    const accounts = await prisma.account.findMany({
      where: { messagingAccountId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    try {
      await this.authenticateUser(userId);
      let sheetName = 'ACCOUNTS';
      try {
        await sheetsAPI.spreadsheets.values.clear({
          spreadsheetId,
          range: `${sheetName}!A2:F100`,
        });
      } catch (err) {
        sheetName = 'Accounts';
        await sheetsAPI.spreadsheets.values.clear({
          spreadsheetId,
          range: `${sheetName}!A2:F100`,
        });
      }

      if (accounts.length > 0) {
        const values = accounts.map((acc) => [
          acc.id,
          acc.name,
          acc.type,
          Number(acc.initialBalance),
          Number(acc.currentBalance),
          acc.updatedAt.toISOString(),
        ]);

        await sheetsAPI.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A2:F${accounts.length + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values,
          },
        });
      }
      console.log(`✅ Accounts synced to Sheets for user ${userId}.`);
    } catch (error) {
      console.error(`❌ Failed to sync accounts to Sheets for user ${userId}:`, error);
      await this.handleOAuthError(error, messagingAccountId);
    }
  }

  /**
   * Helper to trigger async account sync in background
   */
  static triggerAccountSync(messagingAccountId: string) {
    setImmediate(async () => {
      try {
        const accountMeta = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccountId },
          select: { spreadsheetId: true, userId: true },
        });
        if (accountMeta?.spreadsheetId && accountMeta?.userId) {
          await this.syncAccountsToSheet(accountMeta.userId, accountMeta.spreadsheetId, messagingAccountId);
        }
      } catch (err) {
        console.error('[Sheets] triggerAccountSync error:', err);
      }
    });
  }

  /**
   * Syncs all budgets of a messaging account to the user's spreadsheet.
   */
  static async syncBudgetsToSheet(userId: string, spreadsheetId: string, messagingAccountId: string) {
    const budgets = await prisma.budget.findMany({
      where: { messagingAccountId },
      include: { category: true },
      orderBy: [
        { year: 'desc' },
        { month: 'desc' },
        { category: { name: 'asc' } }
      ],
    });

    try {
      await this.authenticateUser(userId);
      let sheetName = 'BUDGETS';
      try {
        await sheetsAPI.spreadsheets.values.clear({
          spreadsheetId,
          range: `${sheetName}!A2:E100`,
        });
      } catch (err) {
        sheetName = 'Budgets';
        await sheetsAPI.spreadsheets.values.clear({
          spreadsheetId,
          range: `${sheetName}!A2:E100`,
        });
      }

      if (budgets.length > 0) {
        const values = budgets.map((b) => [
          b.category?.name || '',
          b.month,
          b.year,
          Number(b.limitAmount),
          b.notes || '',
        ]);

        await sheetsAPI.spreadsheets.values.update({
          spreadsheetId,
          range: `${sheetName}!A2:E${budgets.length + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values,
          },
        });
      }
      console.log(`✅ Budgets synced to Sheets for user ${userId}.`);
    } catch (error) {
      console.error(`❌ Failed to sync budgets to Sheets for user ${userId}:`, error);
      await this.handleOAuthError(error, messagingAccountId);
    }
  }

  /**
   * Helper to trigger async budget sync in background
   */
  static triggerBudgetSync(messagingAccountId: string) {
    setImmediate(async () => {
      try {
        const accountMeta = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccountId },
          select: { spreadsheetId: true, userId: true },
        });
        if (accountMeta?.spreadsheetId && accountMeta?.userId) {
          await this.syncBudgetsToSheet(accountMeta.userId, accountMeta.spreadsheetId, messagingAccountId);
        }
      } catch (err) {
        console.error('[Sheets] triggerBudgetSync error:', err);
      }
    });
  }

  /**
   * Copy the Master Spreadsheet Template to the user's Drive.
   */
  static async setupUserSpreadsheet(userId: string): Promise<string> {
    await this.authenticateUser(userId);

    // Call Drive API to copy the master template... (implementation mock)
    // const copyResponse = await driveAPI.files.copy({ ... })
    // return copyResponse.data.id;
    throw new Error('Not Implemented: copy template');
  }

  /**
   * Detects Google OAuth expired/revoked credentials (invalid_grant) and sends a notification to the user to reconnect.
   */
  private static async handleOAuthError(error: any, messagingAccountId: string) {
    const errStr = String(error?.message || error || '');
    const errResponseData = String(JSON.stringify(error?.response?.data || {}));

    if (errStr.includes('invalid_grant') || errResponseData.includes('invalid_grant')) {
      console.warn(`[Sheets] Google OAuth token expired/revoked for account ${messagingAccountId}. Notifying user...`);

      try {
        const messagingAccount = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccountId },
          select: { platform: true, externalId: true },
        });

        if (messagingAccount) {
          const { platform, externalId } = messagingAccount;
          const loginLink = platform === 'TELEGRAM'
            ? `${env.BACKEND_URL ?? env.FRONTEND_URL}/v1/auth/google?tg=${externalId}`
            : `${env.FRONTEND_URL}/login?platform=WHATSAPP&id=${externalId}`;

          const message = platform === 'TELEGRAM'
            ? `⚠️ *Koneksi Google Anda Terputus!*\n\n` +
              `GOCENG gagal memasukkan transaksi Anda ke Google Sheets karena izin Google Anda telah kedaluwarsa atau dicabut.\n\n` +
              `Silakan hubungkan kembali akun Google Anda melalui tautan berikut:\n` +
              `🔗 [Hubungkan Ulang Google](${loginLink})\n\n` +
              `Setelah menghubungkan ulang, silakan catat kembali transaksi Anda.`
            : `⚠️ *Koneksi Google Anda Terputus!*\n\n` +
              `GOCENG gagal memasukkan transaksi Anda ke Google Sheets karena izin Google Anda telah kedaluwarsa atau dicabut.\n\n` +
              `Silakan hubungkan kembali akun Google Anda melalui tautan berikut:\n` +
              `🔗 ${loginLink}\n\n` +
              `Setelah menghubungkan ulang, silakan catat kembali transaksi Anda.`;

          const { TelegramService } = await import('../webhook/telegram.service');
          const { WhatsAppService } = await import('../webhook/whatsapp.service');

          if (platform === 'TELEGRAM') {
            await TelegramService.sendTextMessage(externalId, message);
          } else {
            await WhatsAppService.sendTextMessage(externalId, message);
          }
        }
      } catch (notifyErr) {
        console.error('[Sheets] Gagal mengirim notifikasi token expired ke user:', notifyErr);
      }
    }
  }
}
