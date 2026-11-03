import * as v from "valibot";
import { withTimeout } from "@/background/probes/helpers";
import type { Debuggee, DebuggerApi } from "@/background/probes/types";
import type { UpdateOutcome } from "@/background/route-b/types";

// The update check fetches the script and may install a version, which takes longer than a command.
const UPDATE_TIMEOUT_MS = 15_000;
// updatefound is queued after update() resolves; this leaves it time to arrive.
const SETTLE_MS = 500;

/** Runs in the page: what one `registration.update()` found, from the page's own view. */
const UPDATE_EXPRESSION = `(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { error: "no registration" };
  let updatefound = false;
  registration.addEventListener("updatefound", () => { updatefound = true; });
  try {
    await registration.update();
  } catch (error) {
    return { error: String(error) };
  }
  const installing = registration.installing !== null;
  await new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS}));
  return {
    updatefound,
    installing: installing || registration.installing !== null,
    waiting: registration.waiting !== null,
    active: registration.active?.scriptURL ?? null,
  };
})()`;

const UpdateOutcomeSchema = v.object({
  updatefound: v.optional(v.boolean()),
  installing: v.optional(v.boolean()),
  waiting: v.optional(v.boolean()),
  active: v.optional(v.nullable(v.string())),
  error: v.optional(v.string()),
});

const ReplySchema = v.object({
  result: v.optional(v.object({ value: v.optional(v.unknown()) })),
  exceptionDetails: v.optional(
    v.object({
      text: v.optional(v.string()),
      exception: v.optional(v.object({ description: v.optional(v.string()) })),
    }),
  ),
});

/** Calls `registration.update()` in the page of `tab`, through the tab's own session. */
export async function updateInPage(api: DebuggerApi, tab: Debuggee): Promise<UpdateOutcome> {
  const params = { expression: UPDATE_EXPRESSION, awaitPromise: true, returnByValue: true };
  const sent = api.sendCommand(tab, "Runtime.evaluate", params);
  const reply = v.parse(ReplySchema, (await withTimeout(sent, "update", UPDATE_TIMEOUT_MS)) ?? {});
  const thrown = reply.exceptionDetails;
  if (thrown) return { error: thrown.exception?.description ?? thrown.text ?? "exception" };
  const outcome = v.safeParse(UpdateOutcomeSchema, reply.result?.value);
  if (outcome.success) return outcome.output;
  return { error: `unexpected reply: ${JSON.stringify(reply.result?.value)}` };
}
