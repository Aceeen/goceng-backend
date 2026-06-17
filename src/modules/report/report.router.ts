import { Router } from 'express';
import { getReportData, getExportUrl } from './report.controller';

const router = Router();
router.get('/data', getReportData);
router.get('/export-url', getExportUrl);

export default router;
