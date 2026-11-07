// Types of visual-receiver.js for the Node tests of the receiver.
export interface Limits {
  messageBytes: number;
  frameBytes: number;
  chunks: number;
  ttlMs: number;
  workers: number;
}

export interface Head {
  version: number;
  codec: number;
  workerId: string;
  bootId: string;
  jobId: string;
  targetId: number;
  epoch: number;
  frameSeq: number;
  chunkIndex: number;
  chunkCount: number;
  frameBytes: number;
  width: number;
  height: number;
  capturedAtMs: number;
}

export interface Frame extends Head {
  bytes: Uint8Array;
}

export interface Receiver {
  accept(data: unknown): string;
  sweep(): void;
  stats(): { frames: number; drops: Record<string, number> };
}

export declare const LIMITS: Limits;
export declare function parse(
  data: unknown,
  limits?: Limits,
): string | { head: Head; payload: Uint8Array };
export declare function createReceiver(options: {
  onFrame: (frame: Frame) => void;
  now?: () => number;
  limits?: Limits;
}): Receiver;
