import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bindHierarchy } from "../e2e/fixtures/hierarchy.ts";
import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import { namespaceFolder } from "../experiments/fixtures/e4-launcher.ts";
import { judged } from "../experiments/fixtures/downloads-verdicts.ts";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import type { Cell } from "../experiments/outcome.ts";
import { expect, test } from "./fixtures/chrome.ts";
import {
  POC_EXTENSION_ID,
  createDownloadsGroup,
  nameProfile,
  openViews,
  tempPlatform,
  waitForMesh,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "./fixtures/downloads-profiles.ts";

/*
 * POC PLAN.md P5.4 on Google Chrome Stable: the diagnostics page of a bound master and of its
 * worker reports their role, identity, boot, permissions, transport, and pinned peers, from what
 * each profile stored and wrote, and holds no token, operation id, private key, or signature.
 */

const MESH_MS = 60_000;
const SECRET_NAMES = /"(token|operationId|privateKey|secret)"/i;
const SIGNATURE = /(?<![\w-])[\w-]{86}(?![\w-])/;

const CELLS = {
  "P5.4.report.fields": "master and worker linked over Downloads, bound by the local channel",
  "P5.4.report.noSecrets": "the same two profiles: the serialized report names no secret",
} as const;

/** What a profile's report must say, from what the profiles stored and wrote themselves. */
interface Expected {
  role: string;
  profileId: string;
  identityKey: string;
  boot: string;
  masterProfileId?: string;
  workerId?: string;
  peerId: string;
  peerKey: string;
}

interface Report {
  profile: {
    extension: { id: string };
    identity: { profileId: string; identityKey: string | null };
    bootId: string | null;
    templateMode: boolean;
    role: { role: string; masterProfileId?: string; boundWorkers?: { profileId: string }[] };
    permissions: { declared: string[] };
    peers: { profileId: string; identityKey: string }[];
    errors: string[];
  };
}

/** The ways `report` differs from `expected`; none means the page told the truth. */
function differences({ profile }: Report, expected: Expected): string[] {
  const peer = profile.peers.find((each) => each.profileId === expected.peerId);
  const checks: [string, boolean][] = [
    ["role", profile.role.role === expected.role],
    ["master profile id", profile.role.masterProfileId === expected.masterProfileId],
    ["bound worker", profile.role.boundWorkers?.[0]?.profileId === expected.workerId],
    ["profile id", profile.identity.profileId === expected.profileId],
    ["identity key", profile.identity.identityKey === expected.identityKey],
    ["bootId", profile.bootId === expected.boot],
    ["templateMode", profile.templateMode === false],
    ["downloads permission", profile.permissions.declared.includes("downloads")],
    ["extension id", profile.extension.id === POC_EXTENSION_ID],
    ["pinned key of the peer", peer?.identityKey === expected.peerKey],
    ["errors", profile.errors.length === 0],
  ];
  return checks.filter(([, held]) => !held).map(([name]) => name);
}

const cell = async (hypothesis: keyof typeof CELLS): Promise<Cell> => ({
  experiment: "P5.4",
  hypothesis,
  chrome: await labEnvironment.target.chrome(),
  environment: "lab",
  install: "loadUnpacked",
  label: "diagnostic",
  externalClient: true,
  variant: "poc-d0",
  topology: CELLS[hypothesis],
  debugger: "none",
});

/** The page's `<pre id="diagnostics">`, as text and parsed, once the report is in. */
async function reportOf(profile: DownloadsProfile, screenshot?: string) {
  const page = await profile.context.newPage();
  await page.goto(`chrome-extension://${POC_EXTENSION_ID}/diagnostics.html`);
  const pre = page.locator("pre#diagnostics");
  await expect(pre).toContainText('"profile"');
  const text = (await pre.textContent()) ?? "";
  if (screenshot) {
    const body = await page.screenshot({ fullPage: true });
    await test.info().attach(screenshot, { body, contentType: "image/png" });
  }
  await page.close();
  return { text, report: JSON.parse(text) as Report };
}

test.describe.configure({ timeout: 300_000 });

test("the diagnostics page reports the role, identity, boot, permissions, and peers", async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
  const group = await createDownloadsGroup(tempPlatform("recnrun-diagnostics"));
  try {
    const views = [];
    for (const name of ["Profile A", "Profile B"]) {
      const profile = await group.launch(name);
      const view = await openViews(profile, baseURL);
      await nameProfile(view);
      views.push({ profile, view });
    }
    await group.catalog();
    group.startCatalog();
    await waitForMesh(
      views.map((each) => each.profile),
      MESH_MS,
    );
    const [master, worker] = views;
    if (!master || !worker) throw new Error("Two profiles did not launch.");
    await bindHierarchy(master.view, [worker.view]);
    const presenceOf = async (profileId: string) =>
      JSON.parse(
        await readFile(
          join(namespaceFolder(group.downloads), "peers", profileId, "presence.json"),
          "utf8",
        ),
      ) as { boot: string; identity: { key: string } };
    const [masterPresence, workerPresence] = [
      await presenceOf(master.profile.profileId),
      await presenceOf(worker.profile.profileId),
    ];
    const reports = [
      {
        who: "master",
        ...(await reportOf(master.profile)),
        expected: {
          role: "master",
          profileId: master.profile.profileId,
          identityKey: masterPresence.identity.key,
          boot: masterPresence.boot,
          workerId: worker.profile.profileId,
          peerId: worker.profile.profileId,
          peerKey: workerPresence.identity.key,
        },
      },
      {
        who: "worker",
        ...(await reportOf(worker.profile, "diagnostics of the worker")),
        expected: {
          role: "worker",
          profileId: worker.profile.profileId,
          identityKey: workerPresence.identity.key,
          boot: workerPresence.boot,
          masterProfileId: master.profile.profileId,
          peerId: master.profile.profileId,
          peerKey: masterPresence.identity.key,
        },
      },
    ];

    await recordHypothesis(
      await cell("P5.4.report.fields"),
      async () => {
        const problems = reports.flatMap(({ who, report, expected }) =>
          differences(report, expected).map((name) => `${who}: ${name}`),
        );
        return judged(problems, { sections: Object.keys(reports[0]?.report.profile ?? {}) });
      },
      { full: 1 },
    );

    await recordHypothesis(
      await cell("P5.4.report.noSecrets"),
      async () => {
        const problems = reports.flatMap(({ who, text }) => [
          ...(SECRET_NAMES.test(text) ? [`${who}: a secret name`] : []),
          ...(SIGNATURE.test(text) ? [`${who}: a signature-sized string`] : []),
        ]);
        return judged(problems, { checked: reports.map((each) => each.who) });
      },
      { full: 1 },
    );
  } finally {
    await group.dispose();
  }
});

test("every P5.4 hypothesis left a verdict", async () => {
  await expectEveryHypothesis("P5.4", Object.keys(CELLS));
});
