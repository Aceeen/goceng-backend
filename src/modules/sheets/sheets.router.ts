import { Router } from 'express';
import { syncTransactions } from './sheets.controller';

const router = Router();
// POST /v1/internal/sheets/sync/:userId
router.post('/sync/:userId', syncTransactions);

export default router;
