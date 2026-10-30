import type { SkippedOrigin } from "@recnrun/domain";
import { expect, test, vi } from "vite-plus/test";
import { SUMMARY, identity } from "./fake-lifecycle";
import { setUp } from "./lifecycle-harness";

const CDN = "https://cdn.example";
const SSO = "https://sso.example";
const REASON = "The page did not load (net::ERR_EMPTY_RESPONSE).";
const note = (origin: string, work: "save" | "restore", kept = true): SkippedOrigin => ({
  origin,
  work,
  step: "navigate",
  reason: REASON,
  kept,
});

test("a save names on its identity, and in the journal, each visited origin it left out", async () => {
  const { lifecycle, chrome, journal, saved } = setUp({ open: "a" });
  const skipped = [note(CDN, "save", false)];
  vi.mocked(chrome.effects.capture).mockResolvedValueOnce({ ...SUMMARY, captureId: "c", skipped });
  await lifecycle.switchTo("b");
  expect(saved("a")?.skipped).toEqual(skipped);
  expect(journal.written.find(({ step }) => step === "persist")).toMatchObject({ skipped });
});

test("a save that left nothing out clears the notes of the last one", async () => {
  const a = { ...identity("a"), skipped: [note(CDN, "save"), note(SSO, "restore")] };
  const { lifecycle, saved } = setUp({ open: "a", saved: [a, identity("b")] });
  await lifecycle.switchTo("b");
  expect(saved("a")).not.toHaveProperty("skipped");
});

test("a start names the origins it could not restore, keeping the last save's notes", async () => {
  const b = { ...identity("b"), skipped: [note(CDN, "save"), note(CDN, "restore")] };
  const { lifecycle, chrome, saved } = setUp({ saved: [identity("a"), b] });
  vi.mocked(chrome.effects.start).mockResolvedValueOnce({
    timings: [],
    skipped: [note(SSO, "restore")],
  });
  await lifecycle.resume("b");
  expect(saved("b")?.skipped).toEqual([note(CDN, "save"), note(SSO, "restore")]);
});

test("a start that restored everything drops the last start's notes only", async () => {
  const b = { ...identity("b"), skipped: [note(CDN, "save"), note(CDN, "restore")] };
  const { lifecycle, saved } = setUp({ saved: [identity("a"), b] });
  await lifecycle.resume("b");
  expect(saved("b")?.skipped).toEqual([note(CDN, "save")]);
});

test("a start of an identity without notes that restores everything leaves it unchanged", async () => {
  const { lifecycle, memory } = setUp();
  const before = memory.saved;
  await lifecycle.resume("b");
  expect(memory.saved).toBe(before);
});
