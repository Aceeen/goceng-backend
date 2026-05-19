import { AccountType } from '@prisma/client';
import { prisma } from '../../config/prisma';

export class AccountService {
  static async getAccountsByMessagingAccountId(messagingAccountId: string) {
    return prisma.account.findMany({
      where: { messagingAccountId, isActive: true },
    });
  }

  static async createAccount(messagingAccountId: string, data: { name: string; type: AccountType; initialBalance: number; color?: string; icon?: string }) {
    return prisma.account.create({
      data: {
        messagingAccountId,
        name: data.name,
        type: data.type,
        initialBalance: data.initialBalance,
        currentBalance: data.initialBalance,
        color: data.color,
        icon: data.icon,
      }
    });
  }

  static async updateAccount(id: string, messagingAccountId: string, data: { name?: string; color?: string; icon?: string }) {
    return prisma.account.update({
      where: { id, messagingAccountId },
      data,
    });
  }

  static async deleteAccount(id: string, messagingAccountId: string) {
    return prisma.account.update({
      where: { id, messagingAccountId },
      data: { isActive: false },
    });
  }
}
