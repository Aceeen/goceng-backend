import { TransactionType } from '@prisma/client';
import { prisma } from '../../config/prisma';

export class TransactionService {
  static async getTransactionsByUserId(userId: string, filters: any) {
    const { page = 1, limit = 20, startDate, endDate, categoryId, accountId, type, search } = filters;
    const skip = (page - 1) * limit;

    const where: any = { userId, deletedAt: null };
    
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

  static async createTransaction(userId: string, data: any) {
    return prisma.$transaction(async (tx) => {
      // 1. Create the Transaction & Items
      const transaction = await tx.transaction.create({
        data: {
          userId,
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

  static async deleteTransaction(id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id, userId }
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
}
