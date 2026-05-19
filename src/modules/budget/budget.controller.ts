import { Request, Response } from 'express';
import { BudgetService } from './budget.service';

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const budgets = await BudgetService.getBudgets(messagingAccountId);
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch budgets' } });
  }
};

export const upsertBudget = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const budget = await BudgetService.upsertBudget(messagingAccountId, req.body);
    res.status(201).json(budget);
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid budget data' } });
  }
};

export const deleteBudget = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    await BudgetService.deleteBudget(req.params.id, messagingAccountId);
    res.json({ message: 'Budget removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Budget not found' } });
  }
};
