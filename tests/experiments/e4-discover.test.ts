import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { announceToken, fakeSession, freshPresence, placePresence } from "./e4-fake.ts";
import type { OnOpen } from "./e4-fake.ts";
import { announced, discoverAndPublish } from "./fixtures/e4-run.ts";
import type { Labels } from "./fixtures/e4-run.ts";

// Codex P2 finding 4: the record carries the identity the scan discovered, checked against the harness's.
let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** Two profiles on the default of a fake session, discovered and published. */
async function publishTwo(onOpen: OnOpen = announceToken, tokens?: () => string) {
  const { session } = await fakeSession(onOpen);
  dispose = () => session.dispose();
  const labels: Labels = new Map([[session.defaultDownloads, "<default Downloads>"]]);
  const peers = [await announced(session, "A"), await announced(session, "B")];
  const candidates = [session.defaultDownloads];
  const sample = await discoverAndPublish(session, peers, {
    candidates,
    labels,
    ...(tokens ? { token: tokens } : {}),
  });
  return { session, peers, sample };
}

describe("E4 discovery identity", () => {
  test("records each profile under the identity its token's presence carries", async () => {
    const { session, peers, sample } = await publishTwo();
    expect(sample).toMatchObject({ ok: true });
    const record = await readFile(session.record, "utf8");
    for (const peer of peers) expect(record).toContain(`profileId=${peer.profileId}`);
  });

  test("fails a token whose presence names another profile", async () => {
    const impostor: OnOpen = async (opened, token) => {
      await placePresence(opened.downloads, { ...freshPresence(randomUUID()), boot: token });
    };
    const { sample } = await publishTwo(impostor);
    expect(sample.ok).toBe(false);
    expect(sample.error).toContain("A's token led to the presence of another profile");
  });

  test("fails two profiles opened with the same token, naming why", async () => {
    const token = randomUUID();
    const { sample } = await publishTwo(announceToken, () => token);
    expect(sample.ok).toBe(false);
    expect(sample.error).toContain("B's token matched 2 presences");
  });
});
