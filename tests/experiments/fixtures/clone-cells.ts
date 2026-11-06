import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { POC_EXTENSION_ID, storedIn } from "../../browser/fixtures/downloads-profiles.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { CLEAN, differences } from "./clone-storage.ts";
import { ackFile, bringUp, reopen, textOf, waitLinked } from "./clone-round.ts";
import type { Round, RoundClone } from "./clone-round.ts";
import { folderOf, readJson, sampleOf } from "./clones.ts";
import type { Sample } from "../outcome.ts";

/*
 * CL05, CL09, CL11, and CL12 of P5.5 (POC PLAN.md): three roots, the permissions each clone holds,
 * a reopened clone that keeps its identity, and a clone made later from the original base.
 */

const PAGE_MS = 15_000;

interface Presence {
  profileId: string;
  boot: string;
  identity: { key: string };
}

const presenceOf = async (downloads: string, id: string) =>
  (await readJson(join(folderOf(downloads), "peers", id, "presence.json"))) as unknown as Presence;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** What `peerPins` of `profile` holds for the peer `id`, if anything. */
async function pinKey(clone: RoundClone, id: string) {
  const pins = (await storedIn(clone.profile.serviceWorker, "local", "peerPins")) as
    | Record<string, { identity: string }>
    | undefined;
  return pins?.[id]?.identity;
}

/** The sides a round runs: each with the root it runs on and the Downloads root it writes to. */
function sidesOf(round: Round) {
  const { master } = round.host;
  const masterRoot = master.profile?.root;
  const masters = masterRoot
    ? [{ name: "master", id: master.profileId, root: masterRoot, downloads: master.downloads }]
    : [];
  return [
    ...masters,
    ...round.clones.map(({ name, id, root, downloads }) => ({ name, id, root, downloads })),
  ];
}

/** CL05: three processes on three roots, each presence under its own root only, the pins from the acks. */
export async function threeRootsCell(round: Round): Promise<Sample> {
  const sides = sidesOf(round);
  const problems: string[] = [];
  const lines = new Map<string, string[]>();
  for (const side of sides) {
    const own = await round.host.commandLines(side.root);
    lines.set(side.name, own);
    if (own.length === 0) problems.push(`no process names ${side.root}`);
    const foreign = sides.filter(
      (other) =>
        other !== side && own.some((line) => line.includes(`--user-data-dir=${other.root} `)),
    );
    problems.push(...foreign.map((other) => `${side.name}'s command line names ${other.root}`));
    const presence = await presenceOf(side.downloads, side.id).catch(() => undefined);
    if (presence?.profileId !== side.id)
      problems.push(`${side.name}'s presence names ${String(presence?.profileId)}`);
    for (const other of sides.filter((each) => each !== side)) {
      const trace = join(folderOf(side.downloads), "peers", other.id);
      if (await exists(trace))
        problems.push(`${other.name}'s presence is under ${side.name}'s root`);
    }
  }
  problems.push(...(await pinProblems(round)));
  return sampleOf(problems, {
    roots: sides.map((side) => side.root),
    processes: Object.fromEntries([...lines].map(([k, v]) => [k, v.length])),
  });
}

/** The master's pins hold A and B with the keys of their acks; with no attached master, each clone's pin of it holds its presence key. */
async function pinProblems(round: Round): Promise<string[]> {
  const out: string[] = [];
  const { master } = round.host;
  const masterKey = (await presenceOf(master.downloads, master.profileId)).identity.key;
  for (const clone of round.clones) {
    const ack = (await readJson(ackFile(clone.downloads, clone.id, clone.token))) as unknown as {
      identity: { key: string };
    };
    const held = master.profile ? await masterPin(master.profile, clone.id) : undefined;
    if (master.profile && held !== ack.identity.key)
      out.push(`the master's pin of ${clone.name} is not the key of its ack`);
    if ((await pinKey(clone, master.profileId)) !== masterKey)
      out.push(`${clone.name}'s pin of the master is not its presence key`);
  }
  return out;
}

async function masterPin(master: NonNullable<Round["host"]["master"]["profile"]>, id: string) {
  const pins = (await storedIn(master.serviceWorker, "local", "peerPins")) as
    | Record<string, { identity: string }>
    | undefined;
  return pins?.[id]?.identity;
}

interface DiagnosticsReport {
  profile: {
    identity: { profileId: string; identityKey: string | null };
    templateMode: boolean;
    permissions: {
      declared: string[];
      granted: string[];
      fileSchemeAccess: boolean;
      incognitoAccess: boolean;
    };
    errors: string[];
  };
}

