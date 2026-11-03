import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  ArtifactRequestSchema,
  ArtifactSchema,
  DEFAULT_MAX_BLOB_BYTES,
  EventSchema,
  EVENT_CATEGORIES,
  MAX_DOM_SNAPSHOT_BYTES,
  MAX_SCREENSHOT_BYTES,
  SnapshotEventSchema,
  SnapshotPartSchema,
} from "../src/index.ts";

const SHA = "b".repeat(64);
const html = { sha256: SHA, mime: "text/html", encoding: "utf8", size: 120, condition: "captured" };
const png = { sha256: SHA, mime: "image/png", encoding: "binary", size: 96, condition: "captured" };

const snapshot = (payload: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: "engine:replay#3",
  runId: "run-1",
  seq: 3,
  source: "engine",
  producer: "engine:replay",
  timestamp: "2026-11-03T10:00:00.000Z",
  actor: "replay",
  component: "engine",
  targetId: null,
  frameId: null,
  documentId: null,
  stepId: "submit",
  category: "snapshot",
  type: "captured",
  payload,
});

describe("snapshot events", () => {
  test("reference the DOM and the screenshot of a milestone as blobs", () => {
    const url = "http://127.0.0.1:4600/";
    const event = snapshot({ milestone: "before", url, dom: html, screenshot: png });
    expect(v.is(SnapshotEventSchema, event)).toBe(true);
    expect(v.is(EventSchema, event)).toBe(true);
    expect(EVENT_CATEGORIES).toContain("snapshot");
  });

  test("say why a part is unavailable instead of referencing a blob", () => {
    const unavailable = { condition: "unavailable", reason: "no-tab" };
    expect(v.is(SnapshotPartSchema, unavailable)).toBe(true);
    const event = snapshot({ milestone: "failure", dom: unavailable, screenshot: unavailable });
    expect(v.is(SnapshotEventSchema, event)).toBe(true);
  });

  test("reject an unknown milestone, an unlisted reason, and a blob with a reason", () => {
    const during = snapshot({ milestone: "during", dom: html, screenshot: png });
    expect(v.is(SnapshotEventSchema, during)).toBe(false);
    expect(v.is(SnapshotPartSchema, { condition: "unavailable", reason: "tired" })).toBe(false);
    expect(v.is(SnapshotPartSchema, { ...html, reason: "no-tab" })).toBe(false);
  });

  test("cap DOM snapshots and screenshots above the network body cap", () => {
    expect(MAX_DOM_SNAPSHOT_BYTES).toBe(2_097_152);
    expect(MAX_SCREENSHOT_BYTES).toBe(8_388_608);
    expect(MAX_DOM_SNAPSHOT_BYTES).toBeGreaterThan(DEFAULT_MAX_BLOB_BYTES);
  });
});

describe("run.getArtifact", () => {
  test("asks for one blob of a run by its sha256", () => {
    expect(v.is(ArtifactRequestSchema, { runId: "run-1", sha256: SHA })).toBe(true);
    expect(v.is(ArtifactRequestSchema, { runId: "run-1", sha256: "../summary.json" })).toBe(false);
  });

  test("answers the bytes as text or base64 with the blob's MIME and size", () => {
    const text = { sha256: SHA, mime: "text/html", encoding: "utf8", size: 4, data: "<p/>" };
    expect(v.is(ArtifactSchema, text)).toBe(true);
    expect(v.is(ArtifactSchema, { ...text, encoding: "binary", data: "iVBORw0K" })).toBe(true);
    expect(v.is(ArtifactSchema, { ...text, size: -1 })).toBe(false);
  });
});
