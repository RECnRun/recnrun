import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chrome, memoryCaptures } from "./fake-capture";
import { memoryRecordingStore } from "./fake-extension";
import { identity, memoryIdentities } from "./fake-lifecycle";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";
import {
  allowIncognito,
  contentScript,
  fakeWorkspacePorts,
  manageTab,
  RECORDING_FIRST,
  readStatus,
  TARGET,
  workspaceBackground,
} from "./workspace-harness";

const RECORDING = { tabId: 1, status: "recording" as const, banked: 0, since: 0 };

function background(recording = false) {
  const { api, cookies } = chrome();
  const captures = memoryCaptures();
  const { memory, repository } = memoryIdentities([identity("a"), identity("b", false)]);
  const deps = { api, cookies, captures, identities: repository };
  const store = memoryRecordingStore(recording ? RECORDING : null);
  const send = workspaceBackground(store, fakeWorkspacePorts(), deps);
  return { send, captures, memory };
}

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
  allowIncognito(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("the status lists the saved identities", async () => {
  const { send } = background();
  const { identities } = await readStatus(send);
  expect(identities.map(({ id, lastCapture }) => [id, lastCapture?.bytes])).toEqual([
    ["a", 10],
    ["b", undefined],
  ]);
});

test("delete removes a saved identity and its captures", async () => {
  const { send, captures, memory } = background();
  const reply = await send({ type: "workspace-delete-identity", identityId: "a" });
  expect(reply).toEqual({ ok: true });
  expect(captures.remove).toHaveBeenCalledWith("a");
  expect(memory.saved.map(({ id }) => id)).toEqual(["b"]);
});

test("each lifecycle message answers with the refusal it met", async () => {
  const { send } = background();
  const replies = await Promise.all([
    send({ type: "workspace-suspend" }),
    send({ type: "workspace-resume", identityId: "b" }),
  ]);
  expect(replies).toEqual([
    { ok: false, error: "No Incognito workspace is open; start one first." },
    { ok: false, error: "RECnRun is busy with another Incognito workspace operation." },
  ]);
  expect(await send({ type: "workspace-resume", identityId: "b" })).toEqual({
    ok: false,
    error: "RECnRun has no saved data for this identity.",
  });
  expect(await send({ type: "workspace-new-identity", label: " ", url: TARGET })).toEqual({
    ok: false,
    error: "Give the identity a label and an http or https address.",
  });
});

test("switch is refused while recording, and refused for a window with no identity", async () => {
  expect(await background(true).send({ type: "workspace-switch", identityId: "b" })).toEqual(
    RECORDING_FIRST,
  );
  const { send } = background();
  const windowId = await openIncognitoWindow();
  const [tab] = await fakeBrowser.tabs.query({ windowId });
  await manageTab(tab?.id ?? -1, windowId);
  expect(await send({ type: "workspace-switch", identityId: "b" })).toMatchObject({
    ok: false,
    error: expect.stringContaining("belongs to no identity"),
  });
});

test("new identity closes only the windows it was shown", async () => {
  const { send } = background();
  const reply = await send({
    type: "workspace-new-identity",
    label: "Admin",
    url: TARGET,
    closeWindowIds: [99],
  });
  expect(reply).toEqual({
    ok: false,
    error: "The Incognito windows changed; review them again before closing them.",
  });
});

test("lifecycle messages answer only the extension's own pages, and only valid ones", async () => {
  const { send } = background();
  for (const type of [
    "workspace-switch",
    "workspace-suspend",
    "workspace-resume",
    "workspace-new-identity",
    "workspace-delete-identity",
  ]) {
    const message = { type, identityId: "a", label: "A", url: TARGET };
    await expect(send(message, contentScript)).rejects.toThrow("No answer");
  }
  await expect(send({ type: "workspace-switch", identityId: "" })).rejects.toThrow("No answer");
});
