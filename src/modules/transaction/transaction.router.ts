import { Router } from 'express';
import { getTransactions, createTransaction, deleteTransaction } from './transaction.controller';

const router = Router();
router.get('/', getTransactions);
router.post('/', createTransaction);
router.delete('/:id', deleteTransaction);

export default router;
