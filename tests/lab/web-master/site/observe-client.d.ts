// Types of observe-client.js for the Node tests of the master's observe requests.
export interface ObserveReply {
  ok: boolean;
  code?: string;
  requestId?: string | null;
}

export interface ObserveEvents {
  heartbeats: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  renewals: { ok: number; refused: Record<string, number> };
  restarts: { at: number; attempt?: number; gaveUp?: boolean }[];
}

export interface ObserveVisual {
  jobStatus(
    name: string,
    jobIds: string[],
  ): Promise<{ bootId: string; jobs: { targetId: number }[] }>;
  beginSession(name: string, session: Record<string, unknown>): void;
  acceptSession(name: string): void;
  renewed(name: string): void;
  endSession(name: string, reason?: string): void;
}

export declare const FINAL: Set<string>;
export declare function createObserve(options: {
  links: Map<
    string,
    { channel: EventTarget & { send(text: string): void }; proven?: { workerId: string } }
  >;
  visual: ObserveVisual;
  now?: () => number;
}): {
  observeStart(name: string, jobId: string, mode: string, workerId?: string): Promise<ObserveReply>;
  observeMode(name: string, mode: string): Promise<ObserveReply>;
  observeStop(name: string): Promise<ObserveReply>;
  observeEvents(name: string): ObserveEvents;
  observeSession(name: string): { sessionEpoch?: number } & Record<string, unknown>;
  observePending(): number;
};
