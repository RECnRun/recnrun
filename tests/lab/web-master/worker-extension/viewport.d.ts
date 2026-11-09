// Types of viewport.js for the Node tests.
export interface ViewportBounds {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}
export interface Size {
  maxWidth: number;
  maxHeight: number;
}
export declare const VIEWPORT_BOUNDS: ViewportBounds;
export declare function clampViewport(
  requested: { width: unknown; height: unknown },
  bounds?: ViewportBounds,
): { width: number; height: number } | "INPUT_INVALID";
export declare function createViewport(): {
  current(): { width: number; height: number; seq: number };
  size(mode: string, base: Size): Size;
  apply(effective: { width: number; height: number }, seq: number): void;
  reset(): void;
};
export declare const viewport: ReturnType<typeof createViewport>;
