import { Request, Response } from 'express';
import crypto from 'crypto';
import { AuthService } from './auth.service';
import { env } from '../../config/env';
import { UserService } from '../user/user.service';

/**
 * Initiates the Google OAuth login flow.
 */
export const googleLogin = (req: Request, res: Response) => {
  const waNumber = req.query.wa as string;

  // We wrap any custom params (like wa mapping) into the standard CSRF 'state' packet
  // so Google bounces it back to us untouched.
  const stateObj = {
    csrf: crypto.randomBytes(16).toString('hex'),
    wa: waNumber || null
  };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');
  
  const url = AuthService.getGoogleAuthUrl(state);
  res.redirect(url);
};

/**
 * Handles the callback from Google, exchanges the code, and redirects to the frontend.
 */
export const googleCallback = async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const error = req.query.error as string;
  const state = req.query.state as string;

  if (error) {
    console.error('Google OAuth Error:', error);
    return res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
  }

  if (!code) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing auth code' } });
  }

  try {
    const jwtToken = await AuthService.processGoogleCallback(code, state);
    
    // Redirect back to frontend dashboard with the JWT token in the URL params
    res.redirect(`${env.FRONTEND_URL}/dashboard?token=${jwtToken}`);
  } catch (err) {
    console.error('Failed to process Google Callback:', err);
    res.redirect(`${env.FRONTEND_URL}/login?error=server_error`);
  }
};

export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    const user = await UserService.getUserProfile(req.user!.sub);
    res.json(user);
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User profile not found' } });
  }
};

/**
 * Logs the user out.
 * Client drops the token. Optionally, we could blacklist standard JWTs in DB.
 */
export const logout = (req: Request, res: Response) => {
  res.status(200).json({ message: 'Successfully logged out. Please drop token on the client side.' });
};
