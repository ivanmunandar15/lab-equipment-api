import type { Request, Response } from 'express';
import { AppError } from '../../utils/errors';
import { monitoringBus, type ReadingEvent } from './monitoring.events';
import type { StreamQuery } from './monitoring.schema';

const MAX_PER_USER = 5;
const HEARTBEAT_MS = 25_000;
/** Access token hanya 15 menit; stream ditutup sebelum itu agar klien reconnect dengan token baru. */
const MAX_LIFETIME_MS = 14 * 60_000;
const open = new Map<string, number>();

/** SSE. Klien harus memakai fetch-streaming (mis. @microsoft/fetch-event-source) karena butuh header Authorization. */
export function stream(req: Request, res: Response) {
  const userId = req.user!.user_id;
  if ((open.get(userId) ?? 0) >= MAX_PER_USER) {
    throw new AppError(429, 'TOO_MANY_CONNECTIONS', `Maksimal ${MAX_PER_USER} koneksi stream per user`);
  }
  open.set(userId, (open.get(userId) ?? 0) + 1);

  const q = req.query as unknown as StreamQuery;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ server_time: new Date().toISOString() })}\n\n`);

  const onReading = (e: ReadingEvent) => {
    if (q.room_id && e.room_id !== q.room_id) return;
    if (q.sensor_id && e.sensor_id !== q.sensor_id) return;
    res.write(`event: reading\ndata: ${JSON.stringify(e)}\n\n`);
  };
  monitoringBus.on('reading', onReading);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const expire = setTimeout(() => {
    res.write('event: reconnect\ndata: {}\n\n');
    res.end();
  }, MAX_LIFETIME_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    clearTimeout(expire);
    monitoringBus.off('reading', onReading);
    const n = (open.get(userId) ?? 1) - 1;
    if (n <= 0) open.delete(userId);
    else open.set(userId, n);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}
