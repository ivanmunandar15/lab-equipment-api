import type { MaintenanceStatus } from '@prisma/client';

/** scheduled → in_progress → completed; cancelled dari scheduled / in_progress. completed & cancelled bersifat final. */
export const TRANSITIONS: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const isFinal = (s: MaintenanceStatus) => TRANSITIONS[s].length === 0;
export const canTransition = (from: MaintenanceStatus, to: MaintenanceStatus) => TRANSITIONS[from].includes(to);
