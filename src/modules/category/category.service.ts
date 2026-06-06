import { CategoryType } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { SheetsService } from '../sheets/sheets.service';

export class CategoryService {
  static async getAllCategories(messagingAccountId?: string) {
    if (messagingAccountId) {
      return prisma.category.findMany({
        where: {
          OR: [
            { isSystem: true },
            { messagingAccountId }
          ]
        },
        orderBy: [
          { type: 'asc' },
          { name: 'asc' }
        ]
      });
    }

    return prisma.category.findMany({
      orderBy: [
        { type: 'asc' },
        { name: 'asc' }
      ]
    });
  }

  static async createCategory(messagingAccountId: string, data: { name: string; type: CategoryType; icon?: string; color?: string; keywords?: string[] }) {
    const existing = await prisma.category.findFirst({
      where: {
        name: { equals: data.name, mode: 'insensitive' },
        OR: [
          { isSystem: true },
          { messagingAccountId }
        ]
      }
    });

    if (existing) {
      throw new Error('Kategori dengan nama tersebut sudah ada');
    }

    return prisma.category.create({
      data: {
        name: data.name,
        type: data.type,
        icon: data.icon,
        color: data.color,
        keywords: data.keywords || [],
        isSystem: false,
        messagingAccountId
      }
    });
  }

  static async updateCategory(id: string, messagingAccountId: string, data: { name?: string; type?: CategoryType; icon?: string; color?: string; keywords?: string[] }) {
    const category = await prisma.category.findUnique({
      where: { id }
    });

    if (!category) {
      throw new Error('Kategori tidak ditemukan');
    }

    if (category.isSystem) {
      throw new Error('Kategori sistem tidak dapat diubah');
    }

    if (category.messagingAccountId !== messagingAccountId) {
      throw new Error('Kategori tidak ditemukan');
    }

    if (data.name) {
      const existing = await prisma.category.findFirst({
        where: {
          id: { not: id },
          name: { equals: data.name, mode: 'insensitive' },
          OR: [
            { isSystem: true },
            { messagingAccountId }
          ]
        }
      });

      if (existing) {
        throw new Error('Kategori dengan nama tersebut sudah ada');
      }
    }

    const updated = await prisma.category.update({
      where: { id, messagingAccountId },
      data
    });

    SheetsService.triggerBudgetSync(messagingAccountId);

    return updated;
  }

  static async deleteCategory(id: string, messagingAccountId: string) {
    const category = await prisma.category.findUnique({
      where: { id }
    });

    if (!category) {
      throw new Error('Kategori tidak ditemukan');
    }

    if (category.isSystem) {
      throw new Error('Kategori sistem tidak dapat dihapus');
    }

    if (category.messagingAccountId !== messagingAccountId) {
      throw new Error('Kategori tidak ditemukan');
    }

    const deleted = await prisma.category.delete({
      where: { id, messagingAccountId }
    });

    SheetsService.triggerBudgetSync(messagingAccountId);

    return deleted;
  }
}
