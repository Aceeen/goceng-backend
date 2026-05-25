import { Request, Response } from 'express';
import { CategoryService } from './category.service';

export const getCategories = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string | undefined;
    const categories = await CategoryService.getAllCategories(messagingAccountId);
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch categories' } });
  }
};
