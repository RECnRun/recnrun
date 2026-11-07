// Types of observe-check.js for the Node tests of the observe control.
export interface CheckContext {
  masterKey: JsonWebKey;
  workerId: string;
  bootId: string;
  job: { jobId: string; targetId: number } | null;
  finished(jobId: string): Promise<boolean>;
  session: { sessionEpoch: number } | null;
  highestEpoch: number;
}

export interface ObserveCheck {
  check(message: unknown, context: CheckContext): Promise<string | null>;
  sizes(): { recent: number; seen: number };
}

export declare function createObserveCheck(options?: {
  now?: () => number;
  rate?: { max: number; windowMs: number };
}): ObserveCheck;
