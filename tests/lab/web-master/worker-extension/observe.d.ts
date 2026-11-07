// Types of observe.js for the Node tests of the worker's observe session.
export interface ObserveReply {
  ok: boolean;
  code?: string;
  requestId: string | null;
  status?: Record<string, unknown>;
}

export declare function observe(request: unknown, linkId: string): Promise<ObserveReply>;
export declare const observeLab: {
  stats(): { highestEpoch: number; session: Record<string, unknown> | null } & Record<
    string,
    unknown
  >;
  limit(overrides: Record<string, number>): Record<string, number>;
};
