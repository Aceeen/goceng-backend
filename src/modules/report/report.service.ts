import { prisma } from '../../config/prisma';
import { BudgetService } from '../budget/budget.service';

export class ReportService {
  static async getReportData(userId: string, month: number, year: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59, 999);

    // 1. Transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        deletedAt: null,
        transactionDate: { gte: startDate, lte: endDate }
      },
      orderBy: { transactionDate: 'desc' },
      include: { category: true, account: true }
    });

    let totalIncome = 0;
    let totalExpense = 0;
    const categoryAgg: Record<string, { name: string, icon: string, amount: number, count: number }> = {};

    const formattedTransactions = transactions.map(tx => {
      const amount = Number(tx.amount);
      if (tx.type === 'INCOME') totalIncome += amount;
      if (tx.type === 'EXPENSE') {
        totalExpense += amount;
        if (tx.category) {
          const catId = tx.categoryId!;
          if (!categoryAgg[catId]) categoryAgg[catId] = { name: tx.category.name, icon: tx.category.icon || '', amount: 0, count: 0 };
          categoryAgg[catId].amount += amount;
          categoryAgg[catId].count += 1;
        }
      }

      const d = tx.transactionDate;
      return {
        date: `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth()+1).toString().padStart(2, '0')}/${d.getFullYear()}`,
        description: tx.description || tx.merchantName || 'Transaksi',
        category: tx.category?.name || 'Lainnya',
        amount,
        type: tx.type,
        account: tx.account.name
      };
    });

    const netBalance = totalIncome - totalExpense;

    const byCategory = Object.values(categoryAgg).map(cat => ({
      name: cat.name,
      icon: cat.icon,
      total: cat.amount,
      percentage: totalExpense > 0 ? Number(((cat.amount / totalExpense) * 100).toFixed(1)) : 0,
      transactionCount: cat.count
    })).sort((a, b) => b.total - a.total);

    // 2. Accounts
    const accounts = await prisma.account.findMany({
      where: { userId, isActive: true }
    });
    const formattedAccounts = accounts.map(a => ({
      name: a.name, type: a.type, closingBalance: Number(a.currentBalance)
    }));

    // 3. Budgets
    // We modify getBudgets slightly to accept month and year, but for now we manually fetch
    const budgets = await prisma.budget.findMany({
      where: { userId, month, year },
      include: { category: true }
    });
    
    // Quick realized check for budgets in that specific month
    const formattedBudgets = budgets.map(b => {
      const catId = b.categoryId;
      const realized = categoryAgg[catId]?.amount || 0;
      const limit = Number(b.limitAmount);
      let status = 'ON_TRACK';
      const percentage = limit > 0 ? (realized/limit)*100 : 0;
      if (percentage >= 100) status = 'OVER_BUDGET';
      else if (percentage >= 80) status = 'WARNING';
      
      return {
        category: b.category.name,
        limit,
        realized,
        status
      };
    });

    return {
      meta: {
        userName: user.name,
        period: `${month.toString().padStart(2, '0')}/${year}`,
        generatedAt: new Date().toISOString()
      },
      summary: { totalIncome, totalExpense, netBalance },
      accounts: formattedAccounts,
      byCategory,
      transactions: formattedTransactions,
      budgets: formattedBudgets
    };
  }
}
