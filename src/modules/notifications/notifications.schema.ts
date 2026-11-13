import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
export const NOTIFICATION_TYPES = ['borrowing', 'calibration', 'maintenance', 'monitoring', 'system'] as const;

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

export const listNotificationsQuery = paginationQuerySchema.extend({
  is_read: boolQuery.optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
});

export const readAllBody = z.object({ type: z.enum(NOTIFICATION_TYPES).optional() }).default({});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;
