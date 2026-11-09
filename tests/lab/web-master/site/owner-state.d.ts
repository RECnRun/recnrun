// Types of owner-state.js for the Node tests of the owner page's banner reducer.
import type { Heartbeat } from "./heartbeat.js";
export interface OwnerState {
  handle: boolean;
  permission: "granted" | "prompt" | "denied";
  folder: "ok" | "missing";
  marker: "ok" | "missing" | "invalid";
  heartbeat: Heartbeat | null;
  stale: boolean;
  masterFp: string | null;
  workerMismatch: boolean;
  reconnect: boolean;
}
export interface Banner {
  id: string;
  text: string;
  action?: string;
  command?: string;
  fingerprints?: { master: string };
  busy?: string;
  reconnect?: boolean;
}
export declare const START_COMMAND: string;
export declare const banner: (state: OwnerState) => Banner;
export declare const display: (fp: string) => string;
