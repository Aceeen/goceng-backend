import { Request, Response } from 'express';
import { TransactionService } from './transaction.service';

export const getTransactions = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const result = await TransactionService.getTransactionsByMessagingAccountId(messagingAccountId, req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch transactions' } });
  }
};

export const createTransaction = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const transaction = await TransactionService.createTransaction(messagingAccountId, req.body);
    res.status(201).json(transaction);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transaction data' } });
  }
};

export const deleteTransaction = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    await TransactionService.deleteTransaction(req.params.id, messagingAccountId);
    res.json({ message: 'Transaction removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Transaction not found or already deleted' } });
  }
};

export const updateTransaction = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const transaction = await TransactionService.updateTransaction(req.params.id, messagingAccountId, req.body);
    res.json(transaction);
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Transaction not found or cannot be updated' } });
  }
};
