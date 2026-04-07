import { Router } from 'express';
import { getBudgets, upsertBudget, deleteBudget } from './budget.controller';

const router = Router();
router.get('/', getBudgets);
router.post('/', upsertBudget);
router.delete('/:id', deleteBudget);

export default router;
