// Types of heartbeat.js for the Node tests of the launcher heartbeat.
export interface Heartbeat {
  session: string;
  seq: number;
  at: number;
  state: string;
  paired: string;
  launcher: string;
  extension: string;
}
export interface Tracker {
  heartbeat: Heartbeat | null;
  session: string | null;
  seq: number | null;
  seqChangedAt: number;
  stale: boolean;
  sessionChanged: boolean;
}
export declare const parseHeartbeat: (text: string) => Heartbeat | null;
export declare const track: (previous: Tracker | null, text: string | null, now: number) => Tracker;
