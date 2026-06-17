import { Request, Response } from 'express';
import { ReportService } from './report.service';
import { DriveService } from '../sheets/drive.service';
import { prisma } from '../../config/prisma';

const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

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

export const getExportUrl = async (req: Request, res: Response) => {
  try {
    const month = parseInt(req.query.month as string);
    const format = (req.query.format as string) || 'pdf';

    if (isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Valid month (1-12) is required' } });
    }

    const messagingAccountId = req.headers['x-messaging-account-id'] as string;
    if (!messagingAccountId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing X-Messaging-Account-Id header' } });

    const account = await prisma.messagingAccount.findUnique({
      where: { id: messagingAccountId },
      select: { userId: true, spreadsheetId: true }
    });

    if (!account || !account.spreadsheetId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' } });
    }

    const sheetName = MONTHS_ID[month - 1];
    const exportUrl = await DriveService.getSheetExportUrlByName(account.userId, account.spreadsheetId, sheetName, format);

    if (!exportUrl) {
      // Fallback: If month sheet not found, just return default URL (first sheet)
      return res.json({ url: `https://docs.google.com/spreadsheets/d/${account.spreadsheetId}/export?format=${format}&portrait=false` });
    }

    res.json({ url: exportUrl });
  } catch (error) {
    console.error('Failed to get export URL:', error);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Failed to generate export URL' } });
  }
};
