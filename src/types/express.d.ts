import type { AuthUser } from './auth-user';
import type { DeviceSensor } from './device-sensor';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Diisi oleh authenticateDevice (X-Sensor-Key). */
      sensor?: DeviceSensor;
    }
  }
}

export {};
