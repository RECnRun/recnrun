// Types of interact-held.js for the Node tests of the pressed state.
export interface Command {
  method: string;
  params: Record<string, unknown>;
}
export declare function createHeld(): {
  track(method: string, params: Record<string, unknown>): void;
  releases(): Command[];
  any(): boolean;
  clear(): void;
  size(): number;
};
