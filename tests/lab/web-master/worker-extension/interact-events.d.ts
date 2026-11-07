// Types of interact-events.js for the Node tests of one checked input event.
import type { createFrames } from "./interact-frames.js";

export interface Live {
  loaderId: string | null;
  url: string;
  zoom: number;
  allowed: boolean;
  layout?: { width: number; height: number; scale: number } | null;
}
export interface TabOps {
  liveDocument(fresh: boolean): Promise<Live | null>;
  mouse(params: Record<string, unknown>): Promise<unknown>;
  key(params: Record<string, unknown>): Promise<unknown>;
  insertText(text: string): Promise<unknown>;
  holding(): boolean;
  releaseHeld(reason: string): Promise<boolean>;
}
export type Reply = { ok: boolean; code?: string; leaseId?: string; seq?: number };
export declare function createEvents(deps: {
  frames: ReturnType<typeof createFrames>;
  refuse(code: string, extra?: Record<string, unknown>): Reply;
  revoke(reason: string): unknown;
  serial<T>(work: () => Promise<T>): Promise<T>;
  stats: { holds: number; dispatched: number };
  tab: TabOps;
  authorized(leaseId: string): boolean;
}): (message: Record<string, unknown>) => Promise<Reply>;
