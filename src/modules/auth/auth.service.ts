import jwt from 'jsonwebtoken';
import { oauth2Client } from '../../config/googleClient';
import { google } from 'googleapis';
import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { encryptToken } from '../../utils/encryption';
import crypto from 'crypto';

export class AuthService {
  private static hasConfiguredMasterSpreadsheet(): boolean {
    return Boolean(
      env.MASTER_SPREADSHEET_ID &&
      !env.MASTER_SPREADSHEET_ID.toLowerCase().includes('placeholder')
    );
  }

  /**
   * Generates the Google OAuth consent screen URL.
   */
  static getGoogleAuthUrl(state: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/drive',
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
    // 1. Decode State Payload to recover Platform and External ID
    let platform: 'TELEGRAM' | 'WHATSAPP' | null = null;
    let externalId: string | null = null;
    try {
      if (stateString) {
        const parts = Buffer.from(stateString, 'base64').toString('utf8').split(':');
        if (parts.length === 3) {
          const [ivHex, encryptedHex, authTagHex] = parts;
          const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex'),
            Buffer.from(ivHex, 'hex')
          );
          decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
          let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          const stateObj = JSON.parse(decrypted);
          platform = stateObj.platform || null;
          externalId = stateObj.externalId || null;
        } else {
          // Fallback to unencrypted (legacy or dev)
          const decoded = Buffer.from(stateString, 'base64').toString('utf8');
          const stateObj = JSON.parse(decoded);
          platform = stateObj.platform || null;
          externalId = stateObj.externalId || null;
        }
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
      },
      create: {
        googleId: userInfo.data.id,
        email: userInfo.data.email,
        name: userInfo.data.name || 'User',
        profilePicture: userInfo.data.picture,
        currencyCode: 'IDR',
      },
    });

    let messagingAccount = null;
    if (platform && externalId) {
      messagingAccount = await prisma.messagingAccount.upsert({
        where: { platform_externalId: { platform, externalId } },
        update: {},
        create: {
          userId: user.id,
          platform,
          externalId,
        }
      });
    }

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
    let spreadsheetId = messagingAccount?.spreadsheetId || null;
    let googleDriveFolderId = messagingAccount?.googleDriveFolderId || null;

    if (messagingAccount && (!spreadsheetId || !googleDriveFolderId)) {
      if (!this.hasConfiguredMasterSpreadsheet()) {
        console.warn(
          '[Drive Setup] Skipped because MASTER_SPREADSHEET_ID is still a placeholder or is not configured.'
        );
      } else {
        console.log(`[Drive Setup] Constructing folder tree for ${platform} ${externalId}...`);
        const driveAPI = google.drive({ version: 'v3', auth: oauth2Client });
        
        try {
          // 5a. Check or Create GOCENG Master Folder
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

          // 5b. Create Platform Specific Folder
          const platformFolderName = `${(platform ?? 'unknown').toLowerCase()}_${externalId}`;
          const platformFolderRes = await driveAPI.files.create({
            requestBody: { 
              name: platformFolderName, 
              mimeType: 'application/vnd.google-apps.folder',
              parents: [rootFolderId]
            },
            fields: 'id'
          });
          const platformFolderId = platformFolderRes.data.id!;

          // 5c. Create Bukti Transaksi Sub-folder
          const subFolderRes = await driveAPI.files.create({
            requestBody: { 
              name: 'bukti_transaksi', 
              mimeType: 'application/vnd.google-apps.folder',
              parents: [platformFolderId]
            },
            fields: 'id'
          });
          googleDriveFolderId = subFolderRes.data.id!;

          // 5d. Copy Spreadsheet Template
          const copyRes = await driveAPI.files.copy({
            fileId: env.MASTER_SPREADSHEET_ID,
            requestBody: {
              name: `GOCENG Record - ${platformFolderName}`,
              parents: [platformFolderId]
            },
            fields: 'id'
          });
          spreadsheetId = copyRes.data.id!;
          
          // 5e. Save setup to MessagingAccount
          await prisma.messagingAccount.update({
            where: { id: messagingAccount.id },
            data: { spreadsheetId, googleDriveFolderId },
          });

          console.log(`[Drive Setup] Complete. Sheet: ${spreadsheetId}, Folder: ${googleDriveFolderId}`);
        } catch (error) {
          console.error(`[Drive Setup] Failed to create folder structure:`, error);
        }
      }
    }

    // 7. Generate standard 7-day GOCENG JWT
    const jwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      isOnboarded: messagingAccount?.isOnboarded || false,
      spreadsheetId,
    };

    const apiToken = jwt.sign(jwtPayload, env.JWT_SECRET, { expiresIn: '7d' });
    return apiToken;
  }
}
