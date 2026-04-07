import { Request, Response } from 'express';
import { BudgetService } from './budget.service';

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const budgets = await BudgetService.getBudgets(req.user!.sub);
    res.json(budgets);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to fetch budgets' } });
  }
};

export const upsertBudget = async (req: Request, res: Response) => {
  try {
    const budget = await BudgetService.upsertBudget(req.user!.sub, req.body);
    res.status(201).json(budget);
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid budget data' } });
  }
};

export const deleteBudget = async (req: Request, res: Response) => {
  try {
    await BudgetService.deleteBudget(req.params.id, req.user!.sub);
    res.json({ message: 'Budget removed' });
  } catch (error) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Budget not found' } });
  }
};
