import { EventEmitter } from 'node:events';

export interface ReadingEvent {
  sensor_id: string;
  sensor_code: string;
  room_id: string;
  sensor_type: string;
  unit: string;
  value: number;
  measurement_time: string;
  received_at: string;
  threshold_state: 'below_min' | 'above_max' | 'normal';
  out_of_range: boolean;
}

/** Bus in-process untuk SSE. Untuk multi-instance, ganti dengan Redis pub/sub / LISTEN-NOTIFY. */
export const monitoringBus = new EventEmitter();
monitoringBus.setMaxListeners(0);

export const publishReading = (e: ReadingEvent) => monitoringBus.emit('reading', e);
