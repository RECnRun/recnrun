import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { askLink, closeOffscreen, ensureOffscreen } from "@/background/link";
import { OFFSCREEN_PAGE } from "@/background/listener";
import { linkCommandMessage } from "@/messaging/peer-messages";
import { PEER, answering } from "./fake-peer";

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
  const command = { type: "send" as const, peer: PEER, frame: "{}" };
  expect(await askLink(command)).toEqual({ sent: true });
  expect(send).toHaveBeenCalledWith(linkCommandMessage(command));
  expect(create).not.toHaveBeenCalled();
});

test("creates the offscreen document first, once for commands sent together", async () => {
  const { create } = offscreen(false);
  await Promise.all([askLink({ type: "folder-status" }), askLink({ type: "close", peer: PEER })]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ url: OFFSCREEN_PAGE }));
  await askLink({ type: "folder-status" });
  expect(create).toHaveBeenCalledTimes(2);
});

test("retries the creation after Chrome refused it", async () => {
  const { create } = offscreen(false);
  create.mockRejectedValueOnce(new Error("Only a single offscreen document may be created."));
  await expect(askLink({ type: "folder-status" })).rejects.toThrow(
    "Only a single offscreen document",
  );
  await expect(askLink({ type: "folder-status" })).resolves.toEqual({ sent: true });
});

test("rejects with the link's error, or when it does not answer", async () => {
  offscreen(true, { ok: false, error: "No connection." });
  await expect(askLink({ type: "close", peer: PEER })).rejects.toThrow("No connection.");
  vi.restoreAllMocks();
  offscreen(true, null);
  await expect(askLink({ type: "close", peer: PEER })).rejects.toThrow("The link did not answer.");
});

test("closes the offscreen document only when one is open", async () => {
  const close = vi.spyOn(fakeBrowser.offscreen, "closeDocument").mockResolvedValue(undefined);
  offscreen(false);
  await closeOffscreen();
  expect(close).not.toHaveBeenCalled();
  offscreen(true);
  await closeOffscreen();
  expect(close).toHaveBeenCalledOnce();
});

/** Chrome reports the offscreen frame as soon as creation starts, before its page has loaded. */
function slowCreation() {
  let created = false;
  let finish = () => {};
  vi.spyOn(fakeBrowser.runtime, "getContexts").mockImplementation(
    answering(() => (created ? [{}] : [])),
  );
  const create = vi.spyOn(fakeBrowser.offscreen, "createDocument").mockImplementation(
    answering(
      () =>
        new Promise<void>((resolve) => {
          created = true;
          finish = resolve;
        }),
    ),
  );
  return {
    create,
    finish: () => finish(),
    reset: () => {
      created = false;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a second caller waits for a creation that is still loading", async () => {
  const { finish } = slowCreation();
  const state = { secondDone: false };
  const first = ensureOffscreen();
  await flush();
  const second = ensureOffscreen().then(() => (state.secondDone = true));
  await flush();
  expect(state.secondDone).toBe(false);
  finish();
  await Promise.all([first, second]);
  expect(state.secondDone).toBe(true);
});

test("closing waits for a pending creation, and the next caller creates again", async () => {
  const { create, finish, reset } = slowCreation();
  const close = vi
    .spyOn(fakeBrowser.offscreen, "closeDocument")
    .mockImplementation(answering(reset));
  const first = ensureOffscreen();
  await flush();
  const closing = closeOffscreen();
  await flush();
  expect(close).not.toHaveBeenCalled();
  finish();
  await Promise.all([first, closing]);
  expect(close).toHaveBeenCalledOnce();
  const again = ensureOffscreen();
  await flush();
  expect(create).toHaveBeenCalledTimes(2);
  finish();
  await again;
});
