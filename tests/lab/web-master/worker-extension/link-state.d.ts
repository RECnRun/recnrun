// Types of link-state.js for the Node tests of the file-signalled link.
export type LinkStateName = "unlinked" | "connecting" | "linked" | "recovering";

export interface LinkChange {
  state: LinkStateName;
  attempt: string | null;
  at: number;
}

export declare const RECOVER_MS: number;
export declare const CONNECT_MS: number;

export interface LinkState {
  state(): LinkStateName;
  attempt(): string | null;
  begin(attempt: string): boolean;
  opened(attempt: string): void;
  closed(attempt: string): void;
  lost(attempt: string): void;
}

export declare function createLinkState(deps: {
  onChange: (change: LinkChange) => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): LinkState;
