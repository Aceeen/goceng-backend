// src/modules/session/session.service.ts

import { prisma } from '../../config/prisma';

const SESSION_EXPIRY_MINUTES = 15;

/**
 * Buat session baru saat AI berhasil ekstrak data.
 * Status awal PENDING — menunggu konfirmasi user.
 */
export async function createSession(
  userId: string,
  extractedData: object,
  rawPayload: object,
  waMessageId?: string
) {
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000);

  return prisma.transactionSession.create({
    data: {
      userId,
      waMessageId: waMessageId ?? null,
      status:      'PENDING',   // valid: ini create, bukan update
      extractedData,
      rawPayload,
      expiresAt,
    },
  });
}

/**
 * Ambil session PENDING milik user yang belum expired.
 * Dipakai saat user balas tombol interaktif.
 */
export async function getPendingSession(userId: string) {
  return prisma.transactionSession.findFirst({
    where: {
      userId,
      status:    'PENDING',
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Update status session setelah user konfirmasi/edit/batal.
 * FIX: Tipe status hanya nilai yang valid untuk UPDATE (bukan PENDING).
 */
export async function updateSessionStatus(
  sessionId: string,
  status: 'CONFIRMED' | 'EDITED' | 'CANCELLED' | 'SAVED' | 'FAILED',
  updatedData?: object
) {
  return prisma.transactionSession.update({
    where: { id: sessionId },
    data: {
      status,
      ...(updatedData ? { extractedData: updatedData } : {}),
    },
  });
}

/**
 * Kembalikan session EDITED ke PENDING setelah koreksi diterapkan.
 * Fungsi terpisah agar tipe lebih eksplisit.
 */
export async function resetSessionToPending(
  sessionId: string,
  updatedData: object
) {
  return prisma.transactionSession.update({
    where: { id: sessionId },
    data: {
      status:        'PENDING',
      extractedData: updatedData,
    },
  });
}