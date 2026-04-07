import { google } from 'googleapis';
import { env } from './env';

export const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI
);

export const sheetsAPI = google.sheets({ version: 'v4', auth: oauth2Client });
export const driveAPI = google.drive({ version: 'v3', auth: oauth2Client });
