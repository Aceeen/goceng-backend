import { Request, Response } from 'express';
import { SheetsService } from './sheets.service';
import { prisma } from '../../config/prisma';

export const syncTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.spreadsheetId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'User lacking active spreadsheet integration' } });
    }

    const unsyncedTransactions = await prisma.transaction.findMany({
      where: { userId, isSynced: false, deletedAt: null },
      include: { category: true, account: true }
    });

    if (unsyncedTransactions.length === 0) {
      return res.status(200).json({ message: 'No new transactions to sync', count: 0 });
    }

    // Append to Google Sheets
    for (const tx of unsyncedTransactions) {
      // Temporary mock object to fix properties
      const mappedTx = {
        ...tx,
        transactionDate: tx.transactionDate.toISOString().split('T')[0],
        currentBalance: 'N/A' // Requires passing account balances tracking
      };
      await SheetsService.appendTransaction(userId, user.spreadsheetId, mappedTx);
    }

    // Mark as synced
    await prisma.transaction.updateMany({
      where: { id: { in: unsyncedTransactions.map(tx => tx.id) } },
      data: { isSynced: true }
    });

    res.status(200).json({ message: 'Sync complete', count: unsyncedTransactions.length });
  } catch (error) {
    console.error('Failed to sync sheets:', error);
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Google Sheets sync failed' } });
  }
};
