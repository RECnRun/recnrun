import type { ManagedWindowState } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { captureIdentity } from "@/background/workspace/capture";
import { completeReplies } from "./capture-replies";
import { chrome, memoryCaptures } from "./fake-capture";
import { echoProbes, fakePort } from "./fake-port";

const ORIGIN = "http://app.localhost:5192";
const MANAGED: ManagedWindowState = { generation: 4, windowId: 9, tabId: 7, status: "active" };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Answers each command `agent` gets with `replies`, tagged with its operation. */
function answering(agent: ReturnType<typeof fakePort>, replies: readonly object[]) {
  const post = agent.postMessage;
  agent.postMessage = (message: unknown) => {
    post(message);
    const { operationId, generation } = message as Record<string, unknown>;
    for (const reply of replies) {
      queueMicrotask(() => agent.onMessage.emit({ ...reply, operationId, generation }));
    }
  };
  return agent;
}

test("reads the primary tab's origin behind the barrier when its page left during the read, keeping that read alone", async () => {
  const setup = chrome();
  const captures = memoryCaptures();
  const { navigation } = setup.origins.helper;
  navigation.update = async (tabId, url) => {
    navigation.updates.push({ tabId, url });
    const sender = { tab: { id: tabId }, frameId: 0, documentId: "doc-2", origin: ORIGIN };
    const agent = answering(echoProbes(fakePort(sender)), completeReplies);
    navigation.onCommitted.emit({ tabId, frameId: 0, url, documentId: "doc-2" });
    navigation.onConnect.emit(agent);
  };
  // The page sends part of its data, then the navigation it was replaced by commits.
  answering(setup.agent, completeReplies.slice(0, 4));
  const capturing = captureIdentity("identity-a", MANAGED, { ...setup, captures, boundMs: 5_000 });
  await vi.waitFor(() => expect(captures.calls).toEqual(["begin", "append", "append"]));
  setup.api.topFrame.mockResolvedValue({ url: "about:blank", documentId: "doc-next" });
  setup.agent.onDisconnect.emit();
  const summary = await capturing;
  expect(captures.calls).toEqual([
    "begin",
    "append",
    "append",
    "drop",
    "append",
    "append",
    "publish",
  ]);
  expect(captures.parts).toHaveLength(2);
  expect(navigation.updates).toEqual([{ tabId: 7, url: `${ORIGIN}/` }]);
  expect(summary.sessionStorage).toBeGreaterThan(0);
  // A capture no close follows brings the tab back to the address it found the tab on.
  expect(setup.api.navigate).toHaveBeenCalledWith(7, `${ORIGIN}/app/`);
});
