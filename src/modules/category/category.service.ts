import { prisma } from '../../config/prisma';

export class CategoryService {
  static async getAllCategories(messagingAccountId?: string) {
    if (messagingAccountId) {
      return prisma.category.findMany({
        where: {
          OR: [
            { isSystem: true },
            {
              transactions: {
                some: {
                  messagingAccountId
                }
              }
            }
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
}
