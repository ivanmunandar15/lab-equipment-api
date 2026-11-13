import { describe, expect, it } from 'vitest';
import { generateQrToken, isValidQrToken, QR_TOKEN_LENGTH } from '../src/utils/qr-token';

describe('qr-token', () => {
  it('selalu 12 karakter alfanumerik (tanpa "_" atau "-") agar diterima parser QR frontend', () => {
    for (let i = 0; i < 5000; i++) {
      const t = generateQrToken();
      expect(t).toHaveLength(QR_TOKEN_LENGTH);
      expect(t).toMatch(/^[A-Za-z0-9]{12}$/);
    }
  });

  it('isValidQrToken menolak token berformat lama', () => {
    expect(isValidQrToken('abcDEF123456')).toBe(true);
    expect(isValidQrToken('abc_EF123456')).toBe(false);
    expect(isValidQrToken('abc-EF123456')).toBe(false);
    expect(isValidQrToken('short')).toBe(false);
  });
});
