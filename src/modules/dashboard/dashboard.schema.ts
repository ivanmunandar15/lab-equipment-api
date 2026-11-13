import { z } from 'zod';

export const alertsQuery = z.object({
  /** Maks item per kategori alert (jumlah total tetap dihitung penuh). */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AlertsQuery = z.infer<typeof alertsQuery>;
