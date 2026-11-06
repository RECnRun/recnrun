import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { execute } from "@/background/executor";
import type { PeerMessage } from "@/p2p/protocol";
import { storedRoles } from "@/storage/hierarchy-repository";
import {
  KEYS,
  MASTER,
  OTHER_KEY,
  STRANGER,
  WORKER,
  channel,
  frame,
  from,
  meet,
  workerOf,
} from "./authorization-rig";
import { memoryRecordingStore } from "./fake-extension";
import { memoryRepository, recordingChannel } from "./fake-peer";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("OPEN_TAB, which loads a web page in the worker's browser", () => {
  const url = "https://shop.test/";
  const open = (author: string) => from("OPEN_TAB", author, { url });

  /** What the background does with a frame: the channel decides, and only an accepted command runs. */
  async function deliver(message: PeerMessage, over: string, identities = KEYS) {
    const { receive } = channel(identities);
    const verdict = await receive(frame(message), over);
    if (verdict.kind === "accepted") {
      const { channel: sender } = recordingChannel();
      await execute(verdict.message, {
        channel: sender,
        session: memoryRecordingStore(null),
        controller: memoryRepository<{ profileId: string }>(null),
        tabs: async () => ({ tabs: [] }),
      });
    }
    return verdict;
  }

  test("from the bound master opens the page", async () => {
    await workerOf(MASTER);
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    expect(await deliver(open(MASTER), MASTER)).toMatchObject({ kind: "accepted" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ url, active: false }));
  });

  test.each([
    ["another worker", () => deliver(open(WORKER), WORKER)],
    ["a stranger", () => deliver(open(STRANGER), STRANGER)],
    [
      "the master's id over a link proving another key",
      () => deliver(open(MASTER), MASTER, { ...KEYS, [MASTER]: OTHER_KEY }),
    ],
    ["a sender spoofing the master's id over its own link", () => deliver(open(MASTER), WORKER)],
    ["a relay for a worker, even over the master's link", () => deliver(open(WORKER), MASTER)],
  ])("from %s opens nothing", async (_name, send) => {
    await workerOf(MASTER);
    await meet(WORKER, STRANGER);
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    const createWindow = vi.spyOn(fakeBrowser.windows, "create");
    expect((await send()).kind).not.toBe("accepted");
    expect(create).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  test("on a template opens nothing, even from its former master", async () => {
    await storedRoles().holdAsTemplate();
    await meet(MASTER);
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    expect(await deliver(open(MASTER), MASTER)).toMatchObject({ kind: "refused" });
    expect(create).not.toHaveBeenCalled();
  });
});
