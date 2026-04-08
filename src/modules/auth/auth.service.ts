import jwt from 'jsonwebtoken';
import { oauth2Client } from '../../config/googleClient';
import { google } from 'googleapis';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { encryptToken } from '../../utils/encryption';

export class AuthService {
  /**
   * Generates the Google OAuth consent screen URL.
   */
  static getGoogleAuthUrl(state: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets'
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
    });
  }

  /**
   * Processes the Google OAuth callback code, extracts user profile, saves tokens,
   * duplicates the Master Spreadsheet (if needed), and signs a JWT.
   */
  static async processGoogleCallback(code: string, stateString: string = ''): Promise<string> {
    // 1. Decode State Payload to recover WhatsApp Number
    let waNumber: string | null = null;
    try {
      if (stateString) {
        const decoded = Buffer.from(stateString, 'base64').toString('utf8');
        const stateObj = JSON.parse(decoded);
        waNumber = stateObj.wa || null;
      }
    } catch(e) {
      console.warn('Failed to parse OAuth state object');
    }

    // 2. Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 2. Fetch User Profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    if (!userInfo.data.email || !userInfo.data.id) {
      throw new Error('Google did not return required user information.');
    }

    // 4. Upsert User in DB
    const user = await prisma.user.upsert({
      where: { googleId: userInfo.data.id },
      update: {
        email: userInfo.data.email,
        name: userInfo.data.name || 'User',
        profilePicture: userInfo.data.picture,
        ...(waNumber ? { whatsappNumber: waNumber } : {})
      },
      create: {
        googleId: userInfo.data.id,
        email: userInfo.data.email,
        name: userInfo.data.name || 'User',
        profilePicture: userInfo.data.picture,
        currencyCode: 'IDR',
        whatsappNumber: waNumber,
      },
    });

    // 5. Encrypt and Upsert OAuth Tokens
    if (tokens.access_token && tokens.refresh_token) {
      const encryptedAccess = encryptToken(tokens.access_token);
      const encryptedRefresh = encryptToken(tokens.refresh_token);
      const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000);

      await prisma.oAuthToken.upsert({
        where: { userId: user.id },
        update: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokenExpiry,
          scope: tokens.scope || '',
        },
        create: {
          userId: user.id,
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: tokenExpiry,
          scope: tokens.scope || '',
        },
      });
    }

    // 6. Handle master spreadsheet duplication and folder configuration if missing
    let spreadsheetId = user.spreadsheetId;
    let googleDriveFolderId = user.googleDriveFolderId || null;

    if (!spreadsheetId || !googleDriveFolderId) {
      console.log(`[Drive Setup] Constructing folder tree for new user ${user.id}...`);
      const driveAPI = google.drive({ version: 'v3', auth: oauth2Client });
      
      try {
        // 5a. Create GOCENG Master Folder
        const rootFolderRes = await driveAPI.files.create({
          requestBody: { name: 'GOCENG', mimeType: 'application/vnd.google-apps.folder' },
          fields: 'id'
        });
        const rootFolderId = rootFolderRes.data.id!;

        // 5b. Create Bukti Transaksi Sub-folder
        const subFolderRes = await driveAPI.files.create({
          requestBody: { 
            name: 'bukti_transaksi', 
            mimeType: 'application/vnd.google-apps.folder',
            parents: [rootFolderId]
          },
          fields: 'id'
        });
        googleDriveFolderId = subFolderRes.data.id!;

        // 5c. Copy Spreadsheet Template
        const copyRes = await driveAPI.files.copy({
          fileId: env.MASTER_SPREADSHEET_ID,
          requestBody: {
            name: `GOCENG Record - ${user.name}`,
            parents: [rootFolderId]
          },
          fields: 'id'
        });
        spreadsheetId = copyRes.data.id!;
        
        // 5d. Save setup globally
        await prisma.user.update({
          where: { id: user.id },
          data: { spreadsheetId, googleDriveFolderId },
        });

        console.log(`[Drive Setup] Complete. Sheet: ${spreadsheetId}, Folder: ${googleDriveFolderId}`);
      } catch (error) {
        console.error(`[Drive Setup] Failed to create folder structure:`, error);
        // Will fallback to null if the user's template fails to clone
      }
    }

    // 7. Generate standard 7-day GOCENG JWT
    const jwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      isOnboarded: user.isOnboarded,
      spreadsheetId,
    };

    const apiToken = jwt.sign(jwtPayload, env.JWT_SECRET, { expiresIn: '7d' });
    return apiToken;
  }
}
