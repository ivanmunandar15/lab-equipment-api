import { logger } from '../../config/logger';

/** Jeda percobaan ulang: 1 menit, 5 menit, 30 menit (maks 3 kali ulang setelah percobaan pertama). */
export const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 30 * 60_000];

export type DeliverFn = (emailLogId: string) => Promise<{ ok: boolean }>;

/**
 * Antrean sederhana dalam memori (tanpa Redis). Pengiriman berurutan, retry dengan jeda bertambah.
 * Status tersimpan di EMAIL_LOG; saat startup, baris `queued` dimasukkan kembali (lihat recoverQueuedEmails).
 * Catatan: antrean ini per-proses. Jalankan job (JOBS_ENABLED=true) hanya di satu instance.
 */
class EmailQueue {
  private deliver: DeliverFn | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timers = new Set<NodeJS.Timeout>();
  private delays = DEFAULT_RETRY_DELAYS_MS;
  paused = false;
  /** Id yang masuk saat paused (dipakai test). */
  readonly held: string[] = [];

  setHandler(fn: DeliverFn) {
    this.deliver = fn;
  }

  configure(opts: { delays?: number[]; paused?: boolean }) {
    if (opts.delays) this.delays = opts.delays;
    if (opts.paused !== undefined) this.paused = opts.paused;
  }

  enqueue(emailLogId: string, retriesDone = 0): void {
    if (this.paused) {
      this.held.push(emailLogId);
      return;
    }
    this.chain = this.chain.then(() => this.run(emailLogId, retriesDone)).catch((err) => logger.error({ err }, 'antrean email error'));
  }

  private async run(id: string, retriesDone: number) {
    if (!this.deliver) return;
    const { ok } = await this.deliver(id);
    if (ok || retriesDone >= this.delays.length) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.enqueue(id, retriesDone + 1);
    }, this.delays[retriesDone]);
    t.unref();
    this.timers.add(t);
  }

  /** Tunggu antrean saat ini selesai (tidak menunggu timer retry). */
  idle(): Promise<unknown> {
    return this.chain;
  }

  reset() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.held.length = 0;
    this.paused = false;
    this.delays = DEFAULT_RETRY_DELAYS_MS;
    this.chain = Promise.resolve();
  }
}

export const emailQueue = new EmailQueue();
