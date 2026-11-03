import {
  MAX_DOM_SNAPSHOT_BYTES,
  MAX_SCREENSHOT_BYTES,
  type SnapshotMilestone,
  type SnapshotPart,
  type SnapshotPayload,
} from "@recnrun/protocol";
import type { Captured, PageCapture, ReplayDriver } from "./driver.ts";
import type { Recorder, ReplayBlobs } from "./record.ts";
import { redact } from "./scope.ts";

/** How long one capture may take before its parts are unavailable. */
export const SNAPSHOT_TIMEOUT_MS = 5000;

/** Captures a milestone of a step and journals it as a `snapshot` event. */
export type Snapshotter = (stepId: string, milestone: SnapshotMilestone) => Promise<void>;

type Capture = NonNullable<ReplayDriver["capture"]>;

const unavailable = (reason: "no-tab" | "over-cap" | "capture-failed"): SnapshotPart => ({
  condition: "unavailable",
  reason,
});

function domPart(
  html: Captured<string>,
  blobs: ReplayBlobs,
  secrets: readonly string[],
): Promise<SnapshotPart> | SnapshotPart {
  if (!html.ok) return unavailable("capture-failed");
  const text = redact(html.value, secrets);
  return blobs.put(text, {
    mime: "text/html",
    encoding: "utf8",
    maxBytes: MAX_DOM_SNAPSHOT_BYTES,
  });
}

// A PNG cut at the cap would not decode, so an oversized screenshot is not stored at all.
function screenshotPart(
  png: Captured<Uint8Array>,
  blobs: ReplayBlobs,
): Promise<SnapshotPart> | SnapshotPart {
  if (!png.ok) return unavailable("capture-failed");
  if (png.value.length > MAX_SCREENSHOT_BYTES) return unavailable("over-cap");
  const meta = { mime: "image/png", encoding: "binary", maxBytes: MAX_SCREENSHOT_BYTES } as const;
  return blobs.put(png.value, meta);
}

async function tryCapture(capture: Capture): Promise<PageCapture | undefined> {
  try {
    return await capture({ timeoutMs: SNAPSHOT_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

/** The DOM and screenshot of the current tab, stored as blobs; a capture never fails the step. */
async function snapshotOf(
  capture: Capture,
  blobs: ReplayBlobs,
  milestone: SnapshotMilestone,
  secrets: readonly string[],
): Promise<SnapshotPayload> {
  const page = await tryCapture(capture);
  if (!page) {
    return {
      milestone,
      dom: unavailable("capture-failed"),
      screenshot: unavailable("capture-failed"),
    };
  }
  if (!page.tab)
    return { milestone, dom: unavailable("no-tab"), screenshot: unavailable("no-tab") };
  const dom = await domPart(page.html, blobs, secrets);
  const screenshot = await screenshotPart(page.screenshot, blobs);
  return { milestone, url: redact(page.url, secrets), dom, screenshot };
}

/** Snapshots need a driver that captures and a run with a blob store; otherwise none are taken. */
export function snapshotter(
  driver: ReplayDriver,
  recorder: Recorder,
  secrets: readonly string[],
): Snapshotter | undefined {
  const { blobs } = recorder;
  if (!driver.capture || !blobs) return undefined;
  const capture: Capture = driver.capture.bind(driver);
  return async (stepId, milestone) => {
    await recorder.snapshot(stepId, await snapshotOf(capture, blobs, milestone, secrets));
  };
}
