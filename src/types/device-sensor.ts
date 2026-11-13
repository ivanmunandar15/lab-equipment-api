import type { SensorStatus, SensorType } from '@prisma/client';

export interface DeviceSensor {
  sensor_id: string;
  sensor_code: string;
  room_id: string;
  sensor_type: SensorType;
  unit: string;
  sensor_status: SensorStatus;
  min_threshold: number;
  max_threshold: number;
  room: { room_code: string; room_name: string; person_in_charge: string | null };
}
