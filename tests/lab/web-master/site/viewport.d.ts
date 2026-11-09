// Types of viewport.js for the Node tests of the master's viewport match.
export interface Size {
  width: number;
  height: number;
}
export interface Viewport {
  observe: (size: Size) => void;
  now: () => Promise<void>;
  reset: () => void;
  effective: () => Size | null;
  accepts: (frame: { viewportSeq?: number }) => boolean;
}
export declare const createViewport: (options: {
  send: (size: Size) => Promise<unknown>;
  delay?: number;
  setTimer?: (run: () => void, delay: number) => unknown;
  clearTimer?: (id: never) => void;
}) => Viewport;
export declare const sessionViewport: (
  session: { lease?: unknown; seq: number; viewport?: Viewport },
  leaseMessage: (session: never, type: string, extra: Size) => Promise<object>,
) => Viewport;
export declare const watchSize: (viewport: Viewport, element: Element) => () => void;
