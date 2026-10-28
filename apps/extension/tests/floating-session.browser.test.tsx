import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import type { RecordingStore } from "@/ports/recording-store";
import type { TabSource } from "@/ports/tabs";
import { FloatingSession } from "@/views/FloatingSession";
import { memoryRecordingStore } from "./fake-extension";
import { DOCS, PRIVATE, SHOP, fakeTabs } from "./fake-tabs";
import { button, panelText } from "./queries";

async function runningStore(): Promise<RecordingStore> {
  const store = memoryRecordingStore();
  await store.write({ tabId: 7, status: "recording", banked: 0, since: Date.now() });
  return store;
}

let ended = 0;

/** The session as the dashboard floats it in its PiP window, which counts the ends it asks for. */
function mount(store: RecordingStore, tabs: TabSource = fakeTabs({ tabs: [] }).source) {
  const root = document.body.appendChild(document.createElement("div"));
  render(<FloatingSession store={store} tabs={tabs} onEnd={() => (ended += 1)} />, root);
  return root;
}

afterEach(() => {
  ended = 0;
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("in the PiP window, the session pauses, resumes, and ends when stopped", async () => {
  const store = await runningStore();
  const root = mount(store);
  await expect.poll(() => panelText(root)).toContain("Recording 00:00");
  const logo = root.querySelector<HTMLImageElement>('section img[alt="RECnRun"]');
  await expect.poll(() => logo?.complete && logo.naturalWidth).toBeGreaterThan(0);

  button(root, "Pause")?.click();
  await expect.poll(() => panelText(root)).toContain("Paused");
  button(root, "Resume")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording");
  expect(ended).toBe(0);

  button(root, "Stop")?.click();
  await expect.poll(() => ended).toBe(1);
  expect(await store.read()).toBeNull();
});

test("stopped from another view, the session still ends its window", async () => {
  const store = await runningStore();
  const root = mount(store);
  await expect.poll(() => panelText(root)).toContain("Recording");
  await store.write(null);
  await expect.poll(() => ended).toBe(1);
});

const region = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`section[aria-label="${name}"]`)?.textContent ?? undefined;

test("shows the tab in focus apart from the recorded one, and never retargets the session", async () => {
  const store = await runningStore();
  const tabs = fakeTabs({ tabs: [SHOP, DOCS, PRIVATE], currentId: SHOP.id });
  const root = mount(store, tabs.source);
  await expect.poll(() => region(root, "Current tab")).toContain("Recorded");
  expect(region(root, "Current tab")).toContain("https://shop.example/");
  expect(region(root, "Recorded tab")).toBeUndefined();

  tabs.change({ tabs: [SHOP, DOCS, PRIVATE], currentId: PRIVATE.id });
  await expect.poll(() => region(root, "Current tab")).toContain("Private");
  expect(region(root, "Current tab")).toContain("Incognito");
  expect(region(root, "Current tab")).not.toContain("Recorded");
  expect(region(root, "Recorded tab")).toContain("Shop");
  expect((await store.read())?.tabId).toBe(SHOP.id);

  tabs.change({ tabs: [DOCS, PRIVATE], currentId: PRIVATE.id });
  await expect
    .poll(() => region(root, "Recorded tab"))
    .toBe("Recorded tabThe recorded tab was closed.");
});

test("with the focus outside the browser, the last tab shown stays until it closes", async () => {
  const tabs = fakeTabs({ tabs: [SHOP, DOCS], currentId: DOCS.id });
  const root = mount(await runningStore(), tabs.source);
  await expect.poll(() => region(root, "Current tab")).toContain("Docs");
  expect(region(root, "Current tab")).not.toContain("Not in focus");

  tabs.change({ tabs: [SHOP, DOCS] });
  await expect.poll(() => region(root, "Current tab")).toContain("Not in focus");
  expect(region(root, "Current tab")).toContain("Docs");

  tabs.change({ tabs: [SHOP] });
  await expect.poll(() => region(root, "Current tab")).toBe("Current tabNo tab in focus.");
});

test("a burst of tab events reads the tabs once more, not once per event", async () => {
  const tabs = fakeTabs({ tabs: [SHOP], currentId: SHOP.id });
  const root = mount(await runningStore(), tabs.source);
  await expect.poll(() => region(root, "Current tab")).toContain("Shop");
  const before = tabs.reads();
  for (let event = 0; event < 5; event += 1)
    tabs.change({ tabs: [SHOP, DOCS], currentId: SHOP.id });
  await expect.poll(() => tabs.reads() - before).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(tabs.reads() - before).toBe(2);
});
