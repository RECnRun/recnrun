// Types of visual-envelope.js for the Node tests of the envelope.
export interface FrameMeta {
  workerId: string;
  bootId: string;
  jobId: string;
  targetId: number;
  epoch: number;
  frameSeq: number;
  width: number;
  height: number;
  capturedAtMs: number;
}

export declare const HEADER_BYTES: number;
export declare const MESSAGE_MAX: number;
export declare function encodeFrame(
  meta: FrameMeta,
  bytes: Uint8Array,
  messageMax?: number,
): ArrayBuffer[];
