import { prisma } from '../../config/prisma';
import { SheetsService } from '../sheets/sheets.service';

export class BudgetService {
  static async getBudgets(messagingAccountId: string) {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();

    const budgets = await prisma.budget.findMany({
      where: { messagingAccountId, month: currentMonth, year: currentYear },
      include: { category: true }
    });

    const startDate = new Date(currentYear, currentMonth - 1, 1);
    const endDate = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

    const budgetsWithProgress = await Promise.all(
      budgets.map(async (b: any) => {
        const agg = await prisma.transaction.aggregate({
          where: {
            messagingAccountId,
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

  static async upsertBudget(messagingAccountId: string, data: { categoryId: string; limitAmount: number; month: number; year: number; notes?: string }) {
    const budget = await prisma.budget.upsert({
      where: {
        messagingAccountId_categoryId_month_year: {
          messagingAccountId,
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
        messagingAccountId,
        categoryId: data.categoryId,
        month: data.month,
        year: data.year,
        limitAmount: data.limitAmount,
        notes: data.notes
      }
    });

    SheetsService.triggerBudgetSync(messagingAccountId);

    return budget;
  }

  static async deleteBudget(id: string, messagingAccountId: string) {
    const result = await prisma.budget.deleteMany({
      where: { id, messagingAccountId }
    });
    if (result.count === 0) throw new Error("Budget not found");

    SheetsService.triggerBudgetSync(messagingAccountId);

    return result;
  }
}
