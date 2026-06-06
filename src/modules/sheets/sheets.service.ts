import { sheetsAPI, oauth2Client } from '../../config/googleClient';
import { prisma } from '../../config/prisma';
import { decryptToken, encryptToken } from '../../utils/encryption';
import { env } from '../../config/env';
import { google } from 'googleapis';

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

    const exists = await this.checkIfSpreadsheetExists(userId, spreadsheetId);
    if (!exists) {
      const error = new Error('Spreadsheet not found (deleted or trashed).');
      (error as any).code = 404;
      if (transaction?.messagingAccountId) {
        await this.handleOAuthError(error, transaction.messagingAccountId);
      }
      throw error;
    }

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
      const exists = await this.checkIfSpreadsheetExists(userId, spreadsheetId);
      if (!exists) {
        const error = new Error('Spreadsheet not found (deleted or trashed).');
        (error as any).code = 404;
        await this.handleOAuthError(error, messagingAccountId);
        throw error;
      }
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
      const exists = await this.checkIfSpreadsheetExists(userId, spreadsheetId);
      if (!exists) {
        const error = new Error('Spreadsheet not found (deleted or trashed).');
        (error as any).code = 404;
        await this.handleOAuthError(error, messagingAccountId);
        throw error;
      }
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

    // 3. Sync Transactions tab (Full batch rewrite for current year to avoid duplicates)
    try {
      await this.authenticateUser(userId);
      
      // Clear all existing transactions in the sheet (from row 2 down)
      await sheetsAPI.spreadsheets.values.clear({
        spreadsheetId,
        range: 'TRANSACTIONS!A2:L10000',
      });

      // Query all transactions of the CURRENT YEAR
      const currentYear = new Date().getFullYear();
      const startDate = new Date(currentYear, 0, 1);
      const endDate = new Date(currentYear, 11, 31, 23, 59, 59, 999);

      const transactions = await prisma.transaction.findMany({
        where: {
          messagingAccountId,
          isConfirmed: true,
          deletedAt: null,
          OR: [
            { transactionDate: { gte: startDate, lte: endDate } },
            { createdAt: { gte: startDate, lte: endDate } }
          ]
        },
        include: {
          category: { select: { name: true } },
          account: { select: { name: true, currentBalance: true } },
        },
        orderBy: { transactionDate: 'asc' },
      });

      if (transactions.length > 0) {
        const values = transactions.map((tx: any) => [
          tx.id,
          `${String(tx.transactionDate.getDate()).padStart(2, '0')}/${String(tx.transactionDate.getMonth() + 1).padStart(2, '0')}/${tx.transactionDate.getFullYear()}`,
          tx.type,
          Number(tx.amount),
          tx.category?.name || '',
          tx.description || '',
          tx.merchantName || '',
          tx.account?.name || '',
          tx.source,
          Number(tx.account?.currentBalance ?? 0),
          tx.imageUrl || '',
          tx.createdAt.toISOString()
        ]);

        await sheetsAPI.spreadsheets.values.update({
          spreadsheetId,
          range: `TRANSACTIONS!A2:L${transactions.length + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values,
          },
        });

        // Mark all as synced in database
        await prisma.transaction.updateMany({
          where: {
            id: { in: transactions.map(t => t.id) }
          },
          data: {
            isSynced: true
          }
        });
      }

      console.log(`[Sheets] Full sync complete. Synced ${transactions.length} transactions for current year (${currentYear}).`);
    } catch (err) {
      console.error(`[Sheets] Failed to sync transactions to Sheets for user ${userId}:`, err);
      await this.handleOAuthError(err, messagingAccountId);
    }
  }

  static async checkIfSpreadsheetExists(userId: string, spreadsheetId: string): Promise<boolean> {
    try {
      await this.authenticateUser(userId);
      const driveAPI = google.drive({ version: 'v3', auth: oauth2Client });
      const fileRes = await driveAPI.files.get({
        fileId: spreadsheetId,
        fields: 'id, trashed'
      });
      if (fileRes.data.trashed) {
        return false;
      }
      return true;
    } catch (err: any) {
      const errStr = String(err.message || err);
      if (errStr.includes('not found') || err.code === 404 || err.status === 404) {
        return false;
      }
      throw err;
    }
  }

  static async regenerateSpreadsheet(messagingAccountId: string): Promise<string> {
    const accountMeta = await prisma.messagingAccount.findUnique({
      where: { id: messagingAccountId },
      select: { userId: true, platform: true, externalId: true }
    });

    if (!accountMeta || !accountMeta.userId) {
      throw new Error('User account not found');
    }

    const { userId, platform, externalId } = accountMeta;
    await this.authenticateUser(userId);

    const driveAPI = google.drive({ version: 'v3', auth: oauth2Client });
    
    // 1. Check or Create GOCENG Master Folder
    let rootFolderId: string;
    const rootSearch = await driveAPI.files.list({
      q: "name='GOCENG' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)'
    });
    if (rootSearch.data.files && rootSearch.data.files.length > 0) {
      rootFolderId = rootSearch.data.files[0].id!;
    } else {
      const rootFolderRes = await driveAPI.files.create({
        requestBody: { name: 'GOCENG', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      rootFolderId = rootFolderRes.data.id!;
    }

    // 2. Create Platform Specific Folder
    const platformFolderName = `${platform.toLowerCase()}_${externalId}`;
    let platformFolderId: string;
    const platformSearch = await driveAPI.files.list({
      q: `name='${platformFolderName}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`,
      fields: 'files(id)'
    });
    if (platformSearch.data.files && platformSearch.data.files.length > 0) {
      platformFolderId = platformSearch.data.files[0].id!;
    } else {
      const platformFolderRes = await driveAPI.files.create({
        requestBody: { 
          name: platformFolderName, 
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootFolderId]
        },
        fields: 'id'
      });
      platformFolderId = platformFolderRes.data.id!;
    }

    // 3. Create Bukti Transaksi Sub-folder
    let googleDriveFolderId: string;
    const subSearch = await driveAPI.files.list({
      q: `name='bukti_transaksi' and mimeType='application/vnd.google-apps.folder' and '${platformFolderId}' in parents and trashed=false`,
      fields: 'files(id)'
    });
    if (subSearch.data.files && subSearch.data.files.length > 0) {
      googleDriveFolderId = subSearch.data.files[0].id!;
    } else {
      const subFolderRes = await driveAPI.files.create({
        requestBody: { 
          name: 'bukti_transaksi', 
          mimeType: 'application/vnd.google-apps.folder',
          parents: [platformFolderId]
        },
        fields: 'id'
      });
      googleDriveFolderId = subFolderRes.data.id!;
    }

    // 4. Copy Spreadsheet Template
    const copyRes = await driveAPI.files.copy({
      fileId: env.MASTER_SPREADSHEET_ID,
      requestBody: {
        name: `GOCENG Record - ${platformFolderName}`,
        parents: [platformFolderId]
      },
      fields: 'id'
    });
    const spreadsheetId = copyRes.data.id!;

    // 5. Save setup to MessagingAccount
    await prisma.messagingAccount.update({
      where: { id: messagingAccountId },
      data: { spreadsheetId, googleDriveFolderId },
    });

    console.log(`[Regenerate Setup] Complete. Sheet: ${spreadsheetId}, Folder: ${googleDriveFolderId}`);
    return spreadsheetId;
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
    const isNotFound = errStr.includes('not found') || error?.code === 404 || error?.status === 404 || errResponseData.includes('notFound');

    if (isNotFound) {
      console.warn(`[Sheets] Google Sheet not found for account ${messagingAccountId}. Clearing spreadsheetId and notifying user...`);
      try {
        await prisma.messagingAccount.update({
          where: { id: messagingAccountId },
          data: { spreadsheetId: null }
        });

        const messagingAccount = await prisma.messagingAccount.findUnique({
          where: { id: messagingAccountId },
          select: { platform: true, externalId: true },
        });

        if (messagingAccount) {
          const { platform, externalId } = messagingAccount;
          const loginLink = platform === 'TELEGRAM'
            ? `${env.BACKEND_URL ?? env.FRONTEND_URL}/v1/auth/google?tg=${externalId}`
            : `${env.FRONTEND_URL}/login?platform=WHATSAPP&id=${externalId}`;

          const message = `⚠️ *File Google Sheets Tidak Ditemukan!*\n\n` +
            `File sheets tidak ditemukan. Klik tombol di bawah untuk membuat file baru secara otomatis. /sync untuk menyinkronkan data`;

          if (platform === 'TELEGRAM') {
            const { TelegramService } = await import('../webhook/telegram.service');
            await TelegramService.sendInteractiveButtons(externalId, message, [
              { id: 'regenerate_sheets', title: '🖨️ Buat Ulang Spreadsheet' }
            ]);
          } else {
            const { WhatsAppService } = await import('../webhook/whatsapp.service');
            await WhatsAppService.sendInteractiveButtons(externalId, message, [
              { id: 'regenerate_sheets', title: 'Buat Ulang Sheet' }
            ]);
          }
        }
      } catch (notifyErr) {
        console.error('[Sheets] Failed to handle missing sheet error:', notifyErr);
      }
      return;
    }

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
