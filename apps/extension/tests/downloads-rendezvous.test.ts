import { describe, expect, test } from "vite-plus/test";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence } from "@/p2p/folder-rendezvous";
import { fileUrlFor, probePath, readTolerant } from "@/p2p/downloads-rendezvous";
import { PEER } from "./fake-peer";

const NOW = 1_700_000_000_000;

function presence(overrides: Partial<Presence> = {}): Presence {
  return {
    profileId: PEER,
    displayName: "Desk",
    fingerprint: "AB:CD:EF",
    createdAt: NOW - 1000,
    expiresAt: NOW + PRESENCE_TTL_MS / 2,
    ...overrides,
  };
}

describe("probePath", () => {
  test("puts the probe under RECnRun/poc/<namespace>/", () => {
    expect(probePath("lab-1")).toBe("RECnRun/poc/lab-1/probe.json");
    expect(probePath("a".repeat(40))).toBe(`RECnRun/poc/${"a".repeat(40)}/probe.json`);
  });

  test.each(["", "A", "a/b", "..", "a b", "a%20", "a#b", "a?b", "a".repeat(41), "日本"])(
    "refuses the namespace %j",
    (namespace) => {
      expect(() => probePath(namespace)).toThrow(/namespace/);
    },
  );
});

describe("fileUrlFor", () => {
  test("turns a POSIX path into a file URL, percent-encoding each segment", () => {
    expect(fileUrlFor("/home/me/Downloads/RECnRun/poc/a/probe.json")).toBe(
      "file:///home/me/Downloads/RECnRun/poc/a/probe.json",
    );
    expect(fileUrlFor("/Users/me/My Downloads/a%b#c?d é.json")).toBe(
      "file:///Users/me/My%20Downloads/a%25b%23c%3Fd%20%C3%A9.json",
    );
  });

  test("turns a Windows drive path into a file URL with forward slashes", () => {
    expect(fileUrlFor("C:\\Users\\me\\Downloads\\RECnRun\\poc\\a\\probe.json")).toBe(
      "file:///C:/Users/me/Downloads/RECnRun/poc/a/probe.json",
    );
    expect(fileUrlFor("d:/Data/a b.json")).toBe("file:///d:/Data/a%20b.json");
  });

  test("turns a Windows UNC path into a file URL naming its host", () => {
    expect(fileUrlFor("\\\\server\\share\\a b.json")).toBe("file://server/share/a%20b.json");
  });

  test.each([
    "relative/probe.json",
    "",
    "/home/me/../etc/passwd",
    "/home/./me",
    "C:\\Users\\..\\x",
    "/home//me",
    "\\\\server",
    "C:relative",
  ])("refuses %j", (path) => {
    expect(() => fileUrlFor(path)).toThrow(/path/);
  });
});

describe("readTolerant", () => {
  const previous = presence();

  test("takes a fresh valid publication", () => {
    const next = presence({ createdAt: NOW, expiresAt: NOW + PRESENCE_TTL_MS });
    expect(readTolerant(JSON.stringify(next), previous, NOW)).toEqual({
      publication: next,
      reason: "fresh",
    });
    expect(readTolerant(JSON.stringify(next), undefined, NOW).publication).toEqual(next);
  });

  test("keeps the previous publication while the file is absent or unreadable", () => {
    expect(readTolerant(undefined, previous, NOW)).toEqual({
      publication: previous,
      reason: "absent",
    });
    expect(readTolerant(undefined, undefined, NOW)).toEqual({
      publication: undefined,
      reason: "absent",
    });
  });

  test.each([
    ["empty", ""],
    ["empty", "  \n"],
    ["partial", '{"profileId":"22222222-2222'],
    ["partial", JSON.stringify(presence()).slice(0, -1)],
  ])("keeps the previous publication when the file is %s while being replaced", (reason, text) => {
    expect(readTolerant(text, previous, NOW)).toEqual({ publication: previous, reason });
  });

  test("keeps the previous publication when the file holds another shape or an old version", () => {
    const oldShape = JSON.stringify({ version: 0, profileId: PEER });
    expect(readTolerant(oldShape, previous, NOW)).toEqual({
      publication: previous,
      reason: "invalid",
    });
    const older = presence({ createdAt: previous.createdAt - 1 });
    expect(readTolerant(JSON.stringify(older), previous, NOW)).toEqual({
      publication: previous,
      reason: "older",
    });
  });

  test("refuses a file over the size limit and an expiry beyond one TTL", () => {
    const huge = JSON.stringify({ ...presence(), displayName: "x".repeat(200 * 1024) });
    expect(readTolerant(huge, previous, NOW).reason).toBe("invalid");
    const farFuture = presence({ createdAt: NOW, expiresAt: NOW + PRESENCE_TTL_MS + 1 });
    expect(readTolerant(JSON.stringify(farFuture), previous, NOW)).toEqual({
      publication: previous,
      reason: "invalid",
    });
  });

  test("the previous publication stands only until its TTL", () => {
    const later = previous.expiresAt;
    expect(readTolerant(undefined, previous, later)).toEqual({
      publication: undefined,
      reason: "absent",
    });
    expect(readTolerant("{", previous, later - 1).publication).toEqual(previous);
  });

  test("an expired publication in the file is not current", () => {
    const expired = presence({ createdAt: NOW, expiresAt: NOW - 1 });
    expect(readTolerant(JSON.stringify(expired), previous, NOW)).toEqual({
      publication: undefined,
      reason: "expired",
    });
  });
});
