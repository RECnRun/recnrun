import { sampleSnapshot } from "@recnrun/domain/testing";
import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { RecordControls } from "@/dashboard/panel/RecordControls";
import type { RecordSurface } from "@/dashboard/panel/RecordControls";
import { startDashboard } from "@/dashboard/start";
import { closePanelMessage, openPanelMessage } from "@/messaging/frame-protocol";
import type { DocumentPictureInPicture } from "@/pip/document-pip";

/** Stands in for the PiP window with a same-origin frame, whose document Preact can portal into. */
interface Opened {
  window: Window;
  close: Mock<() => void>;
}

/** The PiP window opened n-th, failing the test when there is none. */
function nth(opened: Opened[], index: number): Opened {
  const entry = opened[index];
  if (!entry) throw new Error(`No PiP window #${index} was opened.`);
  return entry;
}

function framePip(): DocumentPictureInPicture & { opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    window: null,
    opened,
    async requestWindow() {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const pipWindow = iframe.contentWindow;
      if (!pipWindow) throw new Error("The frame did not load.");
      const close = vi.fn(() => iframe.remove());
      pipWindow.close = close;
      opened.push({ window: pipWindow, close });
      return pipWindow;
    },
  };
}

function mount(surface: RecordSurface) {
  const root = document.createElement("div");
  document.body.append(root);
  render(<RecordControls surface={surface} />, root);
  return root;
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((each) => each.textContent === name);

const panelText = (scope: ParentNode) =>
  scope.querySelector('section[aria-label="Recording panel"]')?.textContent;

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelector("link[data-test]")?.remove();
});

test("without PiP the controls record, pause, and stop in the tab", async () => {
  const root = mount({ kind: "inline" });
  button(root, "Record")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording 00:00");
  button(root, "Pause")?.click();
  await expect.poll(() => panelText(root)).toContain("Paused");
  button(root, "Resume")?.click();
  await expect.poll(() => panelText(root)).toContain("Recording");
  button(root, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
});

test("a top-level dashboard renders the panel into its PiP window with its styles", async () => {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/x.css" });
  link.dataset.test = "";
  document.head.append(link);
  const pip = framePip();
  const focusTab = vi.fn(async () => {});
  const root = mount({ kind: "window", pip, focusTab });

  button(root, "Record")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);
  const pipDocument = nth(pip.opened, 0).window.document;
  await expect.poll(() => panelText(pipDocument)).toContain("Recording");
  expect(pipDocument.head.querySelector("link")?.getAttribute("href")).toBe(
    `${location.origin}/x.css`,
  );

  button(pipDocument, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
  expect(nth(pip.opened, 0).close).toHaveBeenCalled();
  expect(focusTab).toHaveBeenCalled();
});

test("closing the PiP window keeps recording until the panel shows again", async () => {
  const pip = framePip();
  const root = mount({ kind: "window", pip, focusTab: async () => {} });
  button(root, "Record")?.click();
  await expect.poll(() => pip.opened.length).toBe(1);

  nth(pip.opened, 0).window.dispatchEvent(new Event("pagehide"));
  await expect
    .poll(() => root.querySelector('[role="status"]')?.textContent)
    .toBe("The panel is closed. Recording continues.");
  button(root, "Show the panel")?.click();
  await expect.poll(() => pip.opened.length).toBe(2);
  await expect.poll(() => panelText(nth(pip.opened, 1).window.document)).toContain("Recording");

  nth(pip.opened, 1).window.dispatchEvent(new Event("pagehide"));
  await expect.poll(() => button(root, "Stop")).toBeDefined();
  button(root, "Stop")?.click();
  await expect.poll(() => button(root, "Record")).toBeDefined();
});

test("a refused PiP window shows why", async () => {
  const pip: DocumentPictureInPicture = {
    window: null,
    requestWindow: () => Promise.reject(new Error("Document PiP requires user activation")),
  };
  const root = mount({ kind: "window", pip, focusTab: async () => {} });
  button(root, "Record")?.click();
  await expect
    .poll(() => root.querySelector('[role="alert"]')?.textContent)
    .toBe("Document PiP requires user activation");
});

test("a framed dashboard asks the site for the panel and the panel view asks it to close", async () => {
  const posted: unknown[] = [];
  window.addEventListener("message", (event) => posted.push(event.data));
  const framed = (search: string) =>
    Object.assign(new EventTarget(), {
      parent: window,
      document,
      location: { ancestorOrigins: [location.origin], search },
    }) as unknown as Window;

  const dashboard = document.createElement("div");
  startDashboard(dashboard, async () => sampleSnapshot(), framed(""));
  button(dashboard, "Record")?.click();
  await expect.poll(() => posted).toContainEqual(openPanelMessage());

  const panel = document.createElement("div");
  startDashboard(panel, async () => sampleSnapshot(), framed("?view=panel"));
  await expect.poll(() => panelText(panel)).toContain("Recording");
  button(panel, "Stop")?.click();
  await expect.poll(() => posted).toContainEqual(closePanelMessage());
});
