import { describe, expect, test, vi } from "vite-plus/test";
import type { DownloadItem } from "@/background/downloads-publisher";
import { createRendezvousRelay } from "@/background/rendezvous-relay";
import type { RelayDependencies } from "@/background/rendezvous-relay";
import { ME, PEER } from "./fake-peer";

const ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const own = { extensionId: ID, extensionUrl: `chrome-extension://${ID}/` };
const offscreen = { id: ID, url: `chrome-extension://${ID}/offscreen.html` };
const BOOT = "99999999-9999-4999-8999-999999999999";
const ROOT = "/home/me/Downloads";
const FOLDER = `RECnRun/poc/lab/peers/${ME}`;
const OFFER = `${FOLDER}/offer-${PEER}.json`;

type Listener = ReturnType<typeof createRendezvousRelay>;

/** The relay over chrome.downloads whose history holds `items`. */
function relay(items: DownloadItem[] = []) {
  const downloads = {
    download: vi.fn(async () => 7),
    search: vi.fn(async ({ id }: { id?: number }) => items.filter((item) => item.id === id)),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    removeFile: vi.fn(async () => {}),
    erase: vi.fn(async () => [7]),
  };
  const deps: RelayDependencies = {
    downloads,
    me: async () => ME,
    namespace: async () => "lab",
    boot: async () => BOOT,
    root: async () => ROOT,
  };
  return { downloads, listener: createRendezvousRelay(deps, own) };
}

/** Delivers one message as Chrome would; resolves with the reply, or "ignored". */
async function deliver(listener: Listener, message: unknown, sender: object = offscreen) {
  let reply: unknown;
  if (!listener(message, sender, (value) => (reply = value))) return "ignored";
  await vi.waitFor(() => expect(reply).toBeDefined());
  return reply;
}

const request = (op: string, fields: object = {}) => ({ type: "POC_RENDEZVOUS", op, ...fields });

describe("createRendezvousRelay", () => {
  test("tells the offscreen document the namespace, the root, and the boot", async () => {
    const { listener } = relay();
    expect(await deliver(listener, request("context"))).toEqual({
      ok: true,
      result: { namespace: "lab", root: ROOT },
    });
    expect(await deliver(listener, request("boot"))).toEqual({ ok: true, result: BOOT });
  });

  test.each([
    ["a dashboard", { id: ID, url: `chrome-extension://${ID}/dashboard.html` }],
    ["another extension", { id: "x", url: `chrome-extension://x/offscreen.html` }],
  ])("ignores %s, and messages that are not its own", async (_, sender) => {
    const { listener } = relay();
    expect(await deliver(listener, request("context"), sender)).toBe("ignored");
    expect(await deliver(listener, { type: "POC_RENDEZVOUS", op: "list" })).toBe("ignored");
  });

  test("writes a signal file of this profile through Downloads, replacing it", async () => {
    const { downloads, listener } = relay();
    expect(await deliver(listener, request("write", { path: OFFER, text: "{}" }))).toEqual({
      ok: true,
      result: 7,
    });
    expect(downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: OFFER, saveAs: false, conflictAction: "overwrite" }),
    );
  });

  test.each([
    ["its presence, which the alarm writes", `${FOLDER}/presence.json`],
    ["another profile's folder", `RECnRun/poc/lab/peers/${PEER}/offer-${ME}.json`],
    ["a path that climbs out", `${FOLDER}/../${PEER}/offer-${ME}.json`],
    ["another namespace", `RECnRun/poc/other/peers/${ME}/offer-${PEER}.json`],
    ["a name it never writes", `${FOLDER}/offer-not-a-profile.json`],
  ])("refuses to write %s", async (_, path) => {
    const { downloads, listener } = relay();
    expect(await deliver(listener, request("write", { path, text: "{}" }))).toEqual({
      ok: false,
      error: expect.stringMatching(/^Refusing/),
    });
    expect(downloads.download).not.toHaveBeenCalled();
  });

  test("erases only an item Chrome wrote at one of this profile's signal paths", async () => {
    const windows = `C:\\Users\\me\\Downloads\\${FOLDER.replaceAll("/", "\\")}\\answer-${PEER}.json`;
    const { downloads, listener } = relay([
      { id: 7, filename: `${ROOT}/${OFFER}`, state: "complete" },
      { id: 8, filename: `${ROOT}/${FOLDER}/presence.json`, state: "complete" },
      { id: 9, filename: windows, state: "complete" },
    ]);
    expect(await deliver(listener, request("erase", { id: 7 }))).toEqual({ ok: true });
    expect(await deliver(listener, request("erase", { id: 9 }))).toEqual({ ok: true });
    expect(downloads.removeFile.mock.calls).toEqual([[7], [9]]);
    expect(downloads.erase.mock.calls).toEqual([[{ id: 7 }], [{ id: 9 }]]);
    for (const id of [8, 10]) {
      expect(await deliver(listener, request("erase", { id }))).toMatchObject({ ok: false });
    }
    expect(downloads.erase).toHaveBeenCalledTimes(2);
  });
});
