import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserTabs, currentTab, toBrowserTabs } from "@/tabs/open-tabs";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (fields: Partial<Browser.tabs.Tab>) =>
  ({ windowId: 1, incognito: false, active: false, ...fields }) as Browser.tabs.Tab;
const browserWindow = (fields: Partial<Browser.windows.Window>) =>
  ({ focused: false, alwaysOnTop: false, incognito: false, ...fields }) as Browser.windows.Window;

test("lists every tab with an id across windows, titled by its address when it has no title", () => {
  const state = toBrowserTabs([
    browserWindow({
      tabs: [
        tab({ id: 1, title: "Shop", url: "https://shop.example/" }),
        tab({ id: 2, title: "", url: "https://blank.example/" }),
        tab({ title: "No id", url: "https://devtools.example/" }),
        tab({ id: 3, title: "", url: "" }),
      ],
    }),
    browserWindow({ id: 2, incognito: true, tabs: [tab({ id: 4, windowId: 2, incognito: true })] }),
  ]);
  expect(state).toEqual({
    tabs: [
      { id: 1, windowId: 1, incognito: false, title: "Shop", url: "https://shop.example/" },
      {
        id: 2,
        windowId: 1,
        incognito: false,
        title: "https://blank.example/",
        url: "https://blank.example/",
      },
      { id: 3, windowId: 1, incognito: false, title: "Untitled tab", url: "" },
      { id: 4, windowId: 2, incognito: true, title: "Untitled tab", url: "" },
    ],
  });
});

test("names the focused window's active tab current, and leaves the PiP window out", () => {
  const state = toBrowserTabs([
    browserWindow({ tabs: [tab({ id: 1, active: true }), tab({ id: 2 })] }),
    browserWindow({ focused: true, tabs: [tab({ id: 3 }), tab({ id: 4, active: true })] }),
    browserWindow({ alwaysOnTop: true, tabs: [tab({ id: 5, active: true, url: "about:blank" })] }),
  ]);
  expect(state.currentId).toBe(4);
  expect(state.tabs.map(({ id }) => id)).toEqual([1, 2, 3, 4]);

  const pipFocused = toBrowserTabs([
    browserWindow({ tabs: [tab({ id: 1, active: true })] }),
    browserWindow({ focused: true, alwaysOnTop: true, tabs: [tab({ id: 5, active: true })] }),
  ]);
  expect(pipFocused).toEqual({ tabs: [expect.objectContaining({ id: 1 })] });
});

test("shows only icons that load without exposing an incognito tab", () => {
  const icons = (incognito: boolean) =>
    toBrowserTabs([
      browserWindow({
        tabs: [
          tab({ id: 1, incognito, favIconUrl: "https://shop.example/icon.png" }),
          tab({ id: 2, incognito, favIconUrl: "data:image/png;base64,AA==" }),
          tab({ id: 3, incognito, favIconUrl: "chrome://theme/IDR_EXTENSIONS_FAVICON" }),
        ],
      }),
    ]).tabs.map((each) => each.favicon);
  expect(icons(false)).toEqual([
    "https://shop.example/icon.png",
    "data:image/png;base64,AA==",
    undefined,
  ]);
  expect(icons(true)).toEqual([undefined, "data:image/png;base64,AA==", undefined]);
});

test("keeps the last current tab, out of focus, until it closes", () => {
  const shop = {
    id: 1,
    windowId: 1,
    incognito: false,
    title: "Shop",
    url: "https://shop.example/",
  };
  expect(currentTab({ tabs: [shop], currentId: 1 })).toEqual({ tab: shop, focused: true });
  expect(currentTab({ tabs: [shop] }, 1)).toEqual({ tab: shop, focused: false });
  expect(currentTab({ tabs: [] }, 1)).toEqual({ tab: undefined, focused: false });
  expect(currentTab({ tabs: [shop] })).toEqual({ tab: undefined, focused: false });
});

test("reads the browser's tabs and calls back on each tab or focus change until unsubscribed", async () => {
  // fakeBrowser implements no in-memory onMoved, onAttached, or onFocusChanged.
  const [, , focus] = [
    fakeBrowser.tabs.onMoved,
    fakeBrowser.tabs.onAttached,
    fakeBrowser.windows.onFocusChanged,
  ].map((event) => ({
    add: vi.spyOn(event, "addListener").mockImplementation(() => {}),
    remove: vi.spyOn(event, "removeListener").mockImplementation(() => {}),
  }));
  const getAll = vi.spyOn(fakeBrowser.windows, "getAll").mockResolvedValue([
    browserWindow({
      focused: true,
      tabs: [tab({ id: 9, active: true, url: "https://shop.example/" })],
    }),
  ] as never);
  const source = browserTabs();
  const onChange = vi.fn();
  const unwatch = source.watch(onChange);
  expect(focus?.add).toHaveBeenCalled();
  expect((await source.read()).currentId).toBe(9);
  expect(getAll).toHaveBeenCalledWith({ populate: true, windowTypes: ["normal"] });

  await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  expect(onChange).toHaveBeenCalled();
  unwatch();
  expect(focus?.remove).toHaveBeenCalled();
  onChange.mockClear();
  await fakeBrowser.tabs.create({ url: "https://other.example/" });
  expect(onChange).not.toHaveBeenCalled();
});
