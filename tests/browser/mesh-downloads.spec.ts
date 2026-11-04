import { bindHierarchy } from "../e2e/fixtures/hierarchy.ts";
import {
  disconnectThenQuit,
  expectEveryTabListed,
  sessionBlocksRecord,
} from "../e2e/fixtures/mesh.ts";
import type { Profile } from "../e2e/fixtures/profiles.ts";
import { expect, test as base } from "./fixtures/chrome.ts";
import {
  createDownloadsGroup,
  linkedPeers,
  nameProfile,
  openViews,
  tempPlatform,
  waitForMesh,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./fixtures/downloads-profiles.ts";

/*
 * POC PLAN.md P3.2 on Google Chrome Stable: five throwaway roots with poc-d0 (installed with
 * `Extensions.loadUnpacked`, label `diagnostic`) share one Downloads folder and pair by
 * themselves, with no picker and no gesture, once the stand-in launcher catalogs them; then the
 * regressions of tests/e2e/cross-profile-mesh.spec.ts run on that mesh. mesh-two-profiles.spec.ts
 * stays the File System Access control.
 */

const NAMES = ["Profile A", "Profile B", "Profile C", "Profile D", "Profile E"];
const MESH_MS = 60_000;

interface Mesh {
  group: DownloadsGroup;
  profiles: DownloadsProfile[];
  views: Profile[];
  /** How long the ten links took once the catalog first listed the five profiles. */
  formedMs: number;
}

/** Five named profiles that linked over Downloads, the first bound as the others' master. */
async function meshOfFive(group: DownloadsGroup, baseURL: string): Promise<Mesh> {
  const profiles: DownloadsProfile[] = [];
  const views: Profile[] = [];
  for (const name of NAMES) {
    const profile = await group.launch(name);
    const view = await openViews(profile, baseURL);
    // Named before the catalog lists anyone, so every pairing code carries the name.
    await nameProfile(view);
    profiles.push(profile);
    views.push(view);
  }
  await group.catalog();
  group.startCatalog();
  const formedMs = await waitForMesh(profiles, MESH_MS);
  const [master, ...workers] = views;
  if (!master) throw new Error("No profile launched.");
  await bindHierarchy(master, workers);
  return { group, profiles, views, formedMs };
}

const test = base.extend<{ mesh: Mesh }>({
  mesh: async ({ baseURL }, use, testInfo) => {
    if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
    const group = await createDownloadsGroup(tempPlatform("recnrun-mesh"));
    try {
      const mesh = await meshOfFive(group, baseURL);
      const description = `ten links ${mesh.formedMs} ms after the first catalog`;
      testInfo.annotations.push({ type: "mesh", description });
      console.log(`${testInfo.title}: ${description}`);
      await use(mesh);
    } finally {
      await group.dispose();
    }
  },
});

// Five launches and the mesh run in the fixture, which the test's own timeout covers.
test.describe.configure({ timeout: 300_000 });

test("five Google Chrome Stable roots pair over Downloads, list each other's tabs, and Disconnect or a quit ends one pair only", async ({
  mesh,
  baseURL,
}) => {
  for (const profile of mesh.profiles) {
    expect(profile.chrome.version).toMatch(/^Google Chrome \d+\./);
    expect(await linkedPeers(profile)).toHaveLength(NAMES.length - 1);
  }
  await expectEveryTabListed(mesh.views, baseURL);
  const [first] = mesh.views;
  if (first) {
    const body = await first.dashboard.screenshot({ fullPage: true });
    await test.info().attach(`dashboard of ${first.name}`, { body, contentType: "image/png" });
  }
  await disconnectThenQuit(mesh.views, async (view) => {
    const quitting = mesh.profiles.find((profile) => profile.name === view.name);
    if (quitting) await mesh.group.quit(quitting);
  });
});

test("a session one profile runs in another over Downloads blocks Record in the rest", async ({
  mesh,
  baseURL,
}) => {
  await sessionBlocksRecord(mesh.views, baseURL);
});
