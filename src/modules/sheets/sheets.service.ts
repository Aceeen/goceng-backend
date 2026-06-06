import { sheetsAPI, oauth2Client } from '../../config/googleClient';
import { prisma } from '../../config/prisma';
import { decryptToken, encryptToken } from '../../utils/encryption';
import { env } from '../../config/env';

/**
 * Service handling Google Sheets Data sync operations.
 */
export class SheetsService {
  /**
   * Sets up oauth credentials for a specific user and automatically persists
   * any refreshed access tokens back to the database via the googleapis
   * 'tokens' event listener.
   *
   * The googleapis library automatically refreshes the access token whenever it
   * is within its expiry window. Without persisting the new token, the database
   * always holds a stale access token. On the next cold start, the library
   * submits the stale token and must re-refresh it again — eventually causing
   * issues with token rotation limits or producing invalid_grant errors.
   */
  private static async authenticateUser(userId: string) {
    const tokenRecord = await prisma.oAuthToken.findUnique({ where: { userId } });
    if (!tokenRecord) {
      throw new Error(`No OAuth token found for user ${userId}`);
    }

    // Decrypt stored tokens
    const accessToken = decryptToken(tokenRecord.accessToken);
    const refreshToken = decryptToken(tokenRecord.refreshToken);

    // Remove any previously attached listeners to avoid duplicate DB writes
    // across repeated authenticateUser calls within the same process lifetime.
    oauth2Client.removeAllListeners('tokens');

    // Persist any newly issued access token back to the database.
    // This fires automatically whenever the googleapis library silently refreshes
    // the access token (which happens when the current one is within 5 minutes of
    // expiry or has already expired).
    oauth2Client.on('tokens', async (newTokens) => {
      try {
        if (newTokens.access_token) {
          const encryptedAccess = encryptToken(newTokens.access_token);
          const tokenExpiry = newTokens.expiry_date
            ? new Date(newTokens.expiry_date)
            : new Date(Date.now() + 3600 * 1000);

          await prisma.oAuthToken.update({
            where: { userId },
            data: {
              accessToken: encryptedAccess,
              expiresAt: tokenExpiry,
              // Only update refreshToken if Google issued a new one (rare — only
              // happens on the very first token or after revocation + re-auth)
              ...(newTokens.refresh_token
                ? { refreshToken: encryptToken(newTokens.refresh_token) }
                : {}),
            },
          });
          console.log(`[Sheets] Persisted refreshed access token for user ${userId}`);
        }
      } catch (err) {
        console.error(`[Sheets] Failed to persist refreshed token for user ${userId}:`, err);
      }
    });

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: tokenRecord.expiresAt.getTime(),
    });

    // Proactively refresh if the stored access token expires within the next
    // 5 minutes. This avoids a mid-request refresh that could add latency to
    // the first Sheets API call after a long idle period.
    const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
    if (tokenRecord.expiresAt.getTime() < fiveMinutesFromNow) {
      console.log(`[Sheets] Access token near expiry for user ${userId} — proactively refreshing...`);
      try {
        await oauth2Client.refreshAccessToken();
        // The 'tokens' event listener above will persist the new token to DB.
      } catch (err) {
        // If this fails, the subsequent API call will still attempt its own
        // refresh. Log and continue rather than blocking the operation.
        console.warn(`[Sheets] Proactive refresh failed for user ${userId}:`, err);
      }
    }
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
        const values = accounts.map((acc: any) => [
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
        const values = budgets.map((b: any) => [
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
   * Full re-sync: writes all Accounts, Budgets, and any unsynced Transactions to
   * the user's Google Spreadsheet. Use this after Google re-authentication to
   * guarantee the sheet is never stale after a token-expired gap.
   */
  static async syncAllToSheet(userId: string, spreadsheetId: string, messagingAccountId: string) {
    console.log(`[Sheets] Starting full sync for messagingAccount ${messagingAccountId}...`);

    // 1. Sync Accounts tab
    await this.syncAccountsToSheet(userId, spreadsheetId, messagingAccountId);

    // 2. Sync Budgets tab
    await this.syncBudgetsToSheet(userId, spreadsheetId, messagingAccountId);

    // 3. Re-append all transactions that were never synced (isSynced = false)
    const unsynced = await prisma.transaction.findMany({
      where: { messagingAccountId, isSynced: false, isConfirmed: true, deletedAt: null },
      include: {
        category: { select: { name: true } },
        account: { select: { name: true } },
      },
      orderBy: { transactionDate: 'asc' },
    });

    for (const tx of unsynced) {
      try {
        // Fetch the account balance at append time (best approximation)
        const account = await prisma.account.findUnique({ where: { id: tx.accountId }, select: { currentBalance: true } });
        await this.appendTransaction(userId, spreadsheetId, {
          ...tx,
          transactionDate: tx.transactionDate.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }),
          amount: Number(tx.amount),
          currentBalance: Number(account?.currentBalance ?? 0),
        });
        await prisma.transaction.update({ where: { id: tx.id }, data: { isSynced: true } });
        console.log(`[Sheets] Re-synced transaction ${tx.id}`);
      } catch (err) {
        console.error(`[Sheets] Failed to re-sync transaction ${tx.id}:`, err);
      }
    }

    console.log(`[Sheets] Full sync complete. Re-synced ${unsynced.length} pending transactions.`);
  }

  /**
   * Background helper to trigger a full re-sync for a given messagingAccountId.
   */
  static triggerFullSync(messagingAccountId: string) {
    setImmediate(async () => {
      try {
        const accountMeta = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccountId },
          select: { spreadsheetId: true, userId: true },
        });
        if (accountMeta?.spreadsheetId && accountMeta?.userId) {
          await this.syncAllToSheet(accountMeta.userId, accountMeta.spreadsheetId, messagingAccountId);
        } else {
          console.warn(`[Sheets] triggerFullSync: No spreadsheet linked for account ${messagingAccountId}`);
        }
      } catch (err) {
        console.error('[Sheets] triggerFullSync error:', err);
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
