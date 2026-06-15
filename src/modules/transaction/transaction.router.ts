import { Router } from 'express';
import { getTransactions, createTransaction, deleteTransaction, updateTransaction } from './transaction.controller';

const router = Router();
router.get('/', getTransactions);
router.post('/', createTransaction);
router.patch('/:id', updateTransaction);
router.delete('/:id', deleteTransaction);

export default router;
