import type { RecordingSession } from "@recnrun/domain";
import { sampleSnapshot } from "@recnrun/domain/testing";
import type { DashboardData } from "@/dashboard/start";
import type { RecordingStore } from "@/views/recording";

/** Stands in for extension session storage; every view given the same store sees each write. */
export function memoryRecordingStore(): RecordingStore {
  let session: RecordingSession | null = null;
  const listeners = new Set<() => void>();
  return {
    read: async () => session,
    write: async (next) => {
      session = next;
      for (const listener of listeners) listener();
    },
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

/** The sample recordings and a fresh shared recording, for a dashboard under test. */
export function dashboardData(recordings = memoryRecordingStore()): DashboardData {
  return {
    loadSnapshot: async () => sampleSnapshot(),
    recordings,
    send: async () => ({ ok: true }),
  };
}
