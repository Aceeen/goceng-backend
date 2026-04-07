import { prisma } from '../../config/prisma';

export class CategoryService {
  static async getAllCategories() {
    return prisma.category.findMany({
      orderBy: [
        { type: 'asc' },
        { name: 'asc' }
      ]
    });
  }
}
