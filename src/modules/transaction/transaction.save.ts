// src/modules/transaction/transaction.save.ts

import { prisma } from '../../config/prisma';
import {
  OCRResult,
  NLPResult,
  OCRTransactionItem,
  isOCRBlur,
  isOCRForeign,
  isOCRNormal,
} from '../ai/ai.types';
import { SheetsService } from '../sheets/sheets.service';

type ExtractedData =
  | (OCRResult & {
      accountId?: string;
      type?: 'INCOME' | 'EXPENSE';
    })
  | (NLPResult & {
      accountId?: string;
      type?: 'INCOME' | 'EXPENSE';
    });

function isNLPResult(data: ExtractedData): data is NLPResult & {
  accountId?: string;
  type?: 'INCOME' | 'EXPENSE';
} {
  return 'amount' in data && 'description' in data;
}

function getTransactionSource(data: ExtractedData): 'WHATSAPP_OCR' | 'WHATSAPP_TEXT' {
  return isNLPResult(data) ? 'WHATSAPP_TEXT' : 'WHATSAPP_OCR';
}

export async function saveConfirmedTransaction(
  messagingAccountId: string,
  data: ExtractedData,
  imageUrl?: string | null
) {
  // OCR blur tidak boleh disimpan karena data transaksi tidak lengkap
  if (!isNLPResult(data) && isOCRBlur(data)) {
    throw new Error('OCR_RESULT_BLUR_CANNOT_SAVE');
  }

  const account = data.accountId
    ? await prisma.account.findFirst({
        where: {
          id: data.accountId,
          messagingAccountId,
          isActive: true,
        },
      })
    : await prisma.account.findFirst({
        where: {
          messagingAccountId,
          isActive: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

  if (!account) {
    throw new Error('USER_HAS_NO_ACCOUNT');
  }

  const accountMeta = await prisma.messagingAccount.findUnique({
    where: { id: messagingAccountId },
    select: { spreadsheetId: true, userId: true, platform: true },
  });

  const accountId = account.id;
  const normalizedCategory =
    (data as any).suggestedCategory ??
    (data as any).category ??
    (data as any).kategori ??
    (data as any).categoryName;

  let category = null;
  let transactionType: 'INCOME' | 'EXPENSE' = data.type ?? 'EXPENSE';
  if (data.suggestedCategory) {
    category = await prisma.category.findFirst({
      where: {
        name: {
          equals: data.suggestedCategory,
          mode: 'insensitive'
        },
        OR: [
          { isSystem: true },
          { messagingAccountId }
        ]
      },
    });

    // 🔥 kalau belum ada → bikin baru
    if (!category) {
      category = await prisma.category.create({
        data: {
          name: data.suggestedCategory,
          type: transactionType,
          messagingAccountId
        },
      });
    }
  }

  let amount = 0;
  
  let description: string | null = null;
  let merchantName: string | null = null;
  let transactionDate: Date = new Date();
  let items: OCRTransactionItem[] = [];

  const platform = accountMeta?.platform ?? 'WHATSAPP';
  let source: 'WHATSAPP_OCR' | 'WHATSAPP_TEXT' | 'TELEGRAM_OCR' | 'TELEGRAM_TEXT';
  if (platform === 'TELEGRAM') {
    source = isNLPResult(data) ? 'TELEGRAM_TEXT' : 'TELEGRAM_OCR';
  } else {
    source = isNLPResult(data) ? 'WHATSAPP_TEXT' : 'WHATSAPP_OCR';
  }

  if (isNLPResult(data)) {
    amount = data.amount ?? 0;
    transactionType = data.type ?? 'EXPENSE';
    description = data.description ?? null;
    merchantName = null;
    transactionDate = data.transactionDate ? new Date(data.transactionDate) : new Date();
    items = [];
  } else if (isOCRNormal(data) || isOCRForeign(data)) {
    amount = data.totalAmount ?? 0;
    transactionType = data.type ?? 'EXPENSE';
    description = data.merchantName ?? null;
    merchantName = data.merchantName ?? null;
    transactionDate = data.transactionDate ? new Date(data.transactionDate) : new Date();
    items = data.items ?? [];
  }

  const [transaction] = await prisma.$transaction([
    prisma.transaction.create({
      data: {
        messagingAccountId,
        accountId,
        categoryId: category?.id ?? null,
        type: transactionType,
        amount,
        description,
        merchantName,
        transactionDate,
        source,
        imageUrl: imageUrl || null,
        isConfirmed: true,
        isSynced: false,
        items: items.length
          ? {
              create: items.map((item: OCRTransactionItem) => ({
                name: item.name,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.totalPrice,
              })),
            }
          : undefined,
      },
    }),

    prisma.account.update({
      where: { id: accountId },
      data: {
        currentBalance: {
          [transactionType === 'INCOME' ? 'increment' : 'decrement']: amount,
        },
      },
    }),
  ]);

  const updatedAccount = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      name: true,
      currentBalance: true,
    },
  });

  const spreadsheetId = accountMeta?.spreadsheetId;

if (spreadsheetId) {
  setImmediate(async () => {
    try {
      const fullTx = await prisma.transaction.findUnique({
        where: { id: transaction.id },
        include: {
          category: { select: { name: true } },
          account: { select: { name: true } },
        },
      });

      if (fullTx && accountMeta?.userId) {
        await SheetsService.appendTransaction(accountMeta.userId, spreadsheetId, {
          ...fullTx,
          transactionDate: formatDate(fullTx.transactionDate),
          amount: Number(fullTx.amount),
          currentBalance: Number(updatedAccount?.currentBalance ?? 0),
        });

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { isSynced: true },
        });

        // Sync accounts to sheets since currentBalance has been updated
        await SheetsService.syncAccountsToSheet(
          accountMeta.userId,
          spreadsheetId,
          messagingAccountId
        );
      }
    } catch (err) {
      console.error('[Sheets] Gagal sync transaksi:', err);
    }
  });
}

  // Budget info — always returned when the category has an active monthly budget,
  // regardless of whether the limit has been reached.
  let budgetInfo: {
    categoryName: string;
    limitAmount: number;
    currentSpent: number;
    remaining: number;
    percentage: number;
    warningLevel: 'OK' | 'WARNING' | 'EXCEEDED';
  } | null = null;

  if (transaction.type === 'EXPENSE' && transaction.categoryId) {
    try {
      const txDate = transaction.transactionDate;
      const month = txDate.getMonth() + 1;
      const year = txDate.getFullYear();

      const budget = await prisma.budget.findUnique({
        where: {
          messagingAccountId_categoryId_month_year: {
            messagingAccountId,
            categoryId: transaction.categoryId,
            month,
            year,
          },
        },
        include: { category: { select: { name: true } } },
      });

      if (budget) {
        const startOfMonth = new Date(txDate.getFullYear(), txDate.getMonth(), 1);
        const endOfMonth = new Date(txDate.getFullYear(), txDate.getMonth() + 1, 0, 23, 59, 59, 999);

        const totalExpense = await prisma.transaction.aggregate({
          where: {
            messagingAccountId,
            categoryId: transaction.categoryId,
            type: 'EXPENSE',
            isConfirmed: true,
            deletedAt: null,
            transactionDate: { gte: startOfMonth, lte: endOfMonth },
          },
          _sum: { amount: true },
        });

        const currentSpent = Number(totalExpense._sum.amount ?? 0);
        const limit = Number(budget.limitAmount);
        const remaining = Math.max(0, limit - currentSpent);
        const percentage = limit > 0 ? (currentSpent / limit) * 100 : 0;

        let warningLevel: 'OK' | 'WARNING' | 'EXCEEDED' = 'OK';
        if (currentSpent >= limit) warningLevel = 'EXCEEDED';
        else if (percentage >= 80) warningLevel = 'WARNING';

        budgetInfo = {
          categoryName: budget.category.name,
          limitAmount: limit,
          currentSpent,
          remaining,
          percentage,
          warningLevel,
        };
      }
    } catch (budgetErr) {
      console.error('[Budget] Failed to check budget:', budgetErr);
    }
  }

  return {
    transaction,
    account: updatedAccount,
    budgetWarning: budgetInfo, // keep field name for backward compat
    budgetInfo,
  };
}

function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}