// Types of interact-keys.js for the Node tests of the key table, text, and wheel.
import type { Geometry } from "./interact-frames.js";

export declare function keyParams(event: Record<string, unknown>): Record<string, unknown> | null;
export declare function textFits(text: string): boolean;
export declare function wheelParams(
  event: Record<string, unknown>,
  entry: { geometry: Geometry },
  zoom: number,
): Record<string, unknown>;
