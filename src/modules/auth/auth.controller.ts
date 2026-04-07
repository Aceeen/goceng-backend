import { Request, Response } from 'express';
import crypto from 'crypto';
import { AuthService } from './auth.service';
import { env } from '../../config/env';

/**
 * Initiates the Google OAuth login flow.
 */
export const googleLogin = (req: Request, res: Response) => {
  // Generate a random state string to mitigate CSRF attacks
  const state = crypto.randomBytes(32).toString('hex');
  
  // Optional: In a full production app, you might save `state` in a cookie here
  // to verify it during the callback.
  
  const url = AuthService.getGoogleAuthUrl(state);
  res.redirect(url);
};

/**
 * Handles the callback from Google, exchanges the code, and redirects to the frontend.
 */
export const googleCallback = async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const error = req.query.error as string;

  if (error) {
    console.error('Google OAuth Error:', error);
    return res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
  }

  if (!code) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing auth code' } });
  }

  try {
    const jwtToken = await AuthService.processGoogleCallback(code);
    
    // Redirect back to frontend dashboard with the JWT token in the URL params
    res.redirect(`${env.FRONTEND_URL}/dashboard?token=${jwtToken}`);
  } catch (err) {
    console.error('Failed to process Google Callback:', err);
    res.redirect(`${env.FRONTEND_URL}/login?error=server_error`);
  }
};

/**
 * Logs the user out.
 * Client drops the token. Optionally, we could blacklist standard JWTs in DB.
 */
export const logout = (req: Request, res: Response) => {
  res.status(200).json({ message: 'Successfully logged out. Please drop token on the client side.' });
};
