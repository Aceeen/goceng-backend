import { TransactionType, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';

export class TransactionService {
  static async getTransactionsByMessagingAccountId(messagingAccountId: string, filters: any) {
    const { page = 1, limit = 20, startDate, endDate, categoryId, accountId, type, search } = filters;
    const skip = (page - 1) * limit;

    const where: any = { messagingAccountId, deletedAt: null };
    
    if (startDate || endDate) {
      where.transactionDate = {};
      if (startDate) where.transactionDate.gte = new Date(startDate);
      if (endDate) where.transactionDate.lte = new Date(endDate);
    }
    if (categoryId) where.categoryId = categoryId;
    if (accountId) where.accountId = accountId;
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { description: { contains: search, mode: 'insensitive' } },
        { merchantName: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        skip: Number(skip),
        take: Number(limit),
        orderBy: { transactionDate: 'desc' },
        include: {
          category: true,
          account: true,
          items: true
        }
      }),
      prisma.transaction.count({ where })
    ]);

    return {
      data: transactions,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  static async createTransaction(messagingAccountId: string, data: any) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Create the Transaction & Items
      const transaction = await tx.transaction.create({
        data: {
          messagingAccountId,
          accountId: data.accountId,
          categoryId: data.categoryId,
          type: data.type,
          amount: data.amount,
          description: data.description,
          merchantName: data.merchantName,
          transactionDate: new Date(data.transactionDate || Date.now()),
          source: data.source || 'MANUAL_WEB',
          items: data.items && data.items.length > 0 ? {
            create: data.items.map((item: any) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice
            }))
          } : undefined
        },
        include: { category: true, account: true, items: true }
      });

      // 2. Adjust the Account Balance
      const amountNum = Number(data.amount);
      const balanceChange = data.type === 'INCOME' ? amountNum : -amountNum;
      
      await tx.account.update({
        where: { id: data.accountId },
        data: {
          currentBalance: {
            increment: balanceChange
          }
        }
      });

      return transaction;
    });
  }

  static async deleteTransaction(id: string, messagingAccountId: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const transaction = await tx.transaction.findUnique({
        where: { id, messagingAccountId }
      });

      if (!transaction || transaction.deletedAt) throw new Error("Not found");

      // Reverse the balance
      const amountNum = Number(transaction.amount);
      const balanceReversal = transaction.type === 'INCOME' ? -amountNum : amountNum;
      
      await tx.account.update({
        where: { id: transaction.accountId },
        data: {
          currentBalance: {
            increment: balanceReversal
          }
        }
      });

      // Soft delete
      return tx.transaction.update({
        where: { id },
        data: { deletedAt: new Date() }
      });
    });
  }

  static async updateTransaction(id: string, messagingAccountId: string, data: any) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Find the existing transaction
      const existing = await tx.transaction.findUnique({
        where: { id, messagingAccountId }
      });

      if (!existing || existing.deletedAt) throw new Error('Not found');

      // 2. Reverse the old balance effect
      const oldAmount = Number(existing.amount);
      const oldBalanceReversal = existing.type === 'INCOME' ? -oldAmount : oldAmount;

      await tx.account.update({
        where: { id: existing.accountId },
        data: { currentBalance: { increment: oldBalanceReversal } }
      });

      // 3. If account changed, apply reversal was on old account, now apply new on new account
      const newAccountId = data.accountId || existing.accountId;
      const newType = data.type || existing.type;
      const newAmount = data.amount !== undefined ? Number(data.amount) : oldAmount;
      const newBalanceChange = newType === 'INCOME' ? newAmount : -newAmount;

      await tx.account.update({
        where: { id: newAccountId },
        data: { currentBalance: { increment: newBalanceChange } }
      });

      // 4. Update the transaction record
      const updated = await tx.transaction.update({
        where: { id },
        data: {
          ...(data.accountId && { accountId: data.accountId }),
          ...(data.categoryId !== undefined && { categoryId: data.categoryId || null }),
          ...(data.type && { type: data.type }),
          ...(data.amount !== undefined && { amount: data.amount }),
          ...(data.description !== undefined && { description: data.description || null }),
          ...(data.transactionDate && { transactionDate: new Date(data.transactionDate) }),
        },
        include: { category: true, account: true, items: true }
      });

      return updated;
    });
  }
}
