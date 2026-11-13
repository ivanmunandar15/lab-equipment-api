import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://lab:lab_password@localhost:5432/lab_test?schema=public',
      JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-123',
      JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-123',
      CORS_ORIGIN: 'http://localhost:3001',
      APP_URL: 'http://localhost:3001',
      UPLOAD_DIR: './uploads-test',
      LOG_LEVEL: 'silent',
    },
  },
});
