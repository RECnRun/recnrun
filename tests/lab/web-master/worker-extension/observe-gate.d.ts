// Types of observe-gate.js for the Node tests of the worker's frame caps.
export interface GateFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
  frameSeq: number;
}

export interface Caps {
  thumbnail: { fps: number; maxWidth: number; maxHeight: number };
  live: { fps: number; maxWidth: number; maxHeight: number };
  interact: { fps: number; maxWidth: number; maxHeight: number };
  bytesPerSecond: number;
  frameBytes: number;
}

export interface Gate {
  offer(frame: GateFrame): void;
  setMode(mode: "thumbnail" | "live" | "interact" | null): void;
  clear(): void;
  stats(): { sent: number; bytes: number; drops: Record<string, number>; pending: boolean };
}

export declare const CAPS: Caps;
export declare function createGate(options: {
  send: (frame: GateFrame) => unknown;
  now?: () => number;
  caps?: Caps;
  valid?: (frame: GateFrame) => boolean;
}): Gate;
