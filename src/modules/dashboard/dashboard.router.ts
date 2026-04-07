import { Router } from 'express';
import { getSummary, getCashflow } from './dashboard.controller';

const router = Router();
router.get('/summary', getSummary);
router.get('/cashflow', getCashflow);

export default router;
