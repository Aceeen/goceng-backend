import { prisma } from '../../config/prisma';

export class BudgetService {
  static async getBudgets(userId: string) {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();

    const budgets = await prisma.budget.findMany({
      where: { userId, month: currentMonth, year: currentYear },
      include: { category: true }
    });

    const startDate = new Date(currentYear, currentMonth - 1, 1);
    const endDate = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

    const budgetsWithProgress = await Promise.all(
      budgets.map(async (b) => {
        const agg = await prisma.transaction.aggregate({
          where: {
            userId,
            categoryId: b.categoryId,
            type: 'EXPENSE',
            deletedAt: null,
            transactionDate: { gte: startDate, lte: endDate }
          },
          _sum: { amount: true }
        });

        const realized = Number(agg._sum.amount || 0);
        const limit = Number(b.limitAmount);
        const percentage = limit > 0 ? (realized / limit) * 100 : 0;
        
        let status = 'ON_TRACK';
        if (percentage >= 100) status = 'OVER_BUDGET';
        else if (percentage >= 80) status = 'WARNING';

        return {
          id: b.id,
          category: {
            id: b.category.id,
            name: b.category.name,
            icon: b.category.icon
          },
          limitAmount: limit,
          notes: b.notes,
          month: b.month,
          year: b.year,
          realized,
          percentage: Number(percentage.toFixed(1)),
          status,
          remaining: limit - realized
        };
      })
    );

    return budgetsWithProgress;
  }

  static async upsertBudget(userId: string, data: { categoryId: string; limitAmount: number; month: number; year: number; notes?: string }) {
    return prisma.budget.upsert({
      where: {
        userId_categoryId_month_year: {
          userId,
          categoryId: data.categoryId,
          month: data.month,
          year: data.year
        }
      },
      update: {
        limitAmount: data.limitAmount,
        notes: data.notes
      },
      create: {
        userId,
        categoryId: data.categoryId,
        month: data.month,
        year: data.year,
        limitAmount: data.limitAmount,
        notes: data.notes
      }
    });
  }

  static async deleteBudget(id: string, userId: string) {
    const result = await prisma.budget.deleteMany({
      where: { id, userId }
    });
    if (result.count === 0) throw new Error("Budget not found");
    return result;
  }
}
