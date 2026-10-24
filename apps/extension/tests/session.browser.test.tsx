import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { closePanelMessage } from "@/messaging/frame-protocol";
import { startSession } from "@/session/start";
import type { RecordingStore } from "@/views/recording";
import { memoryRecordingStore } from "./dashboard-data";
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

function mount(store: RecordingStore, ancestors = [location.origin]) {
  const root = document.body.appendChild(document.createElement("div"));
  startSession(root, { recordings: store }, framedPage(ancestors));
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
