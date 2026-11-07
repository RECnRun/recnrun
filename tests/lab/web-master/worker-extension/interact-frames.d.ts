// Types of interact-frames.js for the Node tests of frame records and mapping.
export interface Geometry {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
}
export interface SentFrame {
  frameSeq: number;
  bootId: string;
  sessionEpoch: number;
  loaderId: string;
  geometry: Geometry;
}
export interface Aimed {
  frameSeq: number;
  bootId: string;
  sessionEpoch: number;
  loaderId: string;
}
export declare const POINTER_KINDS: string[];
export declare function geometryOf(metadata: unknown): Geometry | null;
export declare function toCss(
  geometry: Geometry,
  x: number,
  y: number,
  zoom: number,
): { x: number; y: number };
export declare function mouseParams(
  event: Record<string, unknown>,
  entry: { geometry: Geometry },
  zoom: number,
): Record<string, unknown>;
export declare function createFrames(options?: {
  now?: () => number;
  limits?: { maxAgeMs: number; size: number };
}): {
  add(entry: SentFrame): void;
  check(event: Aimed, live: { loaderId: string; zoom: number }): string | null;
  clear(): void;
  get(frameSeq: number): (SentFrame & { sentAt: number }) | undefined;
  latest(): (SentFrame & { sentAt: number }) | null;
  size(): number;
};
