import type { ManagedWindowState } from "@recnrun/domain";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { captureIdentity } from "@/background/workspace/capture";
import { CACHE, PART, SCHEMA, STORAGE, capturedWith } from "./capture-replies";
import { chrome, memoryCaptures } from "./fake-capture";
import { memoryResponseUrls } from "./fake-helper";

const ORIGIN = "http://app.localhost:5192";
const MANAGED: ManagedWindowState = { generation: 4, windowId: 9, tabId: 7, status: "active" };

/** The operation of the command the agent got, once it got one. */
async function operationOf(agent: ReturnType<typeof chrome>["agent"]) {
  await vi.waitFor(() => expect(agent.posted).toHaveLength(1));
  const { operationId, generation } = agent.posted[0] as {
    operationId: string;
    generation: number;
  };
  return { operationId, generation };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("names each restored entry with the URL its start restored, which the agent reads as empty", async () => {
  const [entry] = CACHE.cache.entries;
  const built = (url: string) => ({
    request: { ...entry?.request, url },
    response: { ...entry?.response, type: "default", url: "" },
  });
  const cache = { name: "v1", entries: [built(`${ORIGIN}/a`), built(`${ORIGIN}/b`)] };
  const replies = [STORAGE, SCHEMA, PART, { ...CACHE, cache }, capturedWith({ cacheEntries: 2 })];
  const shown = `${ORIGIN}/a?via=redirect`;
  const setup = chrome();
  const captures = memoryCaptures();
  const responseUrls = memoryResponseUrls(MANAGED.generation, {
    [ORIGIN]: [[`${ORIGIN}/a`, shown]],
    "http://other.localhost:5192": [[`${ORIGIN}/b`, "http://other.localhost:5192/b"]],
  });
  const capturing = captureIdentity("identity-a", MANAGED, { ...setup, captures, responseUrls });
  const operation = await operationOf(setup.agent);
  for (const reply of replies) setup.agent.onMessage.emit({ ...reply, ...operation });
  await capturing;
  const urls = captures.parts.flatMap((part) =>
    "cache" in part ? part.cache.entries.map(({ response }) => response.url) : [],
  );
  expect(urls).toEqual([shown, ""]);
  expect(responseUrls.read).toHaveBeenCalledWith(MANAGED.generation);
});
