import { prisma } from '../../config/prisma';
import { BudgetService } from '../budget/budget.service';

const formatDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (date: Date, amount: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export class DashboardService {
  private static calculateGamification(transactionDates: Date[]) {
    const uniqueDates = new Set(transactionDates.map((date) => formatDateKey(date)));
    const today = startOfDay(new Date());
    const yesterday = addDays(today, -1);
    const hasLoggedToday = uniqueDates.has(formatDateKey(today));

    let currentStreak = 0;
    let cursor: Date | null = null;

    if (hasLoggedToday) {
      cursor = today;
    } else if (uniqueDates.has(formatDateKey(yesterday))) {
      cursor = yesterday;
    }

    while (cursor && uniqueDates.has(formatDateKey(cursor))) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }

    const totalTransactions = transactionDates.length;
    const level = Math.max(1, Math.floor(totalTransactions / 10) + 1);

    return {
      currentStreak,
      hasLoggedToday,
      level,
      totalTransactions,
    };
  }

  static async getSummary(userId: string) {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();
    const startOfMonth = new Date(currentYear, currentMonth - 1, 1);
    const endOfMonth = new Date(currentYear, currentMonth, 0, 23, 59, 59, 999);
    const startOfPreviousMonth = new Date(currentYear, currentMonth - 2, 1);
    const endOfPreviousMonth = new Date(currentYear, currentMonth - 1, 0, 23, 59, 59, 999);

    const [
      accounts,
      currentMonthTxs,
      previousMonthTxs,
      recentTransactions,
      allTransactionDates,
      budgets,
    ] = await Promise.all([
      prisma.account.findMany({
        where: { userId, isActive: true },
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          deletedAt: null,
          transactionDate: { gte: startOfMonth, lte: endOfMonth },
        },
        include: { category: true },
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          deletedAt: null,
          transactionDate: { gte: startOfPreviousMonth, lte: endOfPreviousMonth },
        },
        select: {
          amount: true,
          type: true,
        },
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          deletedAt: null,
        },
        take: 5,
        orderBy: { transactionDate: 'desc' },
        include: { category: true },
      }),
      prisma.transaction.findMany({
        where: {
          userId,
          deletedAt: null,
        },
        orderBy: { transactionDate: 'desc' },
        select: {
          transactionDate: true,
        },
      }),
      BudgetService.getBudgets(userId),
    ]);

    let totalBalance = 0;
    const formattedAccounts = accounts.map((account) => {
      const balance = Number(account.currentBalance);
      totalBalance += balance;
      return {
        id: account.id,
        name: account.name,
        type: account.type,
        currentBalance: balance,
      };
    });

    let monthlyIncome = 0;
    let monthlyExpense = 0;
    let previousMonthlyIncome = 0;
    let previousMonthlyExpense = 0;

    const categoryTotals: Record<string, { name: string; icon: string; amount: number }> = {};
    const weeks: Record<number, { income: number; expense: number }> = {
      1: { income: 0, expense: 0 },
      2: { income: 0, expense: 0 },
      3: { income: 0, expense: 0 },
      4: { income: 0, expense: 0 },
    };

    currentMonthTxs.forEach((tx) => {
      const amount = Number(tx.amount);
      const week = Math.ceil(tx.transactionDate.getDate() / 7);
      const safeWeek = week > 4 ? 4 : week;

      if (tx.type === 'INCOME') {
        monthlyIncome += amount;
        weeks[safeWeek].income += amount;
      } else if (tx.type === 'EXPENSE') {
        monthlyExpense += amount;
        weeks[safeWeek].expense += amount;

        if (tx.category) {
          const categoryId = tx.categoryId!;
          if (!categoryTotals[categoryId]) {
            categoryTotals[categoryId] = {
              name: tx.category.name,
              icon: tx.category.icon || '',
              amount: 0,
            };
          }
          categoryTotals[categoryId].amount += amount;
        }
      }
    });

    previousMonthTxs.forEach((tx) => {
      const amount = Number(tx.amount);
      if (tx.type === 'INCOME') previousMonthlyIncome += amount;
      if (tx.type === 'EXPENSE') previousMonthlyExpense += amount;
    });

    const spendingByCategory = Object.keys(categoryTotals)
      .map((categoryId) => ({
        categoryId,
        name: categoryTotals[categoryId].name,
        icon: categoryTotals[categoryId].icon,
        amount: categoryTotals[categoryId].amount,
        percentage: monthlyExpense > 0
          ? Number(((categoryTotals[categoryId].amount / monthlyExpense) * 100).toFixed(1))
          : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const cashFlowByWeek = [1, 2, 3, 4].map((week) => ({
      week,
      income: weeks[week].income,
      expense: weeks[week].expense,
    }));

    const budgetHighlights = budgets.map((budget) => ({
      categoryName: budget.category.name,
      percentage: budget.percentage,
      status: budget.status,
    }));

    const normalizedRecentTransactions = recentTransactions.map((tx) => ({
      id: tx.id,
      title: tx.description || tx.merchantName || tx.category?.name || 'Transaksi',
      date: tx.transactionDate.toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
      amount: Number(tx.amount),
      type: tx.type === 'INCOME' ? 'income' : tx.type === 'EXPENSE' ? 'expense' : 'transfer',
      icon: tx.category?.icon || null,
    }));

    const gamification = this.calculateGamification(
      allTransactionDates.map((transaction) => transaction.transactionDate)
    );

    return {
      totalBalance,
      monthlyIncome,
      monthlyExpense,
      previousMonthlyIncome,
      previousMonthlyExpense,
      accounts: formattedAccounts,
      spendingByCategory,
      cashFlowByWeek,
      budgetHighlights,
      recentTransactions: normalizedRecentTransactions,
      gamification,
    };
  }

  static async getCashflow(userId: string) {
    const summary = await this.getSummary(userId);
    return summary.cashFlowByWeek;
  }
}
