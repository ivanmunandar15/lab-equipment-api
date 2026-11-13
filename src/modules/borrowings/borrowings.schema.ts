import { z } from 'zod';
import { paginationQuerySchema } from '../../utils/pagination';
import { CONDITIONS, dateOnlySchema, idParams, optText } from '../equipment/equipment.schema';

export { idParams };

const qrToken = z.string().trim().regex(/^[\w-]{1,64}$/, 'qr_token tidak valid');
const uuid = (name: string) => z.string().uuid(`${name} tidak valid`);

const exactlyOne = (key: string) => (v: Record<string, unknown>) => (v[key] !== undefined) !== (v.qr_token !== undefined);
const oneMsg = (key: string) => ({ message: `Isi salah satu: ${key} atau qr_token (tidak boleh keduanya)` });

const equipmentRef = z
  .object({ equipment_id: uuid('equipment_id').optional(), qr_token: qrToken.optional() })
  .refine(exactlyOne('equipment_id'), oneMsg('equipment_id'));

const supportingRef = z
  .object({
    supporting_equipment_id: uuid('supporting_equipment_id').optional(),
    qr_token: qrToken.optional(),
    quantity: z.number({ invalid_type_error: 'harus berupa angka' }).int('harus bilangan bulat').min(1, 'minimal 1').max(100_000),
  })
  .refine(exactlyOne('supporting_equipment_id'), oneMsg('supporting_equipment_id'));

export const createBorrowingBody = z
  .object({
    purpose: z.string().trim().min(3, 'minimal 3 karakter').max(500),
    usage_location: optText(200),
    expected_return_time: z
      .string()
      .datetime({ offset: true, message: 'Format harus ISO 8601, mis. 2026-11-02T09:00:00Z' })
      .transform((s) => new Date(s))
      .refine((d) => d.getTime() > Date.now(), 'harus di masa depan'),
    notes: optText(1000),
    equipment: z.array(equipmentRef).max(100).default([]),
    supporting: z.array(supportingRef).max(100).default([]),
  })
  .refine((v) => v.equipment.length + v.supporting.length > 0, {
    message: 'Minimal satu alat atau barang pendukung',
    path: ['equipment'],
  });

const finalCondition = z.enum(CONDITIONS);
const damageNotes = z.string().trim().max(1000).transform((v) => (v === '' ? null : v)).nullable().optional();
const consistent = (v: { has_damage: boolean; final_condition: string }) => !(v.has_damage && v.final_condition === 'good');
const consistentMsg = { message: 'has_damage = true tidak boleh dengan final_condition = good', path: ['final_condition'] };

const returnItem = z
  .object({
    detail_id: uuid('detail_id'),
    final_condition: finalCondition,
    has_damage: z.boolean().default(false),
    damage_notes: damageNotes,
  })
  .refine(consistent, consistentMsg);

const returnSupporting = z
  .object({
    supporting_detail_id: uuid('supporting_detail_id'),
    quantity_returned: z.number({ invalid_type_error: 'harus berupa angka' }).int('harus bilangan bulat').min(1, 'minimal 1').max(100_000),
    final_condition: finalCondition.default('good'),
    has_damage: z.boolean().default(false),
    damage_notes: damageNotes,
  })
  .refine(consistent, consistentMsg);

export const returnBorrowingBody = z
  .object({
    items: z.array(returnItem).max(100).default([]),
    supporting: z.array(returnSupporting).max(100).default([]),
  })
  .refine((v) => v.items.length + v.supporting.length > 0, { message: 'Minimal satu item dikembalikan', path: ['items'] });

export const reportDamageBody = z.object({
  notes: z.string().trim().min(3, 'minimal 3 karakter').max(2000),
  condition: z.enum(['minor_damage', 'major_damage']).default('major_damage'),
});

const listShape = {
  status: z.enum(['active', 'overdue', 'returned']).optional(),
  equipment_id: uuid('equipment_id').optional(),
  date_from: dateOnlySchema.optional(),
  date_to: dateOnlySchema.optional(),
};
const dateOrder = (v: { date_from?: Date; date_to?: Date }) => !v.date_from || !v.date_to || v.date_from <= v.date_to;
const dateOrderMsg = { message: 'date_from tidak boleh setelah date_to', path: ['date_from'] };

export const listBorrowingsQuery = paginationQuerySchema
  .extend({ ...listShape, user_id: uuid('user_id').optional() })
  .refine(dateOrder, dateOrderMsg);
export const myBorrowingsQuery = paginationQuerySchema.extend(listShape).refine(dateOrder, dateOrderMsg);

export const qrTokenParams = z.object({ qrToken: qrToken });

export type CreateBorrowingBody = z.infer<typeof createBorrowingBody>;
export type ReturnBorrowingBody = z.infer<typeof returnBorrowingBody>;
export type ReportDamageBody = z.infer<typeof reportDamageBody>;
export type ListBorrowingsQuery = z.infer<typeof listBorrowingsQuery>;
