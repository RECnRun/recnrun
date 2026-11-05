import * as v from "valibot";
import { TokenSchema } from "@/p2p/downloads-rendezvous";
import { BasesDirSchema, ClonesSchema } from "@/p2p/prepare";
import type { PrepareStatus } from "@/p2p/prepare";
import { SettingSchema } from "@/p2p/poc-setting";

/*
 * The state machine of "Prepare workers" (POC P6.1). The launcher owns progress (status.json); this
 * reducer only folds what the page reads, and decides "done" itself: the launcher's done counts
 * only once every listed clone is in the registry with the boot its ack carried.
 */

export const OperationSchema = v.strictObject({
  operationId: TokenSchema,
  basesDir: BasesDirSchema,
  baseName: SettingSchema,
  clones: ClonesSchema,
});
export type Operation = v.InferOutput<typeof OperationSchema>;

export interface OnboardingState {
  operation?: Operation;
  status?: PrepareStatus;
  /** Boot of each profile the launcher's registry lists. */
  peers: Record<string, string>;
  /** Retry was asked and the launcher has not answered with a newer status. */
  retried: boolean;
}

export type OnboardingEvent =
  | { type: "requested"; operation: Operation }
  | { type: "status"; status: PrepareStatus }
  | { type: "registry"; peers: Record<string, { boot: string }> }
  | { type: "retry" };

export const INITIAL: OnboardingState = { peers: {}, retried: false };

function onStatus(state: OnboardingState, next: PrepareStatus): OnboardingState {
  const { operation, status } = state;
  if (operation?.operationId !== next.operationId) return state;
  if (status && next.updatedAt < status.updatedAt) return state;
  // The launcher's clock ticks in seconds, so a retry answered within one may share updatedAt.
  const resumed = state.retried && next.state !== "error";
  if (status && next.updatedAt === status.updatedAt && !resumed) return state;
  return { ...state, status: next, retried: false };
}

export function reduce(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  switch (event.type) {
    case "requested":
      return { operation: event.operation, peers: state.peers, retried: false };
    case "status":
      return onStatus(state, event.status);
    case "registry": {
      const peers = Object.entries(event.peers).map(([id, peer]) => [id, peer.boot]);
      return { ...state, peers: Object.fromEntries(peers) };
    }
    case "retry":
      return state.status?.state === "error" && !state.retried
        ? { ...state, retried: true }
        : state;
  }
}

export type Phase =
  | "idle"
  | "requested"
  | "running"
  | "pending-action"
  | "error"
  | "retrying"
  | "done";

interface CloneRow {
  name: string;
  instanceId: string;
  acked: boolean;
  /** Acked, and the registry lists it with the boot of its ack. */
  linked: boolean;
}

export interface OnboardingView {
  phase: Phase;
  step: string;
  message: string;
  clones: CloneRow[];
}

function phaseOf(state: OnboardingState, rows: CloneRow[]): Phase {
  const { operation, status } = state;
  if (!operation) return "idle";
  if (!status) return "requested";
  if (status.state === "error") return state.retried ? "retrying" : "error";
  if (status.state === "pending-action") return "pending-action";
  const complete = rows.length === operation.clones && rows.every((row) => row.linked);
  return status.state === "done" && complete ? "done" : "running";
}

export function view(state: OnboardingState): OnboardingView {
  const rows = (state.status?.clones ?? []).map((clone) => ({
    name: clone.name,
    instanceId: clone.instanceId,
    acked: clone.acked,
    linked: clone.acked && clone.boot !== "" && state.peers[clone.instanceId] === clone.boot,
  }));
  return {
    phase: phaseOf(state, rows),
    step: state.status?.step ?? "",
    message: state.status?.message ?? "",
    clones: rows,
  };
}
