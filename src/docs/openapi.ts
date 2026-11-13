import { activityLogsPaths, activityLogsSchemas, activityLogsTags } from './activity-logs.docs';
import { roomsEquipmentPaths, roomsEquipmentSchemas, roomsEquipmentTags } from './rooms-equipment.docs';
import { supportingEquipmentPaths, supportingEquipmentSchemas, supportingEquipmentTags } from './supporting-equipment.docs';
import { borrowingsPaths, borrowingsSchemas, borrowingsTags } from './borrowings.docs';
import { calibrationsMaintenancesPaths, calibrationsMaintenancesSchemas, calibrationsMaintenancesTags } from './calibrations-maintenances.docs';
import { monitoringDocumentsPaths, monitoringDocumentsSchemas, monitoringDocumentsTags } from './monitoring-documents.docs';
import { dashboardPaths, dashboardSchemas, dashboardTags } from './dashboard.docs';
import { emailPaths, emailSchemas, emailTags } from './email.docs';
import { authUsersPaths, authUsersSchemas, authUsersTags } from './auth-users.docs';

// OpenAPI ditulis manual; tiap tahap menambah `paths` modul barunya.
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Laboratory Equipment Management API',
    version: '0.1.0',
    description: 'REST API manajemen peralatan laboratorium.',
  },
  servers: [{ url: '/api/v1' }],
  tags: [{ name: 'Health' }, ...authUsersTags, ...roomsEquipmentTags, ...supportingEquipmentTags, ...borrowingsTags, ...calibrationsMaintenancesTags, ...activityLogsTags, ...monitoringDocumentsTags, ...dashboardTags, ...emailTags],
  paths: {
    ...authUsersPaths,
    ...roomsEquipmentPaths,
    ...supportingEquipmentPaths,
    ...borrowingsPaths,
    ...calibrationsMaintenancesPaths,
    ...activityLogsPaths,
    ...monitoringDocumentsPaths,
    ...dashboardPaths,
    ...emailPaths,
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Cek status layanan',
        responses: {
          '200': {
            description: 'Layanan berjalan',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        status: { type: 'string', example: 'ok' },
                        uptime: { type: 'number', example: 12.34 },
                        timestamp: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '429': errorResponse('Terlalu banyak permintaan'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      sensorKey: { type: 'apiKey', in: 'header', name: 'X-Sensor-Key' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
    },
    schemas: {
      ...authUsersSchemas,
      ...roomsEquipmentSchemas,
      ...supportingEquipmentSchemas,
      ...borrowingsSchemas,
      ...calibrationsMaintenancesSchemas,
      ...activityLogsSchemas,
      ...monitoringDocumentsSchemas,
      ...dashboardSchemas,
      ...emailSchemas,
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: {},
            },
          },
        },
      },
      PageMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
    },
  },
};
