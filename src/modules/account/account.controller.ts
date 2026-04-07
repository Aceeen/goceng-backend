import { Request, Response } from 'express';
import { AccountService } from './account.service';

export const getAccounts = async (req: Request, res: Response) => {
  try {
    const accounts = await AccountService.getAccountsByUserId(req.user!.sub);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch accounts' } });
  }
};

export const createAccount = async (req: Request, res: Response) => {
  try {
    const account = await AccountService.createAccount(req.user!.sub, req.body);
    res.status(201).json(account);
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid data' } });
  }
};

export const updateAccount = async (req: Request, res: Response) => {
  try {
    const account = await AccountService.updateAccount(req.params.id, req.user!.sub, req.body);
    res.json(account);
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
  }
};

export const deleteAccount = async (req: Request, res: Response) => {
  try {
    await AccountService.deleteAccount(req.params.id, req.user!.sub);
    res.json({ message: 'Account removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
  }
};
