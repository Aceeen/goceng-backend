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
  static async processGoogleCallback(code: string): Promise<string> {
    // 1. Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 2. Fetch User Profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    if (!userInfo.data.email || !userInfo.data.id) {
      throw new Error('Google did not return required user information.');
    }

    // 3. Upsert User in DB
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

    // 4. Encrypt and Upsert OAuth Tokens
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

    // 5. Handle master spreadsheet duplication if missing
    let spreadsheetId = user.spreadsheetId;
    if (!spreadsheetId) {
      // Mocking the duplication of the template since we don't have a real MASTER_SPREADSHEET_ID drive file yet out of scope
      console.log(`Mocking Google Drive template copy for user ${user.id}`);
      spreadsheetId = 'mock_spreadsheet_id_for_' + user.id;
      
      await prisma.user.update({
        where: { id: user.id },
        data: { spreadsheetId },
      });
    }

    // 6. Generate standard 7-day GOCENG JWT
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
