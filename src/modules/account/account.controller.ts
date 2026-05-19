import { Request, Response } from 'express';
import { AccountService } from './account.service';

export const getAccounts = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const accounts = await AccountService.getAccountsByMessagingAccountId(messagingAccountId);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch accounts' } });
  }
};

export const createAccount = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const account = await AccountService.createAccount(messagingAccountId, req.body);
    res.status(201).json(account);
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid data' } });
  }
};

export const updateAccount = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const account = await AccountService.updateAccount(req.params.id, messagingAccountId, req.body);
    res.json(account);
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
  }
};

export const deleteAccount = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    await AccountService.deleteAccount(req.params.id, messagingAccountId);
    res.json({ message: 'Account removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
  }
};
