import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { closePanelMessage } from "@/messaging/frame-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type { TabSource } from "@/ports/tabs";
import { startSession } from "@/session/start";
import { fakeExtension, memoryRecordingStore } from "./fake-extension";
import { DOCS, PRIVATE, SHOP, fakeTabs } from "./fake-tabs";
import { button, panelText } from "./queries";

async function runningStore(): Promise<RecordingStore> {
  const store = memoryRecordingStore();
  await store.write({ tabId: 7, status: "recording", banked: 0, since: Date.now() });
  return store;
}

/** A session page framed by `ancestors`, as the site's PiP window or a hostile page would frame it. */
function framedPage(ancestors: string[]) {
  return Object.assign(new EventTarget(), {
    parent: window,
    document,
    location: { ancestorOrigins: ancestors, origin: "chrome-extension://test-id" },
  }) as unknown as Window;
}

function mount(store: RecordingStore, ancestors = [location.origin], tabs?: TabSource) {
  const root = document.body.appendChild(document.createElement("div"));
  const services = fakeExtension(tabs ? { recordings: store, tabs } : { recordings: store });
  startSession(root, services, framedPage(ancestors));
  return root;
}

const posted: unknown[] = [];
const onMessage = (event: MessageEvent) => posted.push(event.data);

afterEach(() => {
  window.removeEventListener("message", onMessage);
  posted.length = 0;
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("in the PiP window, the session pauses, resumes, and asks to close when stopped", async () => {
  window.addEventListener("message", onMessage);
  const store = await runningStore();
  const root = mount(store);
  await expect.poll(() => panelText(root)).toContain("Recording 00:00");
  const logo = root.querySelector<HTMLImageElement>('section img[alt="RECnRun"]');
  await expect.poll(() => logo?.complete && logo.naturalWidth).toBeGreaterThan(0);

  button(root, "Pause")?.click();
  await expect.poll(() => panelText(root)).toContain("Paused");
  button(root, "Resume")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording");
  expect(posted).not.toContainEqual(closePanelMessage());

  button(root, "Stop")?.click();
  await expect.poll(() => posted).toContainEqual(closePanelMessage());
  expect(await store.read()).toBeNull();
});

test("stopped from another view, the session still asks to close its window", async () => {
  window.addEventListener("message", onMessage);
  const store = await runningStore();
  const root = mount(store);
  await expect.poll(() => panelText(root)).toContain("Recording");
  await store.write(null);
  await expect.poll(() => posted).toContainEqual(closePanelMessage());
});

test("the session refuses to render inside a foreign ancestor", async () => {
  const root = mount(await runningStore(), ["https://evil.example"]);
  expect(root.textContent).toContain("https://evil.example");
  expect(panelText(root)).toBeUndefined();
});

test("opened on its own, the session page points to the site", async () => {
  const root = mount(await runningStore(), []);
  expect(root.querySelector('[role="status"]')?.textContent).toBe(
    "Open recnrun.com to use RECnRun.",
  );
  expect(panelText(root)).toBeUndefined();
});

const region = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`section[aria-label="${name}"]`)?.textContent ?? undefined;

test("shows the tab in focus apart from the recorded one, and never retargets the session", async () => {
  const store = await runningStore();
  const tabs = fakeTabs({ tabs: [SHOP, DOCS, PRIVATE], currentId: SHOP.id });
  const root = mount(store, [location.origin], tabs.source);
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
  const root = mount(await runningStore(), [location.origin], tabs.source);
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
  const root = mount(await runningStore(), [location.origin], tabs.source);
  await expect.poll(() => region(root, "Current tab")).toContain("Shop");
  const before = tabs.reads();
  for (let event = 0; event < 5; event += 1)
    tabs.change({ tabs: [SHOP, DOCS], currentId: SHOP.id });
  await expect.poll(() => tabs.reads() - before).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(tabs.reads() - before).toBe(2);
});
