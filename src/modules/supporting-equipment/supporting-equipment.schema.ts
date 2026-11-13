import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';
import { CONDITIONS, equipmentFields, idParams, idsParam, optText, qrQuery } from '../equipment/equipment.schema';

export { idParams, qrQuery };

/** Status disimpan di DB tetapi DITURUNKAN server (lihat supporting-equipment.derive.ts); bukan input. */
export const SUPPORTING_STATUSES = ['available', 'borrowed', 'damaged'] as const;

const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

export const supportingFields = {
  item_code: equipmentFields.inventory_code,
  item_name: z.string().trim().min(2, 'minimal 2 karakter').max(150),
  unit: z.string().trim().min(1, 'wajib diisi').max(20),
  total_quantity: z.number({ invalid_type_error: 'harus berupa angka' }).int('harus bilangan bulat').min(1, 'minimal 1').max(1_000_000),
  condition: z.enum(CONDITIONS),
};

// `qr_token`, `available_quantity`, `status` tidak ada di skema → otomatis dibuang (diabaikan).
export const createSupportingBody = z.object({
  item_code: supportingFields.item_code,
  item_name: supportingFields.item_name,
  item_type: optText(100),
  brand: optText(100),
  model: optText(100),
  unit: supportingFields.unit.default('pcs'),
  total_quantity: supportingFields.total_quantity,
  condition: supportingFields.condition.default('good'),
  description: optText(2000),
  specifications: optText(5000),
});

export const updateSupportingBody = createSupportingBody
  .partial()
  .extend({
    unit: supportingFields.unit.optional(),
    condition: supportingFields.condition.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Minimal satu field harus diisi' });

const filterShape = {
  status: z.enum(SUPPORTING_STATUSES).optional(),
  condition: z.enum(CONDITIONS).optional(),
  item_type: z.string().trim().min(1).optional(),
  is_active: boolQuery.optional(),
};

export const listSupportingQuery = paginationQuerySchema.extend(filterShape);

export const exportSupportingQuery = z.object({
  ...filterShape,
  search: z.string().trim().min(1).optional(),
  ids: idsParam.optional(),
});

export const labelsSupportingQuery = z.object({
  ids: idsParam,
  layout: z.enum(['a4-3x8', 'sticker-50x30']).default('a4-3x8'),
});

export type ListSupportingQuery = z.infer<typeof listSupportingQuery>;
export type ExportSupportingQuery = z.infer<typeof exportSupportingQuery>;
export type CreateSupportingBody = z.infer<typeof createSupportingBody>;
export type UpdateSupportingBody = z.infer<typeof updateSupportingBody>;
