import { prisma } from '../../config/prisma';
import { BudgetService } from '../budget/budget.service';

export class DashboardService {
  static async getSummary(userId: string) {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();
    const startOfMonth = new Date(currentYear, currentMonth - 1, 1);
    const endOfMonth = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);

    // 1. Total Balance & Accounts
    const accounts = await prisma.account.findMany({
      where: { userId, isActive: true },
    });
    
    let totalBalance = 0;
    const formattedAccounts = accounts.map(a => {
      const balance = Number(a.currentBalance);
      totalBalance += balance;
      return { id: a.id, name: a.name, type: a.type, currentBalance: balance };
    });

    // 2. Transactions this month for Income, Expense, and Category splitting
    const currentMonthTxs = await prisma.transaction.findMany({
      where: {
        userId,
        deletedAt: null,
        transactionDate: { gte: startOfMonth, lte: endOfMonth }
      },
      include: { category: true }
    });

    let monthlyIncome = 0;
    let monthlyExpense = 0;
    const categoryTotals: Record<string, { name: string, icon: string, amount: number }> = {};
    const weeks: Record<number, { income: number, expense: number }> = { 
      1: { income: 0, expense: 0 }, 
      2: { income: 0, expense: 0 }, 
      3: { income: 0, expense: 0 }, 
      4: { income: 0, expense: 0 }
    };

    currentMonthTxs.forEach(tx => {
      const amount = Number(tx.amount);
      const week = Math.ceil(tx.transactionDate.getDate() / 7);
      const safeWeek = week > 4 ? 4 : week; // Dump 29-31st into week 4

      if (tx.type === 'INCOME') {
        monthlyIncome += amount;
        weeks[safeWeek].income += amount;
      } else if (tx.type === 'EXPENSE') {
        monthlyExpense += amount;
        weeks[safeWeek].expense += amount;

        if (tx.category) {
          const catId = tx.categoryId!;
          if (!categoryTotals[catId]) {
            categoryTotals[catId] = { name: tx.category.name, icon: tx.category.icon || '', amount: 0 };
          }
          categoryTotals[catId].amount += amount;
        }
      }
    });

    const spendingByCategory = Object.keys(categoryTotals).map(catId => ({
      categoryId: catId,
      name: categoryTotals[catId].name,
      icon: categoryTotals[catId].icon,
      amount: categoryTotals[catId].amount,
      percentage: monthlyExpense > 0 ? Number(((categoryTotals[catId].amount / monthlyExpense) * 100).toFixed(1)) : 0
    })).sort((a,b) => b.amount - a.amount);

    const cashFlowByWeek = [1, 2, 3, 4].map(w => ({
      week: w,
      income: weeks[w].income,
      expense: weeks[w].expense
    }));

    // 3. Budgets Highlights
    const budgets = await BudgetService.getBudgets(userId);
    const budgetHighlights = budgets.map(b => ({
      categoryName: b.category.name,
      percentage: b.percentage,
      status: b.status
    }));

    return {
      totalBalance,
      monthlyIncome,
      monthlyExpense,
      accounts: formattedAccounts,
      spendingByCategory,
      cashFlowByWeek,
      budgetHighlights
    };
  }

  static async getCashflow(userId: string) {
    const summary = await this.getSummary(userId);
    return summary.cashFlowByWeek;
  }
}
