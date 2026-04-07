import { Router } from 'express';
import { getAccounts, createAccount, updateAccount, deleteAccount } from './account.controller';

const router = Router();
router.get('/', getAccounts);
router.post('/', createAccount);
router.patch('/:id', updateAccount);
router.delete('/:id', deleteAccount);

export default router;
