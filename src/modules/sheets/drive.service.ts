import { driveAPI, oauth2Client } from '../../config/googleClient';
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

    // Convert strict Buffer into a Readable stream for Google Drive Media requirements
    const stream = new Readable();
    stream.push(imageBuffer);
    stream.push(null);

    try {
      const fileMeta = await driveAPI.files.create({
        requestBody: {
          name: fileName,
          mimeType
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
}
