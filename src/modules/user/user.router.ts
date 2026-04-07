import { Router } from 'express';
import { getProfile, updateProfile } from './user.controller';
import { authenticate } from '../../middlewares/authenticate';

const router = Router();
router.get('/me', authenticate, getProfile);
router.patch('/me', authenticate, updateProfile);

export default router;
