// Types of owner-launch.js for the Node tests of the owner page's launch wait.
import type { FolderHandle } from "./owner-files.js";

export interface WaitContext {
  root: FolderHandle;
  say: (text: string) => unknown;
  waitMs?: number;
}
export type Waited = { ok: true; answer: unknown } | { ok: false; code: string };
export declare const awaitAnswer: (
  context: WaitContext,
  ids: { attempt: string; request: string },
) => Promise<Waited>;
export declare const pinWorker: (root: FolderHandle) => Promise<{ pin: string; spki?: Uint8Array }>;
export declare const launch: (context: Record<string, unknown>) => Promise<unknown>;
export declare const LINK: string;
