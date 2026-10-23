import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserTabs, toOpenTabs } from "@/dashboard/open-tabs";

const SESSION = "chrome-extension://test-id/session.html";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("lists every tab but the session's pane, titled by its address when it has no title", () => {
  const tabs = toOpenTabs(
    [
      { id: 1, title: "Shop", url: "https://shop.example/" },
      { id: 2, title: "", url: "https://blank.example/" },
      { id: 3, title: "RECnRun session", url: `${SESSION}#/` },
      { title: "No id", url: "https://devtools.example/" },
    ] as never,
    SESSION,
  );
  expect(tabs).toEqual([
    { id: 1, title: "Shop", url: "https://shop.example/" },
    { id: 2, title: "https://blank.example/", url: "https://blank.example/" },
  ]);
});

test("reads the browser's tabs and calls back on each change until unsubscribed", async () => {
  // fakeBrowser implements no in-memory onMoved or onAttached.
  for (const event of [fakeBrowser.tabs.onMoved, fakeBrowser.tabs.onAttached]) {
    vi.spyOn(event, "addListener").mockImplementation(() => {});
    vi.spyOn(event, "removeListener").mockImplementation(() => {});
  }
  const source = browserTabs(SESSION);
  const onChange = vi.fn();
  const unwatch = source.watch(onChange);
  const tab = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const pane = await fakeBrowser.tabs.create({ url: SESSION });
  const listed = (await source.list()).map(({ id }) => id);
  expect(listed).toContain(tab.id);
  expect(listed).not.toContain(pane.id);
  expect(onChange).toHaveBeenCalled();

  unwatch();
  onChange.mockClear();
  await fakeBrowser.tabs.create({ url: "https://other.example/" });
  expect(onChange).not.toHaveBeenCalled();
});
