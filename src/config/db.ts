import type { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

/**
 * Lazy singleton: PrismaClient baru dibuat saat pertama dipakai,
 * sehingga app (dan test /health) tetap jalan tanpa `prisma generate`.
 */
export function getDb(): PrismaClient {
  if (!client) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) await client.$disconnect();
}
