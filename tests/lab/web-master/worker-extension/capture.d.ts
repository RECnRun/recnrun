// Types of capture.js for the Node tests of the worker's capture.
export interface CaptureFrame {
  data: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  source: string;
  capturedAtMs: number;
  frameSeq: number;
  epoch: number;
  generation: number;
  url: string;
  bootId: string;
  jobId: string | null;
  tabId: number;
  metadata: Record<string, number> | null;
}

export declare const MODES: Record<
  "thumbnail" | "live" | "interact",
  { maxWidth: number; maxHeight: number }
>;
export declare function bind(target: { tabId: number }, jobId: string): void;
export declare function unbind(target: { tabId: number }): void;
export declare function start(options: { mode: string }): Promise<{ ok: boolean; error?: string }>;
export declare function stop(): Promise<{ ok: boolean }>;
export declare function setSink(sink: ((frame: CaptureFrame) => Promise<unknown>) | null): void;
export declare function setHooks(hooks: Record<string, (...args: unknown[]) => void>): void;
export declare function captureStats(): Record<string, unknown>;
export declare function bootId(): string;
export declare function lastFrame(): CaptureFrame | null;
export declare function boundTarget(): { tabId: number } | null;
export declare function isCurrent(frame: CaptureFrame): boolean;
