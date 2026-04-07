import { Request, Response } from 'express';
import { TransactionService } from './transaction.service';

export const getTransactions = async (req: Request, res: Response) => {
  try {
    const result = await TransactionService.getTransactionsByUserId(req.user!.sub, req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch transactions' } });
  }
};

export const createTransaction = async (req: Request, res: Response) => {
  try {
    const transaction = await TransactionService.createTransaction(req.user!.sub, req.body);
    res.status(201).json(transaction);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid transaction data' } });
  }
};

export const deleteTransaction = async (req: Request, res: Response) => {
  try {
    await TransactionService.deleteTransaction(req.params.id, req.user!.sub);
    res.json({ message: 'Transaction removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Transaction not found or already deleted' } });
  }
};
