import type { Request, RequestHandler } from 'express';
import { AUDIT_ACTIONS, audit } from '../modules/activity-logs/audit.service';

export interface AuditRouteOptions {
  entityType: string;
  action: string;
  /** Muat data sebelum diubah (untuk old_data). Dipanggil sebelum controller. */
  loadOld?: (req: Request) => Promise<unknown>;
  /** Field primary key pada data respons (default `<entityType>_id`). Dipakai jika route tanpa :id. */
  idField?: string;
}

/**
 * Mencatat activity log otomatis untuk route yang berhasil (2xx).
 * old_data = hasil loadOld, new_data = `data` pada respons sukses.
 * Pasang SETELAH authenticate/authorize/validate dan SEBELUM controller.
 * Log ditulis sebelum respons dikirim, jadi sudah ada saat client menerima respons.
 */
export const auditRoute =
  (opts: AuditRouteOptions): RequestHandler =>
  (req, res, next) => {
    (async () => {
      const oldData = opts.loadOld ? await opts.loadOld(req) : undefined;
      const idField = opts.idField ?? `${opts.entityType}_id`;
      const sendJson = res.json.bind(res);

      res.json = (body?: unknown) => {
        const b = body as { success?: boolean; data?: Record<string, unknown> } | undefined;
        if (res.statusCode >= 200 && res.statusCode < 300 && b?.success) {
          const fromBody = b.data && typeof b.data === 'object' ? b.data[idField] : undefined;
          const entityId = req.params?.id ?? (typeof fromBody === 'string' ? fromBody : null);
          void audit
            .log({
              ...audit.actorFrom(req),
              action: opts.action,
              entityType: opts.entityType,
              entityId,
              oldData,
              newData: b.data,
            })
            .finally(() => sendJson(body));
          return res;
        }
        return sendJson(body);
      };
      next();
    })().catch(next);
  };

type Extra = Pick<AuditRouteOptions, 'idField'>;

export const auditCreate = (entityType: string, o: Extra = {}) =>
  auditRoute({ entityType, action: AUDIT_ACTIONS.CREATE, ...o });

export const auditUpdate = (entityType: string, loadOld: AuditRouteOptions['loadOld'], o: Extra = {}) =>
  auditRoute({ entityType, action: AUDIT_ACTIONS.UPDATE, loadOld, ...o });

/** Untuk soft delete: old_data = sebelum nonaktif, new_data = respons (is_active=false). */
export const auditDelete = (entityType: string, loadOld: AuditRouteOptions['loadOld'], o: Extra = {}) =>
  auditRoute({ entityType, action: AUDIT_ACTIONS.DELETE, loadOld, ...o });

/** Untuk endpoint export (CSV/ZIP/PDF): log ditulis setelah respons selesai terkirim (streaming). */
export const auditExport =
  (entityType: string): RequestHandler =>
  (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      void audit.log({
        ...audit.actorFrom(req),
        action: AUDIT_ACTIONS.EXPORT,
        entityType,
        newData: { path: req.originalUrl.split('?')[0], query: req.query },
      });
    });
    next();
  };
