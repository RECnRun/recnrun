import { OriginDataSchema } from "@recnrun/domain";
import * as v from "valibot";

/** The name of the port the origin agent opens to the background. */
export const ORIGIN_AGENT_PORT = "recnrun-origin-agent";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Every command and reply names its operation, so a late one from an older operation is dropped. */
const OPERATION = {
  operationId: v.pipe(v.string(), v.nonEmpty()),
  generation: CountSchema,
};

/** The background asks the agent to restore one origin's data into its page. */
export const OriginRestoreCommandSchema = v.object({
  type: v.literal("restore"),
  ...OPERATION,
  payload: OriginDataSchema,
});

const RestoredCountsSchema = v.object({
  localStorage: CountSchema,
  sessionStorage: CountSchema,
  databases: CountSchema,
  records: CountSchema,
});

export type RestoredCounts = v.InferOutput<typeof RestoredCountsSchema>;

/** The agent's answer: counts, or a failed step and an error name, never a stored value. */
export const OriginReplySchema = v.variant("type", [
  v.object({ type: v.literal("restored"), ...OPERATION, counts: RestoredCountsSchema }),
  v.object({
    type: v.literal("failed"),
    ...OPERATION,
    error: v.pipe(v.string(), v.maxLength(200)),
  }),
]);

export type OriginReply = v.InferOutput<typeof OriginReplySchema>;

/** Who opened a port, as Chrome reports it to the background. */
export interface OriginSender {
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
  origin?: string;
}

interface PortEvent<A extends unknown[]> {
  addListener: (listener: (...args: A) => void) => void;
  removeListener: (listener: (...args: A) => void) => void;
}

/** The part of a `runtime.Port` the agent and the background use. */
export interface OriginPort {
  name: string;
  sender?: OriginSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: PortEvent<[unknown]>;
  onDisconnect: PortEvent<[]>;
}
