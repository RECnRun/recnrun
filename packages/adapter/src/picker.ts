import { DomTargetSchema, MAX_CAPTURED_TEXT, type DomTarget } from "@recnrun/protocol";
import * as v from "valibot";
import { openCdpChannel, type CdpChannel, type CdpEvent } from "./cdp-socket.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";

export interface PickerOptions {
  onPicked: (target: DomTarget) => void;
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
}

export interface Picker {
  /** Ends inspect mode and closes the picker's socket. */
  stop(): Promise<void>;
}

const BLUE = { r: 28, g: 126, b: 214 };

/** Chrome's own inspect mode, which outlines the element under the pointer in the brand's blue. */
export const INSPECT_MODE = {
  mode: "searchForNode",
  highlightConfig: {
    showInfo: true,
    contentColor: { ...BLUE, a: 0.15 },
    borderColor: { ...BLUE, a: 1 },
  },
};
const NO_INSPECT = { mode: "none", highlightConfig: {} };

const ATTRIBUTES: Record<string, keyof Omit<DomTarget, "tag">> = {
  id: "id",
  "data-testid": "testId",
  name: "name",
  role: "role",
  type: "inputType",
};

const AttachedSchema = v.object({ sessionId: v.pipe(v.string(), v.nonEmpty()) });
const RequestedSchema = v.object({ backendNodeId: v.number() });
const DescribedSchema = v.object({
  node: v.object({ localName: v.string(), attributes: v.optional(v.array(v.string()), []) }),
});

/** The element DOM.describeNode answered, as a DomTarget; Chrome reports it, so the page cannot forge it. */
export function targetOf(reply: unknown): DomTarget | undefined {
  const described = v.safeParse(DescribedSchema, reply);
  if (!described.success) return undefined;
  const { localName, attributes } = described.output.node;
  const target: Record<string, string> = { tag: localName };
  for (let at = 0; at + 1 < attributes.length; at += 2) {
    const key = ATTRIBUTES[attributes[at] ?? ""];
    const value = attributes[at + 1];
    if (key && value) target[key] = value.slice(0, MAX_CAPTURED_TEXT);
  }
  const parsed = v.safeParse(DomTargetSchema, target);
  return parsed.success ? parsed.output : undefined;
}

/** A node Chrome's inspect mode picked on the picker's own session. */
function pickedNode(event: CdpEvent, sessionId: string): number | undefined {
  if (event.sessionId !== sessionId || event.method !== "Overlay.inspectNodeRequested")
    return undefined;
  const requested = v.safeParse(RequestedSchema, event.params);
  return requested.success ? requested.output.backendNodeId : undefined;
}

/**
 * Lets a person pick an element of the page `targetId` through Chrome's inspect mode: the renderer
 * takes the input before dispatching it, so no application listener, capture ones included, runs.
 */
export async function startPicker(
  endpoint: string,
  targetId: string,
  options: PickerOptions,
): Promise<Picker> {
  assertLoopbackEndpoint(endpoint);
  // A socket of its own, so its attach never reaches the recording's instrumentation.
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  try {
    const attach = await channel.send("Target.attachToTarget", { targetId, flatten: true });
    const { sessionId } = v.parse(AttachedSchema, attach);
    const report = async (backendNodeId: number) => {
      const target = targetOf(await channel.send("DOM.describeNode", { backendNodeId }, sessionId));
      if (target) options.onPicked(target);
    };
    channel.onEvent((event) => {
      const node = pickedNode(event, sessionId);
      if (node !== undefined) void report(node).catch(() => undefined);
    });
    await channel.send("DOM.enable", undefined, sessionId);
    await channel.send("Overlay.enable", undefined, sessionId);
    await channel.send("Overlay.setInspectMode", INSPECT_MODE, sessionId);
    return {
      stop: async () => {
        await channel.send("Overlay.setInspectMode", NO_INSPECT, sessionId).catch(() => undefined);
        channel.close();
      },
    };
  } catch (error) {
    channel.close();
    throw error;
  }
}
