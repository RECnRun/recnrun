import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { LAB_KEY } from "@/background/lab/schema";
import { startBackground } from "@/background/start";
import { fakeDebugger } from "./fake-debugger";

// E8: the background talks to the strict lab only when a policy sets the managed `lab` key.
const JOURNAL = "http://lab.localhost:9000/lab";

interface Posted {
  url: string;
  body: { event?: string; targets?: unknown[] };
}

describe("startBackground and the strict lab", () => {
  const posts: Posted[] = [];
  let debuggerFake: ReturnType<typeof fakeDebugger>;

  beforeEach(() => {
    posts.length = 0;
    fakeBrowser.reset();
    fakeBrowser.runtime.getManifest = () => ({ manifest_version: 3, name: "x", version: "0.1.0" });
    debuggerFake = fakeDebugger();
    Object.assign(fakeBrowser, { debugger: debuggerFake.api });
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body) as Posted["body"] });
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("posts its loaded beacon, with the targets it found, when the policy sets the key", async () => {
    await fakeBrowser.storage.managed.set({ [LAB_KEY]: { journalUrl: JOURNAL } });
    startBackground();
    await vi.waitFor(() => expect(posts).not.toEqual([]));
    expect(posts[0]?.url).toBe(JOURNAL);
    expect(posts[0]?.body).toMatchObject({
      event: "loaded",
      id: fakeBrowser.runtime.id,
      version: "0.1.0",
    });
    expect(posts[0]?.body.targets?.length).toBeGreaterThan(0);
  });

  test("posts nothing and arms nothing without the key", async () => {
    const attach = vi.spyOn(debuggerFake.api, "attach");
    startBackground();
    await fakeBrowser.tabs.onUpdated.trigger(1, { status: "complete" }, {
      url: "http://app.localhost:4600/offline.html",
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
  });
});
