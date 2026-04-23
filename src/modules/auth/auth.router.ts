import { Router } from 'express';
import { googleLogin, googleCallback, getCurrentUser, logout } from './auth.controller';
import { authenticate } from '../../middlewares/authenticate';

const router = Router();

// Route to initialize Google OAuth login
router.get('/google', googleLogin);

// Route for Google to callback into
router.get('/google/callback', googleCallback);

// Protected route to fetch the current user profile
router.get('/me', authenticate, getCurrentUser);

// Protected route to handle logout
router.post('/logout', authenticate, logout);

export default router;
