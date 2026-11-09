import { describe, expect, test } from "vite-plus/test";
import { parseHeartbeat, parseStatus, track } from "./site/heartbeat.js";

const NOW = 1_800_000_000_000;
const text = (fields: Record<string, string | number> = {}) =>
  [
    "recnrun-lab-heartbeat v1",
    ...Object.entries({
      session: "0123456789abcdef",
      seq: 5,
      at: NOW / 1000,
      state: "idle",
      paired: "none",
      launcher: "1",
      extension: "1.0.0",
      ...fields,
    }).map(([key, value]) => `${key}=${value}`),
    "",
  ].join("\n");

describe("parseHeartbeat", () => {
  test("reads the key=value lines", () => {
    expect(parseHeartbeat(text())).toMatchObject({
      session: "0123456789abcdef",
      seq: 5,
      state: "idle",
    });
  });

  test("refuses a wrong header, a missing field, a bad number and an unknown state", () => {
    expect(parseHeartbeat(text().replace("v1", "v2"))).toBeNull();
    expect(parseHeartbeat(text().replace(/seq=5\n/, ""))).toBeNull();
    expect(parseHeartbeat(text({ seq: "x" }))).toBeNull();
    expect(parseHeartbeat(text({ state: "dancing" }))).toBeNull();
    expect(parseHeartbeat(text({ paired: "maybe" }))).toBeNull();
  });

  test("accepts a pairing fingerprint of 64 hex", () => {
    expect(parseHeartbeat(text({ paired: "a".repeat(64) }))?.paired).toBe("a".repeat(64));
  });
});

describe("track", () => {
  test("a fresh heartbeat is not stale", () => {
    expect(track(null, text(), NOW).stale).toBe(false);
  });

  test("a missing file is stale and has no heartbeat", () => {
    expect(track(null, null, NOW)).toMatchObject({ heartbeat: null, stale: true });
  });

  test("stale when seq has not advanced for more than 6 s", () => {
    const first = track(null, text(), NOW);
    expect(track(first, text(), NOW + 5_000).stale).toBe(false);
    expect(track(first, text({ at: NOW / 1000 + 7 }), NOW + 7_000).stale).toBe(true);
  });

  test("an advancing seq keeps it fresh", () => {
    const first = track(null, text(), NOW);
    const next = track(first, text({ seq: 6, at: NOW / 1000 + 7 }), NOW + 7_000);
    expect(next.stale).toBe(false);
  });

  test("stale when at is in the past or in the future of the page's clock", () => {
    expect(track(null, text({ at: NOW / 1000 - 7 }), NOW).stale).toBe(true);
    expect(track(null, text({ at: NOW / 1000 + 6 }), NOW).stale).toBe(true);
    expect(track(null, text({ at: NOW / 1000 - 5 }), NOW).stale).toBe(false);
    expect(track(null, text({ at: NOW / 1000 + 4 }), NOW).stale).toBe(false);
  });

  test("a new session is reported, even across a missing file", () => {
    const first = track(null, text(), NOW);
    const gone = track(first, null, NOW + 2_000);
    const back = track(gone, text({ session: "fedcba9876543210", seq: 1 }), NOW + 4_000);
    expect(back.sessionChanged).toBe(true);
    expect(first.sessionChanged).toBe(false);
  });
});

describe("parseStatus", () => {
  const status = (fields: Record<string, string>) =>
    [
      "recnrun-lab-status v1",
      ...Object.entries({
        request: "r1",
        session: "0123456789abcdef",
        state: "refused",
        ...fields,
      }).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n");

  test("reads a refusal with its code verbatim", () => {
    expect(parseStatus(status({ code: "BUSY", at: "5", seq: "2" }))).toMatchObject({
      state: "refused",
      code: "BUSY",
    });
  });

  test("a progress state needs no code", () => {
    expect(parseStatus(status({ state: "installing" }))?.state).toBe("installing");
  });

  test("a wrong header, an unknown state or an unknown code is refused", () => {
    expect(parseStatus("nope\nstate=answered\n")).toBeNull();
    expect(parseStatus(status({ state: "dancing" }))).toBeNull();
    expect(parseStatus(status({ code: "FLOOD" }))).toBeNull();
  });
});
