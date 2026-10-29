import { expect, test, vi } from "vite-plus/test";
import type { memoryOperationJournal } from "./fake-journal";
import { SUMMARY } from "./fake-lifecycle";
import { NOW, setUp } from "./lifecycle-harness";

const steps = (journal: ReturnType<typeof memoryOperationJournal>) =>
  journal.written.map(({ step, status }) => `${step} ${status}`);

test("switch saves the open identity before it closes, then starts the target from its capture", async () => {
  const { lifecycle, chrome, journal, saved, access } = setUp({ open: "a" });
  const timings = await lifecycle.switchTo("b");
  expect(chrome.calls).toEqual(["capture a", "close 5", "start b capture"]);
  expect(saved("a")?.lastCapture).toEqual({ id: "cap-a-2", at: NOW, bytes: 64 });
  expect(steps(journal)).toEqual([
    "capture running",
    "persist running",
    "close running",
    "start-from-capture running",
  ]);
  const [, , operation] = vi.mocked(chrome.effects.start).mock.calls[0] ?? [];
  expect(operation).toEqual({ id: journal.written[0]?.id, kind: "switch" });
  expect(timings).toEqual([{ step: "reload", ms: 1 }]);
  expect(access).toHaveBeenCalledOnce();
});

test("while the open window is captured and closed, the journal names it for recovery", async () => {
  const { lifecycle, journal } = setUp({ open: "a" });
  await lifecycle.switchTo("b");
  const held = journal.written.map(({ step, generation, windowId }) => ({
    step,
    generation,
    windowId,
  }));
  expect(held).toEqual([
    { step: "capture", generation: 1, windowId: 5 },
    { step: "persist", generation: 1, windowId: 5 },
    { step: "close", generation: 1, windowId: 5 },
    { step: "start-from-capture", generation: undefined, windowId: undefined },
  ]);
});

test("the test hook runs before each lifecycle step, and a step it fails is journaled failed", async () => {
  const seen: string[] = [];
  const beforeStep = vi.fn(async (step: string) => {
    seen.push(step);
    if (step === "persist") throw new Error("Injected before persist.");
  });
  const { lifecycle, chrome, journal } = setUp({ open: "a" });
  chrome.effects.beforeStep = beforeStep;
  await expect(lifecycle.switchTo("b")).rejects.toThrow("Injected before persist.");
  expect(seen).toEqual(["capture", "persist"]);
  expect(chrome.calls).toEqual(["capture a"]);
  expect(journal.written.at(-1)).toMatchObject({ step: "persist", status: "failed" });
});

test("a target whose capture cannot be read refuses before anything is captured or closed", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  chrome.state.failAt = "load";
  await expect(lifecycle.switchTo("b")).rejects.toThrow("Injected at load.");
  expect(chrome.effects.load).toHaveBeenCalledWith(saved("b"), "capture");
  expect(chrome.calls).toEqual([]);
  expect(journal.written).toEqual([]);
  expect(chrome.state.managed).toBeDefined();
  expect(saved("a")?.lastCapture?.id).toBe("cap-a");
});

test("switch to an identity never captured opens it empty", async () => {
  const { lifecycle, chrome } = setUp();
  await lifecycle.switchTo("c");
  expect(chrome.calls).toEqual(["start c empty"]);
});

test("a failed capture keeps the workspace open and names the step", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  chrome.state.failAt = "capture";
  await expect(lifecycle.switchTo("b")).rejects.toThrow("Injected at capture.");
  expect(chrome.calls).toEqual(["capture a"]);
  expect(chrome.state.managed).toBeDefined();
  expect(saved("a")?.lastCapture?.id).toBe("cap-a");
  expect(journal.written.at(-1)).toMatchObject({
    step: "capture",
    status: "failed",
    error: "Injected at capture.",
  });
});

