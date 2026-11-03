import * as v from "valibot";
import { openCdpChannel } from "./cdp-socket.ts";
import {
  instrumentChannel,
  type Instrumentation,
  type InstrumentOptions,
} from "./instrumentation.ts";
import { TargetScope } from "./instrumentation-scope.ts";
import { assertLoopbackEndpoint } from "./loopback.ts";

/** A recording session's instrumentation, limited to the page it opened and what that page opens. */
export interface Recording extends Instrumentation {
  /** The page the session opened; the person records there. */
  readonly targetId: string;
}

const CreatedSchema = v.object({ targetId: v.pipe(v.string(), v.nonEmpty()) });

/**
 * Opens a page of its own in the default browser context, then instruments only that page,
 * the pages it opens, and their frames and workers; every other tab is resumed and let go.
 */
export async function startRecording(
  endpoint: string,
  options: Omit<InstrumentOptions, "scope"> = {},
): Promise<Recording> {
  assertLoopbackEndpoint(endpoint);
  const channel = await (options.openChannel ?? openCdpChannel)(endpoint);
  let targetId: string;
  try {
    const reply = await channel.send("Target.createTarget", { url: "about:blank" });
    targetId = v.parse(CreatedSchema, reply).targetId;
  } catch (error) {
    channel.close();
    throw error;
  }
  const scope = new TargetScope([targetId]);
  return { ...(await instrumentChannel(channel, { ...options, scope })), targetId };
}
