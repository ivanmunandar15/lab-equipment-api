import type { ItemCondition, SupportingStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Status diturunkan (tidak pernah diinput):
 *   condition = major_damage → damaged
 *   available_quantity = 0   → borrowed
 *   selain itu               → available
 * Modul peminjaman (tahap berikutnya) WAJIB memakai fungsi ini setiap kali available_quantity berubah.
 */
export function deriveSupportingStatus(condition: ItemCondition, availableQuantity: number): SupportingStatus {
  if (condition === 'major_damage') return 'damaged';
  return availableQuantity <= 0 ? 'borrowed' : 'available';
}

/** Invarian: 0 <= available_quantity <= total_quantity. */
export function assertQuantities(total: number, available: number): void {
  if (!Number.isInteger(total) || !Number.isInteger(available) || available < 0 || available > total) {
    throw new AppError(409, 'INVALID_QUANTITY', 'available_quantity harus berada di antara 0 dan total_quantity', {
      total_quantity: total,
      available_quantity: available,
    });
  }
}
