import { prisma } from '../../config/prisma';
import { ExpenseFrequency } from '@prisma/client';

export interface CreateRoutineDTO {
  userId: string;
  accountId: string;
  categoryId?: string;
  title: string;
  amount: number;
  frequency: ExpenseFrequency;
  startDate: string;
  endDate?: string;
}

export interface UpdateRoutineDTO {
  accountId?: string;
  categoryId?: string;
  title?: string;
  amount?: number;
  frequency?: ExpenseFrequency;
  startDate?: string;
  endDate?: string;
  isActive?: boolean;
}

export class RoutineService {
  /**
   * Retrieves all routine expenses for a given user.
   */
  static async getUserRoutines(userId: string) {
    return prisma.routineExpense.findMany({
      where: { userId },
      include: {
        account: true,
        category: true,
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Creates a new routine expense.
   */
  static async createRoutine(data: CreateRoutineDTO) {
    return prisma.routineExpense.create({
      data: {
        userId: data.userId,
        accountId: data.accountId,
        categoryId: data.categoryId,
        title: data.title,
        amount: data.amount,
        frequency: data.frequency,
        startDate: new Date(data.startDate),
        endDate: data.endDate ? new Date(data.endDate) : null,
      }
    });
  }

  /**
   * Updates an existing routine expense.
   */
  static async updateRoutine(id: string, userId: string, data: UpdateRoutineDTO) {
    // Verify ownership
    const routine = await prisma.routineExpense.findFirst({
      where: { id, userId }
    });

    if (!routine) {
      throw new Error('Routine expense not found or unauthorized');
    }

    return prisma.routineExpense.update({
      where: { id },
      data: {
        accountId: data.accountId,
        categoryId: data.categoryId,
        title: data.title,
        amount: data.amount,
        frequency: data.frequency,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate !== undefined ? (data.endDate ? new Date(data.endDate) : null) : undefined,
        isActive: data.isActive,
      }
    });
  }

  /**
   * Deletes a routine expense.
   */
  static async deleteRoutine(id: string, userId: string) {
    const routine = await prisma.routineExpense.findFirst({
      where: { id, userId }
    });

    if (!routine) {
      throw new Error('Routine expense not found or unauthorized');
    }

    return prisma.routineExpense.delete({
      where: { id }
    });
  }
}
