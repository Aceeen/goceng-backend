import { Request, Response } from 'express';
import { DashboardService } from './dashboard.service';

export const getSummary = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const data = await DashboardService.getSummary(messagingAccountId);
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate dashboard summary' } });
  }
};

export const getCashflow = async (req: Request, res: Response) => {
  try {
    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });
    const data = await DashboardService.getCashflow(messagingAccountId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate cashflow' } });
  }
};
