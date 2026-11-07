// Types of admission.js for the Node tests of the master's frame admission.
export interface AdmittedHead {
  bootId: string;
  jobId: string;
  targetId: number;
  sessionEpoch: number;
}

export interface Admission {
  request(
    name: string,
    session: { bootId: string; jobId: string; targetId: number; sessionEpoch: number },
  ): void;
  accept<T extends AdmittedHead>(name: string, show: (frame: T) => void): void;
  renewed(name: string): void;
  revoke(name: string, reason: string): void;
  check(name: string, head: AdmittedHead): string | null;
  offer<T extends AdmittedHead>(name: string, frame: T, show: (frame: T) => void): boolean;
  stats(): { revoked: Record<string, number> };
}

export declare function createAdmission(options?: {
  now?: () => number;
  leaseMs?: number;
  grantMs?: number;
}): Admission;
