import cron from 'node-cron';
import { prisma } from '../../config/prisma';
import { ExpenseFrequency, TransactionType, TransactionSource, Prisma } from '@prisma/client';

export const initRoutineCron = () => {
  // Run every day at midnight server time
  cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Starting routine expenses processing...');
    try {
      await processRoutineExpenses();
      console.log('[Cron] Routine expenses processing completed.');
    } catch (error) {
      console.error('[Cron] Error processing routine expenses:', error);
    }
  });

  // Run on the 1st day of every month at 08:00 AM server time
  cron.schedule('0 8 1 * *', async () => {
    console.log('[Cron] Starting monthly expense report notifications...');
    try {
      await sendMonthlyReportNotifications();
      console.log('[Cron] Monthly expense report notifications completed.');
    } catch (error) {
      console.error('[Cron] Error sending monthly expense report notifications:', error);
    }
  });
};

export const processRoutineExpenses = async () => {
  const now = new Date();
  
  // Get all active routines
  const routines = await prisma.routineExpense.findMany({
    where: { isActive: true }
  });

  for (const routine of routines) {
    try {
      // 1. Check if routine is within date range
      if (routine.startDate > now) continue;
      if (routine.endDate && routine.endDate < now) {
        // Automatically deactivate expired routines
        await prisma.routineExpense.update({
          where: { id: routine.id },
          data: { isActive: false }
        });
        continue;
      }

      // 2. Determine if it should run today based on frequency
      let shouldRun = false;
      const start = routine.startDate;

      if (routine.frequency === ExpenseFrequency.DAILY) {
        shouldRun = true;
      } else if (routine.frequency === ExpenseFrequency.WEEKLY) {
        shouldRun = start.getDay() === now.getDay();
      } else if (routine.frequency === ExpenseFrequency.MONTHLY) {
        shouldRun = start.getDate() === now.getDate();
        // Handle end of month edge cases (e.g. started on 31st, but today is 30th of April)
        if (!shouldRun && start.getDate() > 28) {
          const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
          if (now.getDate() === lastDayOfMonth && start.getDate() >= lastDayOfMonth) {
            shouldRun = true;
          }
        }
      } else if (routine.frequency === ExpenseFrequency.ANNUALLY) {
        shouldRun = start.getDate() === now.getDate() && start.getMonth() === now.getMonth();
      }

      if (!shouldRun) continue;

      // 3. Ensure we haven't already processed it today (idempotency)
      if (routine.lastProcessedAt) {
        const last = routine.lastProcessedAt;
        if (last.getDate() === now.getDate() && last.getMonth() === now.getMonth() && last.getFullYear() === now.getFullYear()) {
          continue; // Already processed today
        }
      }

      // 4. Create the actual transaction
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Create transaction
        await tx.transaction.create({
          data: {
            messagingAccountId: routine.messagingAccountId,
            accountId: routine.accountId,
            categoryId: routine.categoryId,
            type: TransactionType.EXPENSE,
            amount: routine.amount,
            description: routine.title + ' (Routine)',
            merchantName: routine.title,
            transactionDate: now,
            source: TransactionSource.MANUAL_WEB, // Or define a SYSTEM source if enum allows
            isConfirmed: true,
            isSynced: false, // Will be picked up by sheets sync job if applicable
          }
        });

        // Update routine's last processed date
        await tx.routineExpense.update({
          where: { id: routine.id },
          data: { lastProcessedAt: now }
        });
      });

      console.log(`[Cron] Generated routine transaction for ${routine.title} (Account: ${routine.messagingAccountId})`);
    } catch (err) {
      console.error(`[Cron] Failed to process routine ${routine.id}:`, err);
    }
  }
};

export const sendMonthlyReportNotifications = async () => {
  const now = new Date();
  
  // Calculate previous month and year
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prevDate.getMonth() + 1; // 1-indexed
  const prevYear = prevDate.getFullYear();
  
  const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const monthName = MONTHS_ID[prevMonth - 1];
  
  // Fetch all onboarded accounts that have a linked spreadsheet
  const accounts = await prisma.messagingAccount.findMany({
    where: {
      isOnboarded: true,
      spreadsheetId: { not: null }
    }
  });
  
  for (const account of accounts) {
    try {
      const buttonId = `cetak_${prevMonth}_${prevYear}`;
      const messageText = `📊 *Laporan Pengeluaran Bulanan Selesai!*\n\n` +
        `Data transaksi Anda untuk bulan *${monthName} ${prevYear}* sudah direkap di Google Sheets.\n\n` +
        `Klik tombol di bawah ini jika Anda ingin mencetak PDF laporan bulan lalu secara otomatis. 👇`;
        
      if (account.platform === 'TELEGRAM') {
        const { TelegramService } = await import('../webhook/telegram.service');
        await TelegramService.sendInteractiveButtons(account.externalId, messageText, [
          { id: buttonId, title: '🖨️ Cetak PDF Laporan' }
        ]);
      } else if (account.platform === 'WHATSAPP') {
        const { WhatsAppService } = await import('../webhook/whatsapp.service');
        await WhatsAppService.sendInteractiveButtons(account.externalId, messageText, [
          { id: buttonId, title: '🖨️ Cetak PDF Laporan' }
        ]);
      }
      
      console.log(`[Cron] Sent monthly report notification to ${account.platform} account ${account.externalId}`);
    } catch (err) {
      console.error(`[Cron] Failed to send monthly report notification to account ${account.id}:`, err);
    }
  }
};
