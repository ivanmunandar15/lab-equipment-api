/** Pencocokan aturan penanggung jawab (murni, tanpa database). */

export interface ResponsibilityRule {
  user_id: string;
  code_prefix: string | null;
  room_id: string | null;
}

export interface EquipmentRef {
  inventory_code: string;
  room_id?: string | null;
}

/** Spasi berulang dirapikan, tanpa spasi ujung, tidak membedakan huruf besar/kecil. */
export const normalizeCode = (s: string): string => s.replace(/\s+/g, ' ').trim().toUpperCase();

const isAlnum = (ch: string | undefined): boolean => !!ch && /[A-Z0-9]/.test(ch);

/**
 * Apakah kode inventaris berawalan `prefix` pada batas yang wajar?
 * "INV L-ACT 10" cocok dengan "INV L-ACT 10-01" dan "INV L-ACT 10-01.01", tetapi TIDAK dengan "INV L-ACT 100-1"
 * (karakter sesudah awalan tidak boleh huruf/angka). Awalan yang berakhir tanda baca ("INV L-ACT 10-") cocok langsung.
 */
export function codeMatchesPrefix(code: string, prefix: string): boolean {
  const c = normalizeCode(code);
  const p = normalizeCode(prefix);
  if (!p || !c.startsWith(p)) return false;
  if (c.length === p.length) return true;
  if (!isAlnum(p[p.length - 1])) return true;
  return !isAlnum(c[p.length]);
}

/** Aturan cocok bila SEMUA kriteria yang terisi cocok. Aturan tanpa kriteria tidak pernah cocok. */
export function ruleMatches(rule: ResponsibilityRule, eq: EquipmentRef): boolean {
  if (!rule.code_prefix && !rule.room_id) return false;
  if (rule.code_prefix && !codeMatchesPrefix(eq.inventory_code, rule.code_prefix)) return false;
  if (rule.room_id && rule.room_id !== (eq.room_id ?? null)) return false;
  return true;
}

/** user_id unik dari semua aturan yang cocok dengan alat. */
export function responsibleUserIds(rules: ResponsibilityRule[], eq: EquipmentRef): string[] {
  const ids = new Set<string>();
  for (const r of rules) if (ruleMatches(r, eq)) ids.add(r.user_id);
  return [...ids];
}
