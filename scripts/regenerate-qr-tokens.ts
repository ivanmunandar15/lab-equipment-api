/**
 * Membuat ulang qr_token yang tidak sesuai format frontend ([A-Za-z0-9]{12}),
 * mis. token lama dari nanoid bawaan yang mengandung `_` atau `-`.
 *
 * PERHATIAN: label QR yang sudah tercetak untuk item yang token-nya diganti tidak berlaku lagi
 * dan harus dicetak ulang. Jalankan `npm run db:fix-qr -- --dry-run` dulu untuk melihat jumlahnya.
 */
import { PrismaClient } from '@prisma/client';
import { generateQrToken, isValidQrToken } from '../src/utils/qr-token';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const [eq, sp] = await Promise.all([
    prisma.equipment.findMany({ select: { equipment_id: true, inventory_code: true, qr_token: true } }),
    prisma.supportingEquipment.findMany({ select: { supporting_equipment_id: true, item_code: true, qr_token: true } }),
  ]);
  const used = new Set<string>([...eq.map((r) => r.qr_token), ...sp.map((r) => r.qr_token)]);
  const fresh = () => {
    let t = generateQrToken();
    while (used.has(t)) t = generateQrToken();
    used.add(t);
    return t;
  };

  const badEq = eq.filter((r) => !isValidQrToken(r.qr_token));
  const badSp = sp.filter((r) => !isValidQrToken(r.qr_token));
  console.log(`Alat: ${badEq.length}/${eq.length} token tidak valid | Alat pendukung: ${badSp.length}/${sp.length} token tidak valid`);
  if (dryRun) return console.log('--dry-run: tidak ada perubahan.');

  for (const r of badEq) {
    const qr_token = fresh();
    await prisma.equipment.update({ where: { equipment_id: r.equipment_id }, data: { qr_token } });
    console.log(`equipment ${r.inventory_code}: ${r.qr_token} -> ${qr_token}`);
  }
  for (const r of badSp) {
    const qr_token = fresh();
    await prisma.supportingEquipment.update({ where: { supporting_equipment_id: r.supporting_equipment_id }, data: { qr_token } });
    console.log(`supporting ${r.item_code}: ${r.qr_token} -> ${qr_token}`);
  }
  console.log('Selesai. Cetak ulang label QR untuk item di atas.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
