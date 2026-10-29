import { expect, test } from "vite-plus/test";
import { NO_INCOGNITO_WINDOW } from "./fake-extension";
import { fakeHistory } from "./fake-history";
import { identity } from "./fake-lifecycle";
import { PRIVATE, SHOP } from "./fake-tabs";
import { button } from "./queries";
import { inPanel, mount, panel, panelText, typeAddress } from "./workspace-panel";

const VISITED = { url: "https://visited.example/page", title: "Visited", lastVisitTime: 3 };
const WITH_A = { ...NO_INCOGNITO_WINDOW, identities: [identity("a")] };

const field = (root: HTMLElement) =>
  panel(root)?.querySelector<HTMLInputElement>('input[role="combobox"]') ?? undefined;
const options = (root: HTMLElement) =>
  [...(panel(root)?.querySelectorAll('[role="option"]') ?? [])].map((each) => each.textContent);
const option = (root: HTMLElement, index: number) =>
  panel(root)?.querySelectorAll<HTMLElement>('[role="option"]')[index];
const press = (root: HTMLElement, key: string) =>
  field(root)?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

test("typing lists open normal tabs, then saved identities, then history, each with its address", async () => {
  const history = fakeHistory([VISITED]);
  const { root } = mount(WITH_A, undefined, [SHOP, PRIVATE], history);
  await expect.poll(() => field(root)).toBeDefined();
  expect(field(root)?.getAttribute("aria-expanded")).toBe("false");
  await typeAddress(root, "e");
  await expect
    .poll(() => options(root))
    .toEqual([
      "ShopOpen tabhttps://shop.example/",
      "ASaved identityhttps://a.example/",
      "VisitedHistoryhttps://visited.example/page",
    ]);
  expect(field(root)?.getAttribute("aria-expanded")).toBe("true");
  expect(panelText(root)).not.toContain(PRIVATE.url);
  expect(button(root, "Use this tab's address")).toBeUndefined();
});

test("history is searched once the typing pauses, with the last text typed", async () => {
  const history = fakeHistory([VISITED]);
  const { root } = mount(NO_INCOGNITO_WINDOW, undefined, [], history);
  await expect.poll(() => field(root)).toBeDefined();
  await typeAddress(root, "v");
  await typeAddress(root, "vi");
  await typeAddress(root, "vis");
  await expect.poll(() => options(root)).toHaveLength(1);
  expect(history.searches).toEqual(["vis"]);
});

test("clicking a suggestion fills the Address, closes the list, and New identity opens it", async () => {
  const { root, sent } = mount(WITH_A, undefined, [SHOP]);
  await expect.poll(() => field(root)).toBeDefined();
  await typeAddress(root, "a.ex");
  await expect.poll(() => options(root)).toHaveLength(1);
  option(root, 0)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  option(root, 0)?.click();
  await expect.poll(() => field(root)?.value).toBe("https://a.example/");
  expect(options(root)).toEqual([]);
  inPanel(root, "New identity")?.click();
  await expect
    .poll(() => sent)
    .toEqual([{ type: "workspace-new-identity", url: "https://a.example/" }]);
});

test("the arrow keys move through the list, Enter picks, and Escape closes it", async () => {
  const { root } = mount(WITH_A, undefined, [SHOP]);
  await expect.poll(() => field(root)).toBeDefined();
  await typeAddress(root, "example");
  await expect.poll(() => options(root)).toHaveLength(2);
  press(root, "ArrowDown");
  press(root, "ArrowDown");
  await expect.poll(() => option(root, 1)?.getAttribute("aria-selected")).toBe("true");
  expect(field(root)?.getAttribute("aria-activedescendant")).toBe(option(root, 1)?.id);
  press(root, "ArrowUp");
  await expect.poll(() => option(root, 0)?.getAttribute("aria-selected")).toBe("true");
  press(root, "ArrowDown");
  press(root, "Enter");
  await expect.poll(() => field(root)?.value).toBe("https://a.example/");
  expect(options(root)).toEqual([]);
  // ArrowDown opens the list again, for the address now in the field.
  press(root, "ArrowDown");
  await expect.poll(() => options(root)).toEqual(["ASaved identityhttps://a.example/"]);
  press(root, "Escape");
  await expect.poll(() => options(root)).toEqual([]);
});

test("a typed address stays as typed: Enter with nothing chosen picks nothing", async () => {
  const { root, sent } = mount(WITH_A, undefined, [SHOP]);
  await expect.poll(() => field(root)).toBeDefined();
  await typeAddress(root, "https://typed.example/");
  press(root, "Enter");
  await expect.poll(() => field(root)?.value).toBe("https://typed.example/");
  inPanel(root, "New identity")?.click();
  await expect
    .poll(() => sent)
    .toEqual([{ type: "workspace-new-identity", url: "https://typed.example/" }]);
});

test("the panel says where suggestions come from and that only the address is copied", async () => {
  const { root } = mount(NO_INCOGNITO_WINDOW);
  await expect
    .poll(() => panelText(root))
    .toContain(
      "Suggestions come from your normal tabs, saved identities, and history; only the address is copied, never cookies or storage.",
    );
});
