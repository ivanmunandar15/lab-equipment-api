export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Permintaan tidak valid', details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Autentikasi diperlukan', details?: unknown) {
    return new AppError(401, 'UNAUTHORIZED', message, details);
  }
  static forbidden(message = 'Akses ditolak', details?: unknown) {
    return new AppError(403, 'FORBIDDEN', message, details);
  }
  static notFound(message = 'Data tidak ditemukan', details?: unknown) {
    return new AppError(404, 'NOT_FOUND', message, details);
  }
  static conflict(message = 'Data konflik', details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
  static unprocessable(message = 'Validasi gagal', details?: unknown) {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }
  static internal(message = 'Terjadi kesalahan pada server', details?: unknown) {
    return new AppError(500, 'INTERNAL_ERROR', message, details);
  }
}
