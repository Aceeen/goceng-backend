import { Router } from 'express';
import { getReportData } from './report.controller';

const router = Router();
router.get('/data', getReportData);

export default router;
