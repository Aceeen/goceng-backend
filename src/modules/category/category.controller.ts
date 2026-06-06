import { Request, Response } from 'express';
import { CategoryService } from './category.service';

export const getCategories = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string | undefined;
    if (!messagingAccountId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    }
    const categories = await CategoryService.getAllCategories(messagingAccountId);
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch categories' } });
  }
};

export const createCategory = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string | undefined;
    if (!messagingAccountId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    }
    const { name, type, icon, color, keywords } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Missing name or type' } });
    }
    const category = await CategoryService.createCategory(messagingAccountId, { name, type, icon, color, keywords });
    res.status(201).json(category);
  } catch (error: any) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message || 'Invalid category data' } });
  }
};

export const updateCategory = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string | undefined;
    if (!messagingAccountId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    }
    const { id } = req.params;
    const category = await CategoryService.updateCategory(id, messagingAccountId, req.body);
    res.json(category);
  } catch (error: any) {
    const status = error.message?.includes('tidak ditemukan') ? 404 : 400;
    res.status(status).json({ error: { code: 'VALIDATION_ERROR', message: error.message || 'Failed to update category' } });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string | undefined;
    if (!messagingAccountId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    }
    const { id } = req.params;
    await CategoryService.deleteCategory(id, messagingAccountId);
    res.json({ message: 'Category removed' });
  } catch (error: any) {
    const status = error.message?.includes('tidak ditemukan') ? 404 : 400;
    res.status(status).json({ error: { code: 'VALIDATION_ERROR', message: error.message || 'Failed to delete category' } });
  }
};
