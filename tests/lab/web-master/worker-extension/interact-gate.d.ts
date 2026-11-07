// Types of interact-gate.js for the Node tests of the input queue.
export interface GateOptions {
  now?: () => number;
  depth?: number;
  ageMs?: number;
  rate?: number;
  onOverload?: (code: string) => void;
}
export declare function createGate(options?: GateOptions): {
  serial<T>(work: () => Promise<T>, skipped: (code: string) => T): Promise<T>;
  chain<T>(work: () => Promise<T>): Promise<T>;
  size(): number;
};
export declare function within<T>(work: Promise<T>, ms: number, code: string): Promise<T>;
