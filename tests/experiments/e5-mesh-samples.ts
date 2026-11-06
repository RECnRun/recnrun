import { expect } from "@playwright/test";
import type { Locator } from "@playwright/test";
import {
  linkedPeers,
  POC_EXTENSION_ID,
  storedIn,
  waitForMesh,
} from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "../browser/fixtures/downloads-profiles.ts";
import { peerLine, peerStatus } from "../e2e/fixtures/profiles.ts";
import type { Profile } from "../e2e/fixtures/profiles.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import { recordOf, within, workerListed, writesOf } from "./fixtures/e5-observe.ts";
import { arrive, arriving, identityOf, linkedWith, quiet, withGroup } from "./fixtures/e5-run.ts";
import type { E5Environment } from "./fixtures/e5-run.ts";

/*
 * E5's cells on the Default plus four workers (POC PLAN.md P3.2 and §7.4): the mesh forms over
 * Downloads, a fifth profile joins four with no extension page open, an executor crashes and comes
 * back, and the user disconnects and forgets one profile from the Default's dashboard.
 */

const MESH_MS = 90_000;
const LINK_MS = 30_000;
/** Heartbeats every 1 s and silence after 2.5 s (peer-link.ts), with margin. */
const DROP_MS = 10_000;
/** Past the worker's 30 s idle delay (CHROMIUM.md group 12), and past RETRY_MS (30 s). */
const IDLE_MS = 35_000;

/** Every pair of `profiles` once, lower profile id first. */
const pairsOf = (profiles: DownloadsProfile[]): [DownloadsProfile, DownloadsProfile][] =>
  profiles.flatMap((one, index) =>
    profiles
      .slice(index + 1)
      .map((other): [DownloadsProfile, DownloadsProfile] =>
        one.profileId < other.profileId ? [one, other] : [other, one],
      ),
  );

/** How many offer files each side of each pair wrote. */
const offerWrites = (profiles: DownloadsProfile[]) =>
  Promise.all(
    pairsOf(profiles).map(async ([low, high]) => ({
      lower: await writesOf(low, `offer-${high.profileId}.json`),
      higher: await writesOf(high, `offer-${low.profileId}.json`),
    })),
  );

/** E5.b.mesh: five profiles arrive together and form ten links, each from at most one offer file. */
export const meshSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles, first } = await arrive(group, 5);
    const listed = profiles.filter((each) => first.registry?.peers[each.profileId]).length;
    const linkMs = await waitForMesh(profiles, MESH_MS).catch(() => undefined);
    const writes = await offerWrites(profiles);
    const throughFiles = writes.filter((each) => each.lower === 1).length;
    const problems = [
      ...(linkMs === undefined ? [`the ten links did not form within ${MESH_MS} ms`] : []),
      ...(writes.some((each) => each.lower > 1) ? ["a pair took more than one offer file"] : []),
      ...(writes.some((each) => each.higher > 0) ? ["a higher profile id wrote an offer"] : []),
    ];
    // A pair with no offer file was introduced over the links already up (mesh-pairing.ts).
    return judged(problems, {
      listedInFirstCatalog: listed,
      linkMs,
      pairsThroughFiles: throughFiles,
    });
  });

const listedNow = (profiles: DownloadsProfile[]) => Promise.all(profiles.map(workerListed));

/** E5.b.fifth: a fifth profile links with four whose extension pages are closed and clients gone. */
export const fifthSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await arrive(group, 4);
    await waitForMesh(profiles, MESH_MS);
    for (const profile of profiles) await group.detach(profile);
    await quiet(IDLE_MS);
    const workersBefore = await listedNow(profiles);
    const fifth = await arriving(group, "Worker 4");
    const outAt = Date.now();
    const joined = await within(
      async () => ((await linkedPeers(fifth)).length === profiles.length ? true : undefined),
      MESH_MS,
      250,
    );
    const joinMs = joined && joined.at - outAt;
    const workersAfter = await listedNow(profiles);
    for (const profile of profiles) await group.attach(profile);
    const whole = await waitForMesh([...profiles, fifth], LINK_MS).catch(() => undefined);
    const problems = [
      ...(joined ? [] : [`the fifth profile did not link with the four within ${MESH_MS} ms`]),
      ...(whole === undefined ? ["the five were not all linked once attached"] : []),
    ];
    return judged(problems, { workersBefore, workersAfter, joinMs, linked: joined !== undefined });
  });

/** Whether each of `profiles` holds `count` links to the others of them. */
const intact = async (profiles: DownloadsProfile[]) => {
  for (const profile of profiles) {
    const peers = await linkedPeers(profile);
    const others = profiles.filter((each) => each !== profile && peers.includes(each.profileId));
    if (others.length !== profiles.length - 1) return false;
  }
  return true;
};

