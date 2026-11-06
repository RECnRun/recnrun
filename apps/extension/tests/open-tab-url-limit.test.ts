import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { execute } from "@/background/executor";
import { memoryRecordingStore } from "./fake-extension";
import { fromPeer, memoryRepository, recordingChannel } from "./fake-peer";

beforeEach(() => {
  fakeBrowser.reset();
});

const urlOfLength = (length: number) => `https://shop.example/${"a".repeat(length - 21)}`;

async function open(url: string) {
  const { channel, sent } = recordingChannel();
  await execute(fromPeer("OPEN_TAB", { url }), {
    channel,
    session: memoryRecordingStore(null),
    controller: memoryRepository<{ profileId: string }>(null),
    tabs: async () => ({ tabs: [] }),
  });
  return sent.find((each) => each.type === "COMMAND_RESULT")?.payload;
}

describe("the executor's own check of an OPEN_TAB url length", () => {
  test("opens a url of exactly 2048 characters", async () => {
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    expect(await open(urlOfLength(2048))).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("refuses a url of 2049 characters without opening anything", async () => {
    const create = vi.spyOn(fakeBrowser.tabs, "create");
    const createWindow = vi.spyOn(fakeBrowser.windows, "create");
    expect(await open(urlOfLength(2049))).toMatchObject({ ok: false });
    expect(create).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });
});
