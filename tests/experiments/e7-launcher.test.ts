import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { freshPresence, placePresence } from "./e4-fake.ts";
import type { PresenceFile as Presence } from "./fixtures/e4-launcher.ts";
import { namespaceFolder, presenceIn } from "./fixtures/e4-launcher.ts";
import { restamp, stampIo } from "./fixtures/e7-launcher.ts";

// Codex P3 finding 3: a profile's newer publication wins over the launcher's renewal.
let scratch = "";
const file = (profileId: string) =>
  join(namespaceFolder(scratch), "peers", profileId, "presence.json");

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "recnrun-e7-launcher-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

/** The profile publishes its next boot with a new statement, as Chrome's download replaces the file. */
async function republish(presence: Presence) {
  const identity = { ...presence.identity, signedAt: presence.identity.signedAt + 1 };
  const next = { ...presence, boot: randomUUID(), identity };
  await placePresence(scratch, next);
  return next;
}

describe("E7 launcher renewal", () => {
  test("an unchanged presence is renewed with its boot and statement kept", async () => {
    const presence = freshPresence();
    await placePresence(scratch, presence);
    await expect(restamp(scratch, presence.profileId)).resolves.toBe(true);
    const renewed = await presenceIn(scratch, presence.profileId);
    expect(renewed).toMatchObject({ boot: presence.boot, identity: presence.identity });
    expect(renewed?.expiresAt).toBeGreaterThan(presence.expiresAt);
  });

  test("a presence the profile republishes just before the replacement keeps its boot and statement", async () => {
    const presence = freshPresence();
    await placePresence(scratch, presence);
    const real = stampIo.rename;
    let next: Awaited<ReturnType<typeof republish>> | undefined;
    vi.spyOn(stampIo, "rename").mockImplementationOnce(async (from, to) => {
      next = await republish(presence);
      return real(from, to);
    });
    await expect(restamp(scratch, presence.profileId)).resolves.toBe(false);
    expect(JSON.parse(await readFile(file(presence.profileId), "utf8"))).toEqual(next);
  });

  test("a presence the profile republishes after the file was taken aside is not overwritten", async () => {
    const presence = freshPresence();
    await placePresence(scratch, presence);
    const real = stampIo.link;
    let next: Awaited<ReturnType<typeof republish>> | undefined;
    vi.spyOn(stampIo, "link").mockImplementationOnce(async (from, to) => {
      next = await republish(presence);
      return real(from, to);
    });
    await expect(restamp(scratch, presence.profileId)).resolves.toBe(false);
    expect(JSON.parse(await readFile(file(presence.profileId), "utf8"))).toEqual(next);
  });

  test("a profile with no presence is left alone", async () => {
    await expect(restamp(scratch, randomUUID())).resolves.toBe(false);
  });
});