test("a capture is kept once the identity names it, and taken back when that fails", async () => {
  const { lifecycle, chrome, memory } = setUp({ open: "a" });
  // A settle that fails is left to the identity's next read or capture, never to the caller.
  vi.mocked(chrome.effects.settle).mockRejectedValue(new Error("Later."));
  memory.failNext = true;
  await expect(lifecycle.switchTo("b")).rejects.toThrow("The disk is full.");
  expect(chrome.effects.settle).toHaveBeenCalledExactlyOnceWith("a", "cap-a");
  vi.mocked(chrome.effects.settle).mockClear();
  await lifecycle.switchTo("b");
  expect(chrome.effects.settle).toHaveBeenCalledExactlyOnceWith("a", "cap-a-2");
});

test("a capture RECnRun cannot record on the identity keeps the workspace open", async () => {
  const { lifecycle, chrome, journal, memory } = setUp({ open: "a" });
  memory.failNext = true;
  await expect(lifecycle.suspend()).rejects.toThrow("The disk is full.");
  expect(chrome.calls).toEqual(["capture a"]);
  expect(journal.written.at(-1)).toMatchObject({ step: "persist", status: "failed" });
});

test("an Incognito window opened during the capture stops the close, with the capture kept", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  vi.mocked(chrome.effects.capture).mockImplementationOnce(async () => {
    chrome.state.foreign = [9];
    return { ...SUMMARY, captureId: "cap-a-3" };
  });
  await expect(lifecycle.switchTo("b")).rejects.toThrow("The capture is saved");
  expect(chrome.calls).toEqual([]);
  expect(saved("a")?.lastCapture?.id).toBe("cap-a-3");
  expect(journal.written.at(-1)).toMatchObject({ step: "close", status: "failed" });
});

test("Switch closes every window of the session, one beside the window RECnRun opened too", async () => {
  const { lifecycle, chrome } = setUp({ open: "a" });
  chrome.state.beside = [6];
  chrome.state.tabs = [50, 60];
  vi.mocked(chrome.effects.capture).mockResolvedValueOnce({ ...SUMMARY, tabs: [50, 60] });
  await lifecycle.switchTo("b");
  expect(chrome.calls).toEqual(["close 5,6", "start b capture"]);
});

test("an Incognito tab opened during the capture stops the close, so nothing it shows is lost", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  chrome.state.tabs = [50];
  vi.mocked(chrome.effects.capture).mockImplementationOnce(async () => {
    chrome.state.beside = [9];
    chrome.state.tabs = [50, 90];
    return { ...SUMMARY, captureId: "cap-a-3", tabs: [50] };
  });
  await expect(lifecycle.switchTo("b")).rejects.toThrow(
    "The capture is saved; an Incognito tab opened while it ran, so run the command again to save it too.",
  );
  expect(chrome.calls).toEqual([]);
  expect(saved("a")?.lastCapture?.id).toBe("cap-a-3");
  expect(journal.written.at(-1)).toMatchObject({ step: "close", status: "failed" });
});

test("a failed start leaves the previous identity's capture saved", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  chrome.state.failAt = "start";
  await expect(lifecycle.switchTo("b")).rejects.toThrow("Injected at start.");
  expect(chrome.calls).toEqual(["capture a", "close 5", "start b capture"]);
  expect(saved("a")?.lastCapture?.id).toBe("cap-a-2");
  expect(journal.written.at(-1)).toMatchObject({ step: "start-from-capture", status: "failed" });
});

test("a start failure the bootstrap recorded at its own step is left as it recorded it", async () => {
  const { lifecycle, chrome, journal } = setUp();
  vi.mocked(chrome.effects.start).mockImplementationOnce(async (_target, _from, { id, kind }) => {
    await journal.write({ id, kind, step: "window", status: "failed", started: NOW, error: "No." });
    throw new Error("No.");
  });
  await expect(lifecycle.resume("b")).rejects.toThrow("No.");
  expect(steps(journal)).toEqual(["start-from-capture running", "window failed"]);
});

