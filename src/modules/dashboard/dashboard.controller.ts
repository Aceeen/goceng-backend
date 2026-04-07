import { Request, Response } from 'express';
import { DashboardService } from './dashboard.service';

export const getSummary = async (req: Request, res: Response) => {
  try {
    const data = await DashboardService.getSummary(req.user!.sub);
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate dashboard summary' } });
  }
};

export const getCashflow = async (req: Request, res: Response) => {
  try {
    const data = await DashboardService.getCashflow(req.user!.sub);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate cashflow' } });
  }
};