/** The diagnostics page of a clone: its report, and a screenshot named `shot` when asked. */
async function reportOf(round: Round, clone: RoundClone, shot?: string) {
  const page = await clone.profile.context.newPage();
  await page.goto(`chrome-extension://${POC_EXTENSION_ID}/diagnostics.html`);
  const pre = page.locator("pre#diagnostics");
  await expect(pre).toContainText('"profile"', { timeout: PAGE_MS });
  const report = JSON.parse((await pre.textContent()) ?? "{}") as DiagnosticsReport;
  if (shot) await round.host.shoot(page, shot);
  await page.close();
  return report;
}

type Permissions = DiagnosticsReport["profile"]["permissions"];

/** What a clone's permissions and its Downloads files must show. */
async function permissionProblems(clone: RoundClone, permissions: Permissions): Promise<string[]> {
  const missing = permissions.declared.filter((each) => !permissions.granted.includes(each));
  const flags = (["fileSchemeAccess", "incognitoAccess"] as const).filter(
    (key) => typeof permissions[key] !== "boolean",
  );
  const files = [
    ackFile(clone.downloads, clone.id, clone.token),
    join(folderOf(clone.downloads), "peers", clone.id, "presence.json"),
  ];
  const absent: string[] = [];
  for (const file of files) if (!(await exists(file))) absent.push(file);
  return [
    ...(permissions.granted.includes("downloads")
      ? []
      : [`${clone.name} was not granted downloads`]),
    ...missing.map((each) => `${clone.name} lacks ${each}`),
    ...flags.map((key) => `${clone.name} reported no ${key}`),
    ...absent.map((file) => `${clone.name} wrote no ${file}`),
  ];
}

/** CL09: each clone holds what poc-d0 declares, reports its file and Incognito access, and used Downloads. */
export async function permissionsCell(round: Round): Promise<Sample> {
  const problems: string[] = [];
  const seen: Record<string, unknown> = {};
  for (const clone of round.clones) {
    const { permissions } = (
      await reportOf(round, clone, clone.name === "A" ? "diagnostics-A" : undefined)
    ).profile;
    seen[clone.name] = permissions;
    problems.push(...(await permissionProblems(clone, permissions)));
  }
  return sampleOf(problems, { permissions: seen });
}

/** CL11: B stopped and reopened by the launcher path keeps its id and key, relinks, and starts nothing again. */
export async function reopenCell(round: Round): Promise<Sample> {
  const b = round.clones.find((each) => each.name === "B");
  if (!b) throw new Error("The round has no B.");
  const before = await presenceOf(b.downloads, b.id);
  const reopened = await reopen(round, b);
  const problems: string[] = [];
  if (reopened.code !== 0)
    return sampleOf([`B did not reopen: ${reopened.stderr.trim().slice(-300)}`], {});
  if (reopened.markerBefore !== reopened.markerAfter)
    problems.push("the reopen rewrote .recnrun-clone");
  if (reopened.blocks !== 1) problems.push(`the record holds ${reopened.blocks} blocks of B`);
  await waitLinked(round.host, [b]);
  const after = await within(async () => {
    const found = await presenceOf(b.downloads, b.id).catch(() => undefined);
    return found && found.boot !== before.boot ? found : undefined;
  }, PAGE_MS * 4);
  if (!after) problems.push("B published no presence of a new boot");
  else if (after.profileId !== before.profileId || after.identity.key !== before.identity.key)
    problems.push("B changed its id or key");
  const stale = b.log.filter((line) => line.includes("REFUSED") || line.includes("dropped"));
  problems.push(...stale.map((line) => `B logged: ${line}`));
  return sampleOf(problems, { reopenedMs: reopened.ms, bootChanged: after !== undefined });
}

/** CL12: C made later from the original base is a new identity with none of A's or B's storage, linked with the master. */
export async function laterCell(round: Round): Promise<Sample> {
  const { host, clonesDir } = round;
  const baseMarker = join(host.bases, host.base, ".recnrun-base");
  const frozen = await textOf(baseMarker);
  const c = await bringUp(host, clonesDir, "C");
  round.clones.push(c);
  const problems: string[] = [];
  const mine = await presenceOf(c.downloads, c.id);
  for (const other of round.clones.filter((each) => each !== c)) {
    const theirs = await presenceOf(other.downloads, other.id);
    if (theirs.identity.key === mine.identity.key || other.id === c.id)
      problems.push(`C shares an identity with ${other.name}`);
  }
  problems.push(...(await differences(c, CLEAN)));
  const marker = await textOf(join(c.root, ".recnrun-clone"));
  if (!marker.startsWith(`base=${host.base}\n`)) problems.push("C's marker does not name the base");
  if ((await textOf(baseMarker)) !== frozen || frozen === "")
    problems.push("the base's marker changed");
  await reportOf(round, c, "diagnostics-C");
  return sampleOf(problems, { cLinkMs: c.linkMs, cReadyMs: c.readyMs });
}
