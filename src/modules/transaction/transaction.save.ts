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

export async function saveConfirmedTransaction(userId: string, data: ExtractedData) {
  // OCR blur tidak boleh disimpan karena data transaksi tidak lengkap
  if (!isNLPResult(data) && isOCRBlur(data)) {
    throw new Error('OCR_RESULT_BLUR_CANNOT_SAVE');
  }

  const accountId =
    data.accountId ??
    (
      await prisma.account.findFirst({
        where: { userId, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
    )?.id;

  if (!accountId) {
    throw new Error('USER_HAS_NO_ACCOUNT');
  }

  const category = data.suggestedCategory
    ? await prisma.category.findFirst({
        where: { name: data.suggestedCategory },
      })
    : null;

  let amount = 0;
  let transactionType: 'INCOME' | 'EXPENSE' = data.type ?? 'EXPENSE';
  let description: string | null = null;
  let merchantName: string | null = null;
  let transactionDate: Date = new Date();
  let items: OCRTransactionItem[] = [];
  let source: 'WHATSAPP_OCR' | 'WHATSAPP_TEXT' = getTransactionSource(data);

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
        userId,
        accountId,
        categoryId: category?.id ?? null,
        type: transactionType,
        amount,
        description,
        merchantName,
        transactionDate,
        source,
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { spreadsheetId: true },
  });

const spreadsheetId = user?.spreadsheetId;

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

      if (fullTx) {
        await SheetsService.appendTransaction(userId, spreadsheetId, {
          ...fullTx,
          transactionDate: formatDate(fullTx.transactionDate),
          amount: Number(fullTx.amount),
          currentBalance: Number(updatedAccount?.currentBalance ?? 0),
        });

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { isSynced: true },
        });
      }
    } catch (err) {
      console.error('[Sheets] Gagal sync transaksi:', err);
    }
  });
}

  return {
    transaction,
    account: updatedAccount,
  };
}

function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}