/** E5.b.killExecutor: SIGKILL to one worker; the others see it go and keep their links; it comes back. */
export const killExecutorSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await arrive(group, 5);
    await waitForMesh(profiles, MESH_MS);
    const victim = profiles[2];
    if (!victim) throw new Error("No third profile launched.");
    const rest = profiles.filter((each) => each !== victim);
    const before = await identityOf(victim);
    await group.kill(victim);
    const killedAt = Date.now();
    const gone = await within(async () => {
      for (const profile of rest) if (await linkedWith(profile, victim)) return undefined;
      return Date.now() - killedAt;
    }, DROP_MS);
    const restIntact = await intact(rest);
    await group.relaunch(victim);
    const linkMs = await waitForMesh(profiles, MESH_MS).catch(() => undefined);
    const after = await identityOf(victim);
    const observation = {
      droppedAfterMs: gone?.value,
      restIntact,
      relinked: linkMs !== undefined,
      sameProfileId: after.profileId === before.profileId,
      samePins: after.pins === before.pins,
    };
    const problems = [
      ...(gone ? [] : [`a profile still showed the killed one linked after ${DROP_MS} ms`]),
      ...(restIntact ? [] : ["the four others lost a link among themselves"]),
      ...(observation.relinked ? [] : ["the relaunched worker did not link with all four"]),
      ...(observation.sameProfileId ? [] : ["the relaunched worker has another profile id"]),
    ];
    return judged(problems, observation);
  });

/** The profile's dashboard, as tests/e2e's helpers take it, named as its peers show it. */
async function dashboardOf(profile: DownloadsProfile): Promise<Profile> {
  const dashboard = await profile.context.newPage();
  await dashboard.goto(`chrome-extension://${POC_EXTENSION_ID}/dashboard.html`);
  const identity = (await storedIn(profile.serviceWorker, "local", "profileIdentity")) as {
    displayName: string;
  };
  const { dir, context, serviceWorker } = profile;
  return { name: identity.displayName, dir, context, serviceWorker, site: dashboard, dashboard };
}

const shows = (locator: Locator, text: string, timeout = LINK_MS) =>
  expect(locator)
    .toHaveText(text, { timeout })
    .then(
      () => true,
      () => false,
    );

/** Neither of the two holds a link to the other. */
const apart = async (one: DownloadsProfile, other: DownloadsProfile) =>
  !(await linkedWith(one, other)) && !(await linkedWith(other, one));

/** Both hold a link to each other within `ms`. */
const together = async (one: DownloadsProfile, other: DownloadsProfile, ms = LINK_MS) =>
  (await within(
    async () => ((await linkedWith(one, other)) && (await linkedWith(other, one))) || undefined,
    ms,
    250,
  )) !== undefined;

/** The checks of a Disconnect from A's dashboard, held for IDLE_MS, then Reconnect. */
async function disconnectChecks(profiles: DownloadsProfile[], views: Profile[]) {
  const [a, b] = profiles;
  const [va, vb] = views;
  if (!a || !b || !va || !vb) throw new Error("Disconnect takes two profiles.");
  await peerLine(va, vb).getByRole("button", { name: "Disconnect" }).click();
  const checks: Record<string, boolean> = {
    disconnectShown: await shows(peerStatus(va, vb), `Disconnected — ${vb.name}`),
  };
  await quiet(IDLE_MS);
  checks.disconnectHeld = await apart(a, b);
  checks.othersKept =
    (await intact(profiles.filter((each) => each !== a))) &&
    (await intact(profiles.filter((each) => each !== b)));
  await peerLine(va, vb).getByRole("button", { name: "Reconnect" }).click();
  checks.reconnected = await together(a, b);
  return checks;
}

/** E5.b.disconnectForget (lab): Disconnect and Forget from the Default's dashboard hold, and end with a link again. */
export const disconnectForgetSample = (environment: E5Environment) =>
  withGroup(environment, async (group) => {
    const { profiles } = await arrive(group, 5);
    await waitForMesh(profiles, MESH_MS);
    const [a, , c] = profiles;
    if (!a || !c) throw new Error("Forget takes three profiles.");
    const views = await Promise.all(profiles.slice(0, 3).map(dashboardOf));
    const [va, , vc] = views;
    if (!va || !vc) throw new Error("No dashboards opened.");
    const checks = await disconnectChecks(profiles, views);
    await peerLine(va, vc)
      .getByRole("button", { name: `Forget ${vc.name}` })
      .click();
    checks.forgetRemovesLine = await expect(peerLine(va, vc))
      .toHaveCount(0, { timeout: LINK_MS })
      .then(
        () => true,
        () => false,
      );
    checks.forgetClearsTrust = (await recordOf(a, "local", "authorizedPeers", c)) === undefined;
    await quiet(IDLE_MS);
    checks.forgetHeld = await apart(a, c);
    const pairAgain = va.dashboard.getByRole("button", { name: "Pair with other profiles" });
    checks.pairAgainOffered = (await pairAgain.count()) > 0;
    // The request that button sends, so the engine's half is measured even where the button is missing.
    await va.dashboard.evaluate(() =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage({ type: "peer", request: { type: "pair-again" } }),
    );
    checks.pairedAgain = await together(a, c);
    return judged(
      Object.entries(checks).flatMap(([name, held]) => (held ? [] : [`${name} did not hold`])),
      checks,
    );
  });
