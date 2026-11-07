// Types of visual-sender.js for the Node tests of the worker's visual.v1 sender.
export interface SenderStats {
  offered: number;
  sent: number;
  messages: number;
  maxBuffered: number;
  rejected: number;
  drops: Record<string, number>;
  buffered: number;
  links: number;
  lastError: string;
}

export declare function createSender(): {
  attach(channel: RTCDataChannel, pc: RTCPeerConnection): void;
  select(pc: RTCPeerConnection | undefined): void;
  clear(): void;
  relayed(frame: unknown): void;
  burst(count: number, padBytes: number): unknown;
  stats(): SenderStats;
};
