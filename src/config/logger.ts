import pino from 'pino';
import { env, isProd } from './env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  transport: isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty' },
});
