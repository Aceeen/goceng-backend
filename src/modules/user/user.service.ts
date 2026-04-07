import { prisma } from '../../config/prisma';

export class UserService {
  static async getUserProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        profilePicture: true,
        whatsappNumber: true,
        spreadsheetId: true,
        currencyCode: true,
        isOnboarded: true,
        createdAt: true
      }
    });

    if (!user) throw new Error('User not found');
    return user;
  }

  static async updateUserProfile(userId: string, data: any) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        whatsappNumber: data.whatsappNumber,
        currencyCode: data.currencyCode,
        isOnboarded: data.isOnboarded
      },
      select: {
        id: true,
        email: true,
        name: true,
        profilePicture: true,
        whatsappNumber: true,
        spreadsheetId: true,
        currencyCode: true,
        isOnboarded: true,
        createdAt: true
      }
    });
  }
}
