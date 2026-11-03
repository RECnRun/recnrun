import {
  SnapshotPayloadSchema,
  type BodyRef,
  type Event,
  type SnapshotPart,
  type SnapshotPayload,
} from "../../packages/protocol/src/index.ts";
import { expect, FIXTURE_ORIGIN, test } from "./fixtures/fixture-app.ts";
import { flowOf, replayStored } from "./fixtures/replay.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function payloadOf(event: Event): SnapshotPayload {
  const result = SnapshotPayloadSchema["~standard"].validate(event.payload);
  if (result instanceof Promise || result.issues) throw new Error(`Invalid snapshot ${event.id}`);
  return result.value;
}

function captured(part: SnapshotPart): BodyRef {
  if (part.condition === "unavailable") throw new Error(`Not captured: ${part.reason}`);
  return part;
}

test("a failed step keeps its page and screenshot from before, after, and at its failure", async ({
  chrome,
}) => {
  const flow = flowOf("snapshots", [
    { id: "open", action: "navigate", url: `${FIXTURE_ORIGIN}/routes/replay` },
    { id: "missing", action: "click", target: { testId: "missing" }, timeoutMs: 1_500 },
  ]);
  const { outcome, stored, blobs } = await replayStored(chrome.wsEndpoint, flow);
  expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
  const snapshots = stored.journal.events
    .filter((event) => event.category === "snapshot" && event.stepId === "missing")
    .map(payloadOf);
  expect(snapshots.map(({ milestone }) => milestone)).toEqual(["before", "after", "failure"]);
  for (const { milestone, url, dom, screenshot } of snapshots) {
    expect(url, milestone).toBe(`${FIXTURE_ORIGIN}/routes/replay`);
    const page = captured(dom);
    const html = blobs.get(page.sha256)?.toString("utf8") ?? "";
    expect(page).toMatchObject({ mime: "text/html", encoding: "utf8", condition: "captured" });
    expect(page.size).toBe(Buffer.byteLength(html));
    expect(html).toContain("<title>Replay · RECnRun fixture</title>");
    expect(html).toContain('data-testid="intro"');
    const image = captured(screenshot);
    const png = blobs.get(image.sha256) ?? Buffer.alloc(0);
    expect(image).toMatchObject({ mime: "image/png", encoding: "binary", condition: "captured" });
    expect(image.size).toBe(png.length);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE), milestone).toBe(true);
    console.log(`Snapshot ${milestone}: page starts ${JSON.stringify(html.slice(0, 30))}`);
  }
});
