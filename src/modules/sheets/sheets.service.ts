import { sheetsAPI, oauth2Client } from '../../config/googleClient';
import { prisma } from '../../config/prisma';
import { decryptToken } from '../../utils/encryption';

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
      throw error;
    }
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
}
