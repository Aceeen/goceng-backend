import { Request, Response } from 'express';
import { UserService } from './user.service';

export const getProfile = async (req: Request, res: Response) => {
  try {
    const user = await UserService.getUserProfile(req.user!.sub);
    res.json(user);
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User profile not found' } });
  }
};

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const user = await UserService.updateUserProfile(req.user!.sub, req.body);
    res.json(user);
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid user data' } });
  }
};
