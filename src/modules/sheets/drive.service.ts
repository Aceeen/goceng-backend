import { driveAPI, oauth2Client, sheetsAPI } from '../../config/googleClient';
import { prisma } from '../../config/prisma';
import { decryptToken } from '../../utils/encryption';
import { Readable } from 'stream';

export class DriveService {
  /**
   * Sets up oauth credentials using the user's decrypted DB tokens
   */
  private static async authenticateUser(userId: string) {
    const tokenRecord = await prisma.oAuthToken.findUnique({ where: { userId } });
    if (!tokenRecord) {
      throw new Error(`No OAuth token found for user ${userId}`);
    }

    const accessToken = decryptToken(tokenRecord.accessToken);
    const refreshToken = decryptToken(tokenRecord.refreshToken);

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }

  /**
   * Uploads an image buffer natively to the User's Google Drive as a public viewable file.
   * Returns the webViewLink so it can be saved in Postgres and clicked via React.
   */
  static async uploadReceipt(userId: string, imageBuffer: Buffer, mimeType: string, fileName: string): Promise<string | null> {
    await this.authenticateUser(userId);
    
    // Grab the folder ID we constructed during onboarding
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const targetFolderId = user?.googleDriveFolderId;

    // Convert strict Buffer into a Readable stream for Google Drive Media requirements
    const stream = new Readable();
    stream.push(imageBuffer);
    stream.push(null);

    try {
      const fileMeta = await driveAPI.files.create({
        requestBody: {
          name: fileName,
          mimeType,
          parents: targetFolderId ? [targetFolderId] : undefined
        },
        media: {
          mimeType,
          body: stream,
        },
        fields: 'id, webViewLink'
      });

      if (!fileMeta.data.id) throw new Error('Drive API returned no file ID');

      // Setup universal read permissions for the link so the dashboard can render it
      await driveAPI.permissions.create({
        fileId: fileMeta.data.id,
        requestBody: {
          type: 'anyone',
          role: 'reader'
        }
      });

      console.log(`✅ Uploaded receipt to Google Drive: ${fileMeta.data.webViewLink}`);
      return fileMeta.data.webViewLink || null;
    } catch (error) {
      console.error('❌ Failed to upload receipt to Google Drive:', error);
      return null;
    }
  }

  /**
   * Commands Google to print a specific tab (GID) inside a spreadsheet to PDF and buffers it.
   */
  static async exportSheetToPdf(userId: string, spreadsheetId: string, gid: string): Promise<Buffer | null> {
    await this.authenticateUser(userId);

    // Using the internal Google Sheets export endpoint gives us granular control over formatting
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf&gid=${gid}&portrait=false&size=A4`;

    try {
      const response = await oauth2Client.request<ArrayBuffer>({
        url: exportUrl,
        method: 'GET',
        responseType: 'arraybuffer'
      });

      console.log(`✅ Exported PDF for sheet GID: ${gid}`);
      return Buffer.from(response.data);
    } catch (error) {
      console.error('❌ Failed to export Google Sheet to PDF:', error);
      return null;
    }
  }

  /**
   * Dynamically searches a Google Spreadsheet for a tab matching the provided name,
   * extracts its native GID, and exports ONLY that tab to a PDF Buffer.
   */
  static async exportSheetByName(userId: string, spreadsheetId: string, sheetName: string): Promise<Buffer | null> {
    await this.authenticateUser(userId);

    try {
      // Pull down the metadata structure of the entire spreadsheet
      const metadataStr = await sheetsAPI.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties(sheetId,title)'
      });

      const sheets = metadataStr.data.sheets;
      if (!sheets) throw new Error('No sheets found in Google Spreadsheet.');

      // Find the specific tab that strictly matches the monthly name request
      const targetSheet = sheets.find(s => s.properties?.title === sheetName);

      if (!targetSheet || targetSheet.properties?.sheetId === undefined) {
        console.error(`❌ Dynamic lookup failed: Tab named "${sheetName}" not found in sheet ${spreadsheetId}.`);
        return null;
      }

      const gid = targetSheet.properties!.sheetId!.toString();
      
      // Pipe the extracted GID straight into the exporter
      return await this.exportSheetToPdf(userId, spreadsheetId, gid);
      
    } catch(error) {
      console.error(`❌ Failed to read Google Sheet headers natively:`, error);
      return null;
    }
  }
}
