import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';

export const DOCUMENT_TYPES = ['manual', 'certificate', 'procedure', 'photo', 'other'] as const;

export const idParams = z.object({ id: z.string().uuid('ID tidak valid') });

export const listDocumentsQuery = paginationQuerySchema.extend({
  equipment_id: z.string().uuid().optional(),
  document_type: z.enum(DOCUMENT_TYPES).optional(),
  uploaded_by: z.string().uuid().optional(),
});

export const createDocumentBody = z.object({
  equipment_id: z.string().uuid('equipment_id tidak valid'),
  document_type: z.enum(DOCUMENT_TYPES),
});

export const downloadQuery = z.object({
  inline: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuery>;
export type CreateDocumentBody = z.infer<typeof createDocumentBody>;
