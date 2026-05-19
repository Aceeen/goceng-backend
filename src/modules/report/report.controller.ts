import { Request, Response } from 'express';
import { ReportService } from './report.service';

export const getReportData = async (req: Request, res: Response) => {
  try {
    const month = parseInt(req.query.month as string);
    const year = parseInt(req.query.year as string);

    if (isNaN(month) || isNaN(year)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'month and year are required' } });
    }

    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const data = await ReportService.getReportData(messagingAccountId, month, year);
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate report' } });
  }
};
