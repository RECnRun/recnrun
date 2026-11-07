// Types of interact-lease.js for the Node tests of the interaction lease.
export interface Lease {
  leaseId: string;
  interactId: string;
  linkId: string;
  url: string;
  seq: number;
  until: number;
}

export type Ended = Lease & { reason: string };

export interface Refusal {
  code: string;
  reason?: string;
  ended?: Ended;
}

export declare function createLeases(options?: { now?: () => number; leaseMs?: number }): {
  open(fields: { linkId: string; interactId: string; url: string }): Lease;
  admit(message: { leaseId: string; seq: number }, linkId: string): Refusal | null;
  renew(): void;
  revoke(reason: string): Ended | null;
  expired(): boolean;
  current(): Lease | null;
};