test("suspend saves and closes the open identity, then records the operation done", async () => {
  const { lifecycle, chrome, journal } = setUp({ open: "a" });
  await lifecycle.suspend();
  expect(chrome.calls).toEqual(["capture a", "close 5"]);
  expect(chrome.state.managed).toBeUndefined();
  expect(journal.written.at(-1)).toMatchObject({ kind: "suspend", step: "close", status: "done" });
});

test("resume starts a saved identity only when nothing is open and it has a capture", async () => {
  const { lifecycle, chrome } = setUp();
  await expect(lifecycle.resume("c")).rejects.toMatchObject({ name: "CaptureMissing" });
  await lifecycle.resume("b");
  expect(chrome.calls).toEqual(["start b capture"]);
  await expect(lifecycle.resume("a")).rejects.toMatchObject({ name: "WorkspaceOpen" });
  await expect(lifecycle.suspend()).resolves.toBeUndefined();
  await expect(lifecycle.suspend()).rejects.toMatchObject({ name: "NoManagedWindow" });
});

test("commands that open or close windows are refused while recording or beside other windows", async () => {
  const recording = setUp({ open: "a", recording: true });
  await expect(recording.lifecycle.switchTo("b")).rejects.toMatchObject({
    name: "RecordingInProgress",
  });
  const crowded = setUp({ open: "a" });
  crowded.chrome.state.foreign = [7];
  await expect(crowded.lifecycle.suspend()).rejects.toMatchObject({
    name: "IncognitoWindowsOpen",
  });
  expect([...recording.chrome.calls, ...crowded.chrome.calls]).toEqual([]);
  expect(recording.journal.written).toEqual([]);
});

test("an open window whose identity is no longer saved cannot be saved", async () => {
  const { lifecycle, chrome } = setUp({ open: "gone" });
  await expect(lifecycle.switchTo("b")).rejects.toMatchObject({ name: "IdentityNotFound" });
  expect(chrome.calls).toEqual([]);
});

test("new identity saves the open one, then opens the new one empty and keeps it", async () => {
  const { lifecycle, chrome, saved } = setUp({ open: "a" });
  const draft = {
    label: " Admin ",
    url: "https://app.example/",
  };
  const created = await lifecycle.newIdentity(draft);
  expect(created).toMatchObject({ label: "Admin", url: draft.url, created: NOW });
  expect(created.lastCapture).toBeUndefined();
  expect(chrome.calls).toEqual(["capture a", "close 5", `start ${created.id} empty`]);
  expect(saved(created.id)).toEqual(created);
});

test("new identity is not kept when saving the open one fails, nor made from a bad draft", async () => {
  const { lifecycle, chrome, memory } = setUp({ open: "a" });
  chrome.state.failAt = "capture";
  const draft = { label: "Admin", url: "https://app.example/" };
  await expect(lifecycle.newIdentity(draft)).rejects.toThrow("Injected at capture.");
  await expect(lifecycle.newIdentity({ ...draft, label: " " })).rejects.toMatchObject({
    name: "IdentityNotValid",
  });
  await expect(lifecycle.newIdentity({ ...draft, url: "file:///etc" })).rejects.toThrow(
    "Only http and https pages can open in the Incognito workspace.",
  );
  expect(memory.saved.map(({ id }) => id)).toEqual(["a", "b", "c"]);
});

test("delete removes a closed identity and its captures, even while recording", async () => {
  const { lifecycle, chrome, journal, memory, access } = setUp({ open: "a", recording: true });
  await lifecycle.deleteIdentity("b");
  expect(chrome.calls).toEqual(["remove b"]);
  expect(memory.saved.map(({ id }) => id)).toEqual(["a", "c"]);
  expect(journal.written.at(-1)).toMatchObject({ kind: "delete-identity", status: "done" });
  await expect(lifecycle.deleteIdentity("a")).rejects.toMatchObject({ name: "IdentityOpen" });
  await expect(lifecycle.deleteIdentity("b")).rejects.toMatchObject({ name: "IdentityNotFound" });
  expect(access).not.toHaveBeenCalled();
});
