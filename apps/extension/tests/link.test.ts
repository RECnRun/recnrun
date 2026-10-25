import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { askLink } from "@/background/link";
import { OFFSCREEN_PAGE } from "@/background/listener";
import { linkCommandMessage } from "@/messaging/peer-messages";
import { answering } from "./fake-peer";

/** Chrome's view of the offscreen document: whether one is open, and what it answers. */
function offscreen(open: boolean, reply: unknown = { ok: true, result: { sent: true } }) {
  const contexts = vi
    .spyOn(fakeBrowser.runtime, "getContexts")
    .mockImplementation(answering(() => (open ? [{}] : [])));
  const create = vi.spyOn(fakeBrowser.offscreen, "createDocument").mockResolvedValue(undefined);
  const send = vi
    .spyOn(fakeBrowser.runtime, "sendMessage")
    .mockImplementation(answering(() => reply));
  return { contexts, create, send };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("sends the command to an open offscreen document and returns its result", async () => {
  const { create, send } = offscreen(true);
  const command = { type: "send" as const, frame: "{}" };
  expect(await askLink(command)).toEqual({ sent: true });
  expect(send).toHaveBeenCalledWith(linkCommandMessage(command));
  expect(create).not.toHaveBeenCalled();
});

test("creates the offscreen document first, once for commands sent together", async () => {
  const { create } = offscreen(false);
  await Promise.all([askLink({ type: "info" }), askLink({ type: "close" })]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ url: OFFSCREEN_PAGE }));
  await askLink({ type: "info" });
  expect(create).toHaveBeenCalledTimes(2);
});

test("retries the creation after Chrome refused it", async () => {
  const { create } = offscreen(false);
  create.mockRejectedValueOnce(new Error("Only a single offscreen document may be created."));
  await expect(askLink({ type: "info" })).rejects.toThrow("Only a single offscreen document");
  await expect(askLink({ type: "info" })).resolves.toEqual({ sent: true });
});

test("rejects with the link's error, or when it does not answer", async () => {
  offscreen(true, { ok: false, error: "No connection." });
  await expect(askLink({ type: "close" })).rejects.toThrow("No connection.");
  vi.restoreAllMocks();
  offscreen(true, null);
  await expect(askLink({ type: "close" })).rejects.toThrow("The link did not answer.");
});
