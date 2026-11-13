const sec = [{ bearerAuth: [] }];
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const body = (schema: unknown) => ({ required: true, ...json(schema) });
const res = (description: string, data?: unknown) => ({
  description,
  ...(data ? json({ type: 'object', properties: { success: { type: 'boolean', example: true }, data } }) : {}),
});
const err = (description: string) => ({ description, ...json(ref('ErrorResponse')) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

export const authUsersTags = [{ name: 'Auth' }, { name: 'Users', description: 'Khusus admin' }];

export const authUsersSchemas = {
  User: {
    type: 'object',
    properties: {
      user_id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['QA', 'admin', 'technician', 'SPV'] },
      is_active: { type: 'boolean' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
  },
  TokenResponse: {
    type: 'object',
    properties: {
      access_token: { type: 'string' },
      token_type: { type: 'string', example: 'Bearer' },
      expires_in: { type: 'integer', example: 900 },
      user: ref('User'),
    },
  },
  ChangePasswordRequest: {
    type: 'object',
    required: ['current_password', 'new_password'],
    properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 8 } },
  },
  CreateUserRequest: {
    type: 'object',
    required: ['name', 'email', 'role'],
    properties: {
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['QA', 'admin', 'technician', 'SPV'] },
      password: { type: 'string', description: 'Opsional. Jika kosong, dibuat password sementara.' },
    },
  },
  UpdateUserRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      role: { type: 'string', enum: ['QA', 'admin', 'technician', 'SPV'] },
      is_active: { type: 'boolean' },
    },
  },
};

export const authUsersPaths = {
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login (set refresh token di cookie httpOnly)',
      requestBody: body(ref('LoginRequest')),
      responses: {
        '200': res('Berhasil', ref('TokenResponse')),
        '401': err('Email/password salah'),
        '403': err('Akun tidak aktif'),
        '422': err('Validasi gagal'),
        '429': err('Terlalu banyak percobaan'),
      },
    },
  },
  '/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Rotasi refresh token (membaca cookie refresh_token)',
      security: [{ refreshCookie: [] }],
      responses: { '200': res('Token baru', ref('TokenResponse')), '401': err('Refresh token tidak valid') },
    },
  },
  '/auth/logout': {
    post: { tags: ['Auth'], summary: 'Cabut refresh token', responses: { '200': res('Berhasil') } },
  },
  '/auth/me': {
    get: { tags: ['Auth'], summary: 'Profil saat ini', security: sec, responses: { '200': res('OK', ref('User')), '401': err('Tidak terautentikasi') } },
    patch: {
      tags: ['Auth'],
      summary: 'Ubah nama sendiri',
      security: sec,
      requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } }),
      responses: { '200': res('OK', ref('User')), '422': err('Validasi gagal') },
    },
  },
  '/auth/me/password': {
    patch: {
      tags: ['Auth'],
      summary: 'Ubah password sendiri (wajib password lama)',
      security: sec,
      requestBody: body(ref('ChangePasswordRequest')),
      responses: { '200': res('Berhasil'), '400': err('Password lama salah'), '422': err('Validasi gagal') },
    },
  },
  '/users': {
    get: {
      tags: ['Users'],
      summary: 'Daftar user',
      security: sec,
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 100 } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['name', 'email', 'role', 'is_active', 'created_at', 'updated_at'] } },
        { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
        { name: 'role', in: 'query', schema: { type: 'string', enum: ['QA', 'admin', 'technician', 'SPV'] } },
        { name: 'is_active', in: 'query', schema: { type: 'boolean' } },
      ],
      responses: { '200': res('OK', { type: 'array', items: ref('User') }), '403': err('Bukan admin') },
    },
    post: {
      tags: ['Users'],
      summary: 'Buat user (password opsional)',
      security: sec,
      requestBody: body(ref('CreateUserRequest')),
      responses: { '201': res('Dibuat; temporary_password ada jika password tidak diisi', ref('User')), '409': err('Email sudah terdaftar') },
    },
  },
  '/users/{id}': {
    get: { tags: ['Users'], summary: 'Detail user', security: sec, parameters: [idParam], responses: { '200': res('OK', ref('User')), '404': err('Tidak ditemukan') } },
    patch: {
      tags: ['Users'],
      summary: 'Ubah nama/role/status aktif',
      security: sec,
      parameters: [idParam],
      requestBody: body(ref('UpdateUserRequest')),
      responses: { '200': res('OK', ref('User')), '400': err('Menonaktifkan/mengubah role akun sendiri') },
    },
    delete: {
      tags: ['Users'],
      summary: 'Nonaktifkan user (soft delete)',
      security: sec,
      parameters: [idParam],
      responses: { '200': res('OK', ref('User')), '400': err('Menonaktifkan akun sendiri') },
    },
  },
  '/users/{id}/reset-password': {
    post: {
      tags: ['Users'],
      summary: 'Reset password (new_password opsional; jika kosong dibuat sementara)',
      security: sec,
      parameters: [idParam],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { new_password: { type: 'string' } } } } } },
      responses: { '200': res('Berhasil') },
    },
  },
};
