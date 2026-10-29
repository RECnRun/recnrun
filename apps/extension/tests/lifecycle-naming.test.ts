import { expect, test } from "vite-plus/test";
import { identity } from "./fake-lifecycle";
import { setUp } from "./lifecycle-harness";

const URL_ = "https://app.example/";

test("a new identity without a label takes the next free letter, read under the lock", async () => {
  const { lifecycle, saved } = setUp();
  const d = await lifecycle.newIdentity({ url: URL_ });
  expect(d).toMatchObject({ label: "D", url: URL_ });
  expect(saved(d.id)?.label).toBe("D");
  const e = await lifecycle.newIdentity({ url: URL_ });
  expect(e.label).toBe("E");
});

test("a deleted identity's letter is taken again, and a given label is kept", async () => {
  const { lifecycle } = setUp({ saved: [identity("b", false)] });
  expect((await lifecycle.newIdentity({ url: URL_ })).label).toBe("A");
  expect((await lifecycle.newIdentity({ label: " Admin ", url: URL_ })).label).toBe("Admin");
  expect((await lifecycle.newIdentity({ url: URL_ })).label).toBe("C");
});

test("close windows closes the other Incognito windows the user saw, without saving them", async () => {
  const { lifecycle, chrome, journal } = setUp({ open: "a" });
  chrome.state.foreign = [7, 8];
  await expect(lifecycle.closeWindows([7])).rejects.toMatchObject({ name: "WindowsChanged" });
  expect(chrome.calls).toEqual([]);
  await lifecycle.closeWindows([8, 7]);
  // Only the windows shown go: the managed window and its tabs stay as they are.
  expect(chrome.calls).toEqual(["close 8,7"]);
  expect(journal.written).toEqual([]);
});

test("close windows closes nothing while recording, as a recorded tab may be in one", async () => {
  const { lifecycle, chrome } = setUp({ recording: true });
  chrome.state.foreign = [7];
  await expect(lifecycle.closeWindows([7])).rejects.toMatchObject({
    name: "RecordingInProgress",
  });
  expect(chrome.calls).toEqual([]);
});
