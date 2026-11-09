// Types of retry.js for the Node tests of the start retry.
export interface Refusal {
  ok: boolean;
  code?: string;
}
export declare const RETRYABLE: string[];
export declare const retrying: <T extends Refusal>(
  attempt: () => Promise<T>,
  options?: { delays?: number[]; sleep?: (ms: number) => Promise<unknown> },
) => Promise<T>;
