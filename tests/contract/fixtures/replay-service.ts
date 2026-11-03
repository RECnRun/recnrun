// Starts the service, replays a flow of `steps` slow clicks through it, and stops on SIGTERM.
import { startService, stopOnSignals } from "../../../apps/service/src/index.ts";
import type { ReplayDriver } from "../../../packages/engine/src/index.ts";
import { openFlowStore } from "../../../packages/persistence/src/index.ts";
import type { Flow } from "../../../packages/protocol/src/index.ts";
import { fakeChrome } from "../fake-chrome.ts";

const [home, steps] = process.argv.slice(2);
if (home === undefined || steps === undefined) {
  throw new Error("Usage: replay-service <home> <steps>");
}

const flow: Flow = {
  schemaVersion: 1,
  id: "many-clicks",
  name: "Many clicks",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: Array.from({ length: Number(steps) }, (_unused, index) => ({
    id: `click-${index + 1}`,
    action: "click" as const,
    target: { testId: "send" },
  })),
};
const flows = await openFlowStore({ home });
await flows.saveFlow(flow);
flows.close();

let acting = () => {};
const firstAct = new Promise<void>((resolve) => (acting = resolve));
// Every click takes a while, so the whole flow outlasts the service's grace for replays.
const driver: ReplayDriver = {
  inspect: async () => ({
    count: 1,
    visible: true,
    enabled: true,
    editable: true,
    text: "",
    value: null,
  }),
  readAttribute: async () => null,
  tabs: async () => ({ tabs: [{ url: "http://127.0.0.1:4600/", title: "" }], current: 0 }),
  act: async () => {
    acting();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { status: "done" };
  },
};
const chrome = fakeChrome();
const started = await startService({
  home,
  discover: () => chrome.adapter.discover(),
  adapter: { ...chrome.adapter, replayDriver: async () => ({ driver, close: async () => {} }) },
});
if (started.reused) throw new Error("A service already runs for this home.");
stopOnSignals(started.service);

const response = await fetch(`${started.service.url}/api`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${started.service.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ requestId: "r-1", command: "flow.replay", params: { flowId: flow.id } }),
});
const body = (await response.json()) as { result?: { runId?: string } };
console.log(`run ${body.result?.runId ?? "none"}`);
await firstAct;
console.log("replaying");
