import { expect } from "./fixtures/extension.ts";
import { pairAll } from "./fixtures/folder.ts";
import { disconnectThenQuit, expectEveryTabListed, sessionBlocksRecord } from "./fixtures/mesh.ts";
import { test } from "./fixtures/native-dialogs.ts";
import { framesOf, profileIdOf, sendRaw } from "./fixtures/profiles.ts";
import type { Profile } from "./fixtures/profiles.ts";

/*
 * Five profiles pair into a mesh, one link per pair, and each dashboard shows the other four
 * under their names. Each newcomer meets one profile through the folder and the rest through it.
 * tests/browser/mesh-downloads.spec.ts runs the same regressions (fixtures/mesh.ts) over Downloads.
 */

test("five profiles link pairwise, list each other's tabs, and Disconnect or a quit ends one pair only", async ({
  profileA,
  profileB,
  profileC,
  profileD,
  profileE,
  native,
}) => {
  test.setTimeout(420_000);
  const all = [profileA, profileB, profileC, profileD, profileE];
  await pairAll(all, native);
  await expectEveryTabListed(all);
  // Every open dashboard holds its folder grant (H2), so Reconnect finds the pair in the folder.
  await disconnectThenQuit(all, (profile) => profile.context.close());
});

/** The types of the frames `profile`, as `me`, sent to `to` since the tap held `from` frames. */
const sentTo = async (profile: Profile, me: string, to: string | undefined, from: number) =>
  (await framesOf(profile))
    .slice(from)
    .filter((frame) => frame.startsWith("{"))
    .map((frame) => JSON.parse(frame) as { type: string; from: string; to: string })
    .filter((message) => message.from === me && (to === undefined || message.to === to))
    .map((message) => message.type);

test("a session one profile runs in another blocks Record in the rest, and a frame claiming another profile's id gets no answer", async ({
  profileA,
  profileB,
  profileC,
  profileD,
  profileE,
  native,
}) => {
  test.setTimeout(420_000);
  const all = [profileA, profileB, profileC, profileD, profileE];
  await pairAll(all, native);
  await sessionBlocksRecord(all);

  // A frame on A's own link to C that claims to come from B: C drops it and answers nothing.
  const [idA, idB, idC] = [
    await profileIdOf(profileA),
    await profileIdOf(profileB),
    await profileIdOf(profileC),
  ];
  const before = (await framesOf(profileC)).length;
  const forged = {
    channel: "recnrun-peer",
    protocol: 1,
    id: crypto.randomUUID(),
    from: idB,
    to: idC,
    type: "ACTIVATE_TAB",
    tabId: 1,
  };
  await sendRaw(profileA, idC, JSON.stringify(forged));
  // A malformed frame after it gets an ERROR, so C has handled the forged one by then.
  await sendRaw(profileA, idC, "not json");
  await expect.poll(() => sentTo(profileC, idC, idA, before)).toContain("ERROR");
  // Tab and session notices go on to both; no answer to a command goes to either.
  expect(await sentTo(profileC, idC, undefined, before)).not.toContain("COMMAND_RESULT");
});
