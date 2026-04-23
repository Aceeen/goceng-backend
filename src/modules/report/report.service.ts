import { prisma } from '../../config/prisma';

const WEEKDAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
type WeekdayKey = typeof WEEKDAY_ORDER[number];

const weekdayByJsDay: WeekdayKey[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export class ReportService {
  static async getReportData(userId: string, month: number, year: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        deletedAt: null,
        transactionDate: { gte: startDate, lte: endDate },
      },
      orderBy: { transactionDate: 'desc' },
      include: { category: true, account: true },
    });

    let totalIncome = 0;
    let totalExpense = 0;
    const categoryAgg: Record<string, { name: string; icon: string; amount: number; count: number }> = {};
    const weeklyOverview: Record<WeekdayKey, { income: number; expense: number }> = {
      MON: { income: 0, expense: 0 },
      TUE: { income: 0, expense: 0 },
      WED: { income: 0, expense: 0 },
      THU: { income: 0, expense: 0 },
      FRI: { income: 0, expense: 0 },
      SAT: { income: 0, expense: 0 },
      SUN: { income: 0, expense: 0 },
    };

    const formattedTransactions = transactions.map((tx) => {
      const amount = Number(tx.amount);
      const weekday = weekdayByJsDay[tx.transactionDate.getDay()];

      if (tx.type === 'INCOME') {
        totalIncome += amount;
        weeklyOverview[weekday].income += amount;
      }

      if (tx.type === 'EXPENSE') {
        totalExpense += amount;
        weeklyOverview[weekday].expense += amount;

        if (tx.category) {
          const categoryId = tx.categoryId!;
          if (!categoryAgg[categoryId]) {
            categoryAgg[categoryId] = {
              name: tx.category.name,
              icon: tx.category.icon || '',
              amount: 0,
              count: 0,
            };
          }
          categoryAgg[categoryId].amount += amount;
          categoryAgg[categoryId].count += 1;
        }
      }

      const transactionDate = tx.transactionDate;
      return {
        date: `${transactionDate.getDate().toString().padStart(2, '0')}/${(transactionDate.getMonth() + 1).toString().padStart(2, '0')}/${transactionDate.getFullYear()}`,
        description: tx.description || tx.merchantName || 'Transaksi',
        category: tx.category?.name || 'Lainnya',
        amount,
        type: tx.type,
        account: tx.account.name,
        transactionDate: tx.transactionDate.toISOString(),
      };
    });

    const netBalance = totalIncome - totalExpense;

    const byCategory = Object.values(categoryAgg)
      .map((category) => ({
        name: category.name,
        icon: category.icon,
        total: category.amount,
        percentage: totalExpense > 0 ? Number(((category.amount / totalExpense) * 100).toFixed(1)) : 0,
        transactionCount: category.count,
      }))
      .sort((a, b) => b.total - a.total);

    const accounts = await prisma.account.findMany({
      where: { userId, isActive: true },
    });

    const formattedAccounts = accounts.map((account) => ({
      name: account.name,
      type: account.type,
      closingBalance: Number(account.currentBalance),
    }));

    const budgets = await prisma.budget.findMany({
      where: { userId, month, year },
      include: { category: true },
    });

    const formattedBudgets = budgets.map((budget) => {
      const realized = categoryAgg[budget.categoryId]?.amount || 0;
      const limit = Number(budget.limitAmount);
      const percentage = limit > 0 ? (realized / limit) * 100 : 0;

      let status = 'ON_TRACK';
      if (percentage >= 100) status = 'OVER_BUDGET';
      else if (percentage >= 80) status = 'WARNING';

      return {
        category: budget.category.name,
        limit,
        realized,
        status,
      };
    });

    return {
      meta: {
        userName: user.name,
        period: `${month.toString().padStart(2, '0')}/${year}`,
        generatedAt: new Date().toISOString(),
      },
      summary: { totalIncome, totalExpense, netBalance },
      accounts: formattedAccounts,
      byCategory,
      weeklyOverview: WEEKDAY_ORDER.map((day) => ({
        day,
        income: weeklyOverview[day].income,
        expense: weeklyOverview[day].expense,
      })),
      transactions: formattedTransactions,
      budgets: formattedBudgets,
    };
  }
}
