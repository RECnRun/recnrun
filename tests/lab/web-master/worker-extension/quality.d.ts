// Types of quality.js for the Node tests.
export interface Quality {
  value(): number;
  observe(bytes: number): boolean;
  reset(): void;
}
export declare function createQuality(options: { budget: number; now?: () => number }): Quality;
export declare const interactQuality: Quality;
export declare function qualityFor(mode: string, fallback: number): number;
