// Types of input-check.js for the Node tests of the link-bound start.
export interface LinkView {
  linkId: string;
  masterFingerprint: string;
  workerFingerprint: string;
}

export interface StartContext {
  masterKey: JsonWebKey;
  allowlist: string[];
  workerId: string;
  bootId: string;
  link: LinkView;
}

export declare function createStartCheck(options?: { now?: () => number }): {
  issue(linkId: string): string | null;
  check(message: unknown, context: StartContext): Promise<string | null>;
  forget(linkId: string): void;
  sizes(): { issued: number; spent: number };
};
