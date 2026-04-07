import { AccountType } from '@prisma/client';
import { prisma } from '../../config/prisma';

export class AccountService {
  static async getAccountsByUserId(userId: string) {
    return prisma.account.findMany({
      where: { userId, isActive: true },
    });
  }

  static async createAccount(userId: string, data: { name: string; type: AccountType; initialBalance: number; color?: string; icon?: string }) {
    return prisma.account.create({
      data: {
        userId,
        name: data.name,
        type: data.type,
        initialBalance: data.initialBalance,
        currentBalance: data.initialBalance,
        color: data.color,
        icon: data.icon,
      }
    });
  }

  static async updateAccount(id: string, userId: string, data: { name?: string; color?: string; icon?: string }) {
    return prisma.account.update({
      where: { id, userId },
      data,
    });
  }

  static async deleteAccount(id: string, userId: string) {
    return prisma.account.update({
      where: { id, userId },
      data: { isActive: false },
    });
  }
}
