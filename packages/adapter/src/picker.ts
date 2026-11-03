import { DomTargetSchema, MAX_CAPTURED_TEXT, type DomTarget } from "@recnrun/protocol";
import * as v from "valibot";
import { openCdpChannel, type CdpChannel, type CdpEvent } from "./cdp-socket.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";
import { PICKER_STOP, pickerSource as source } from "./picker-source.ts";

/** The isolated world the picker draws in, and the binding only that world receives. */
export const PICKER_WORLD = "recnrun-picker";
export const PICKER_BINDING = "__recnrunPick";

export interface PickerOptions {
  onPicked: (target: DomTarget) => void;
  openChannel?: (endpoint: string) => Promise<CdpChannel>;
}

export interface Picker {
  /** Removes the overlay and closes the picker's socket. */
  stop(): Promise<void>;
}

export const pickerSource = (): string => source(PICKER_BINDING, MAX_CAPTURED_TEXT);

const AttachedSchema = v.object({ sessionId: v.pipe(v.string(), v.nonEmpty()) });
const WorldSchema = v.object({ executionContextId: v.number() });
const CalledSchema = v.object({
  name: v.literal(PICKER_BINDING),
  payload: v.string(),
  executionContextId: v.number(),
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A picked element, only from the picker's own world; the page cannot reach that binding. */
function pickedOf(event: CdpEvent, sessionId: string, contextId: number): DomTarget | undefined {
  if (event.sessionId !== sessionId || event.method !== "Runtime.bindingCalled") return undefined;
  const called = v.safeParse(CalledSchema, event.params);
  if (!called.success || called.output.executionContextId !== contextId) return undefined;
  const target = v.safeParse(DomTargetSchema, parseJson(called.output.payload));
  return target.success ? target.output : undefined;
}

/**
 * Lets a person pick an element of the page `targetId`: an overlay in an isolated world outlines
 * the element under the pointer and swallows the click, so the application's handlers never run.
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
    await channel.send("Runtime.enable", undefined, sessionId);
    const binding = { name: PICKER_BINDING, executionContextName: PICKER_WORLD };
    await channel.send("Runtime.addBinding", binding, sessionId);
    const world = { frameId: targetId, worldName: PICKER_WORLD };
    const created = await channel.send("Page.createIsolatedWorld", world, sessionId);
    const contextId = v.parse(WorldSchema, created).executionContextId;
    channel.onEvent((event) => {
      const picked = pickedOf(event, sessionId, contextId);
      if (picked) options.onPicked(picked);
    });
    await channel.send("Runtime.evaluate", { expression: pickerSource(), contextId }, sessionId);
    const evaluate = { expression: PICKER_STOP, contextId };
    return {
      stop: async () => {
        await channel.send("Runtime.evaluate", evaluate, sessionId).catch(() => undefined);
        channel.close();
      },
    };
  } catch (error) {
    channel.close();
    throw error;
  }
}
