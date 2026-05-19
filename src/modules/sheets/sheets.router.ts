import { Router } from 'express';
import { syncTransactions } from './sheets.controller';

const router = Router();
// POST /v1/internal/sheets/sync/:messagingAccountId
router.post('/sync/:messagingAccountId', syncTransactions);

export default router;
