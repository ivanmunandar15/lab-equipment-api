import { env } from './config/env';
import { logger } from './config/logger';
import { disconnectDb } from './config/db';
import { createApp } from './app';
import { startJobs, stopJobs } from './jobs';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`API berjalan di http://localhost:${env.PORT} (docs: /api/docs)`);
  if (env.JOBS_ENABLED) startJobs();
});

async function shutdown(signal: string) {
  logger.info(`${signal} diterima, menutup server...`);
  stopJobs();
  server.close(async () => {
    await disconnectDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
