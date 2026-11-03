import type { Artifact, Event } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  VIEWER_CSP,
  imageSource,
  snapshotRows,
  unavailable,
  viewerDocument,
} from "@/features/run/viewer";
import { Snapshots } from "@/features/run/Snapshots";
import { NOW, fakeApi, renderWith } from "./fake-api";

const DOM_SHA = "d".repeat(64);
const PNG_SHA = "e".repeat(64);
const dom = {
  sha256: DOM_SHA,
  mime: "text/html",
  encoding: "utf8",
  size: 9,
  condition: "captured",
};
const png = {
  sha256: PNG_SHA,
  mime: "image/png",
  encoding: "binary",
  size: 4,
  condition: "captured",
};
const noTab = { condition: "unavailable", reason: "no-tab" };

let seq = 0;

function event(stepId: string, payload: Record<string, unknown>, category = "snapshot") {
  seq += 1;
  return {
    schemaVersion: 1,
    id: `engine:replay#${seq}`,
    runId: "run-1",
    seq,
    source: "engine",
    producer: "engine:replay",
    timestamp: NOW,
    targetId: null,
    frameId: null,
    documentId: null,
    stepId,
    category,
    type: category === "snapshot" ? "captured" : "step.started",
    payload,
  } as Event;
}

const html = (data: string): Artifact => ({
  sha256: DOM_SHA,
  mime: "text/html",
  encoding: "utf8",
  size: data.length,
  data,
});
const SCREENSHOT: Artifact = {
  sha256: PNG_SHA,
  mime: "image/png",
  encoding: "binary",
  size: 4,
  data: "iVBORw==",
};

describe("the viewer's view model", () => {
  test("keeps only snapshot events that parse, in journal order", () => {
    const rows = snapshotRows([
      event("open", { index: 0 }, "step"),
      event("open", { milestone: "before", dom, screenshot: png }),
      event("open", { milestone: "sideways", dom, screenshot: png }),
      event("send", {
        milestone: "failure",
        url: "http://127.0.0.1:4600/",
        dom: noTab,
        screenshot: png,
      }),
    ]);
    expect(rows.map(({ stepId, milestone, url }) => [stepId, milestone, url])).toEqual([
      ["open", "before", undefined],
      ["send", "failure", "http://127.0.0.1:4600/"],
    ]);
    const [, failure] = rows;
    expect(failure && unavailable(failure.dom)).toBe("no tab was open");
    expect(failure && unavailable(failure.screenshot)).toBeUndefined();
  });

  test("puts its own policy ahead of the captured page, and that policy allows no script", () => {
    const document = viewerDocument('<script>alert(1)</script><p title="a&b">x</p>');
    expect(document.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(document).toContain(`content="${VIEWER_CSP}"`);
    expect(document.endsWith('<script>alert(1)</script><p title="a&b">x</p>')).toBe(true);
    expect(VIEWER_CSP).toContain("default-src 'none'");
    expect(VIEWER_CSP).toContain("form-action 'none'");
    expect(VIEWER_CSP).not.toMatch(/script-src|unsafe-eval|http/);
  });

  test("keeps a captured doctype first, so the page renders in standards mode", () => {
    const html = '<!DOCTYPE html><html lang="en"><head><title>x</title></head></html>';
    const document = viewerDocument(html);
    expect(document.startsWith("<!DOCTYPE html>\n<meta http-equiv")).toBe(true);
    expect(document.endsWith('<html lang="en"><head><title>x</title></head></html>')).toBe(true);
    const parsed = new DOMParser().parseFromString(document, "text/html");
    expect(parsed.compatMode).toBe("CSS1Compat");
    expect(parsed.head.firstElementChild?.getAttribute("http-equiv")).toBe(
      "Content-Security-Policy",
    );
  });

  test("shows only a PNG screenshot as an image", () => {
    expect(imageSource(SCREENSHOT)).toBe("data:image/png;base64,iVBORw==");
    expect(imageSource(html("<p/>"))).toBeUndefined();
  });
});

function snapshotsScreen(events: Event[], captured = "<p>Captured</p>") {
  const fake = fakeApi({
    // Two pages, so the screen follows the cursor.
    "run.queryEvents": ({ cursor }) =>
      cursor === undefined
        ? { events: events.slice(0, 1), nextCursor: "1" }
        : { events: events.slice(1) },
    "run.getArtifact": ({ sha256 }) => (sha256 === PNG_SHA ? SCREENSHOT : html(captured)),
  });
  renderWith(fake.api, <Snapshots runId="run-1" />);
  return fake;
}

const row = (name: string) => page.getByRole("listitem", { name: `Snapshot ${name}` });

describe("the snapshots card", () => {
  test("renders a captured page in an empty sandbox where its script never runs", async () => {
    const hostile = `<p>Captured</p><script>parent.postMessage("viewer-script-ran", "*")</script>`;
    const messages: unknown[] = [];
    addEventListener("message", ({ data }) => messages.push(data));
    const fake = snapshotsScreen(
      [
        event("open", { milestone: "before", dom: noTab, screenshot: png }),
        event("send", { milestone: "failure", dom, screenshot: png }),
      ],
      hostile,
    );
    await expect.element(row("open, before")).toMatchTextContent("Page: no tab was open");
    await row("send, failure").getByRole("button", { name: "View page" }).click();
    const frame = page.getByTitle("Captured page of send, failure");
    await expect.element(frame).toBeVisible();
    const iframe = frame.element() as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("");
    expect(iframe.srcdoc).toBe(viewerDocument(hostile));
    // An opaque origin: the UI cannot reach into the captured page either.
    await expect.poll(() => iframe.contentDocument).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages).not.toContain("viewer-script-ran");
    expect(fake.paramsOf("run.queryEvents")).toEqual([
      { runId: "run-1", category: "snapshot", limit: 1000 },
      { runId: "run-1", category: "snapshot", limit: 1000, cursor: "1" },
    ]);
    expect(fake.paramsOf("run.getArtifact")).toEqual([{ runId: "run-1", sha256: DOM_SHA }]);
  });

  test("shows a screenshot as an image and says when there is nothing to show", async () => {
    snapshotsScreen([event("send", { milestone: "after", dom, screenshot: png })]);
    await row("send, after").getByRole("button", { name: "View screenshot" }).click();
    const image = page.getByRole("img", { name: "Screenshot of send, after" });
    await expect.element(image).toHaveAttribute("src", "data:image/png;base64,iVBORw==");
    await expect
      .element(row("send, after").getByRole("button", { name: "View screenshot" }))
      .toHaveAttribute("aria-pressed", "true");
    snapshotsScreen([]);
    await expect.element(page.getByText("This run captured no snapshots.")).toBeVisible();
  });
});
