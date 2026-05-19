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
        currencyCode: true,
        createdAt: true,
        messagingAccounts: {
          select: {
            id: true,
            platform: true,
            externalId: true,
            spreadsheetId: true,
            googleDriveFolderId: true,
            createdAt: true,
          }
        }
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
        currencyCode: data.currencyCode,
      },
      select: {
        id: true,
        email: true,
        name: true,
        profilePicture: true,
        currencyCode: true,
        createdAt: true,
        messagingAccounts: true
      }
    });
  }
}
