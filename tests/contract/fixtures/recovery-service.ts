// `replay` starts a replay whose third click never returns, for a SIGKILL; `serve` restarts on the same home.
import { startService, stopOnSignals } from "../../../apps/service/src/index.ts";
import type { ReplayDriver } from "../../../packages/engine/src/index.ts";
import { openFlowStore } from "../../../packages/persistence/src/index.ts";
import type { Flow } from "../../../packages/protocol/src/index.ts";
import { fakeChrome } from "../fake-chrome.ts";

const [home, mode] = process.argv.slice(2);
if (home === undefined || (mode !== "replay" && mode !== "serve")) {
  throw new Error("Usage: recovery-service <home> replay|serve");
}

const flow: Flow = {
  schemaVersion: 1,
  id: "four-clicks",
  name: "Four clicks",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [1, 2, 3, 4].map((index) => ({
    id: `click-${index}`,
    action: "click" as const,
    target: { testId: "send" },
  })),
};

let dispatches = 0;
// Every dispatch is printed, so the test sees whether a restarted service re-executes a step.
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
    dispatches += 1;
    console.log(`dispatch ${dispatches}`);
    if (mode === "serve" || dispatches < 3) return { status: "done" };
    console.log("in-flight");
    return new Promise(() => {});
  },
};

if (mode === "replay") {
  const flows = await openFlowStore({ home });
  await flows.saveFlow(flow);
  flows.close();
}
const chrome = fakeChrome();
const started = await startService({
  home,
  discover: () => chrome.adapter.discover(),
  adapter: { ...chrome.adapter, replayDriver: async () => ({ driver, close: async () => {} }) },
});
if (started.reused) throw new Error("A service already runs for this home.");
stopOnSignals(started.service);

if (mode === "serve") {
  console.log("ready");
} else {
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
}
