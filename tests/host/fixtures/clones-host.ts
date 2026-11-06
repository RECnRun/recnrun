import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { attachTo, endChrome, isChildProcess } from "../../browser/fixtures/clone-attach.ts";
import type { Processes } from "../../browser/fixtures/clone-attach.ts";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";
import type { CloneHost } from "../../experiments/fixtures/clones.ts";
import { evidence, hostRunId } from "./host-env.ts";
import { chromesOf, commandLineOf, launcherEnv } from "./launcher-host.ts";
import { HOST_FOLDER, hostRoots } from "./roots.ts";

/*
 * The scene of the clone matrix on the owner's Mac (POC PLAN.md P5.5): the owner's frozen base and the
 * record of the owner's personal Default as master, both named by the environment. The master is never
 * launched, killed, read, or copied; only its block of the record is read, and clones go under
 * `<bases>/clones/<run id>/`, which `dispose` removes. The page the clones write to is a loopback
 * server of the run, since the website preview does not run here.
 */

const BASE = "base-v1";
const DEBUGGING = ["--remote-debugging-port=0", "--silent-debugger-extension-api"];

/** The base folder of RECNRUN_HOST_BASES, which must be inside the host folder and hold the base. */
function hostBases(value = process.env.RECNRUN_HOST_BASES): string {
  const bases = hostRoots(value, HOST_FOLDER);
  if (!existsSync(join(bases, BASE))) throw new Error(`${join(bases, BASE)} does not exist.`);
  return bases;
}

/** RECNRUN_HOST_RECORD, an absolute path to an existing launcher record. */
function hostRecord(value = process.env.RECNRUN_HOST_RECORD): string {
  if (!value || !isAbsolute(value) || !existsSync(value))
    throw new Error("Set RECNRUN_HOST_RECORD to the absolute path of the owner's launcher record.");
  return realpathSync(value);
}

/** The profile id and Downloads root of the record's `role=master` block. */
export function masterOf(record: string): { profileId: string; downloads: string } {
  const blocks = record.split(/^(?=userDataDir=)/m);
  const master = blocks.find((block) => /^role=master$/m.test(block));
  const field = (key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(master ?? "")?.[1];
  const profileId = field("profileId");
  const downloads = field("downloadsRoot");
  if (!profileId || !downloads) throw new Error("The record has no role=master block with both.");
  return { profileId, downloads };
}

const processes: Processes = {
  alive: chromesOf,
  pidOf: async (root) => {
    for (const pid of await chromesOf(root)) {
      if (!isChildProcess(await commandLineOf(pid))) return pid;
    }
    return undefined;
  },
};

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

export interface HostClones extends CloneHost {
  dispose(): Promise<void>;
}

/** The owner's base and record as a CloneHost; nothing is created outside the run's folders. */
export async function hostClones(): Promise<HostClones> {
  const bases = hostBases();
  const record = hostRecord();
  const master = masterOf(await readFile(record, "utf8"));
  const run = join(bases, "clones", hostRunId());
  await mkdir(run, { recursive: true });
  const home = join(run, "home");
  await mkdir(home);
  const server = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>RECnRun clone matrix</title><p>clone matrix</p>");
  });
  const baseURL = `http://127.0.0.1:${await listen(server)}`;
  const browsers = new Map<DownloadsProfile, Browser>();
  let rounds = 0;
  return {
    env: await launcherEnv(home, DEBUGGING),
    bases,
    base: BASE,
    record,
    baseURL,
    master: { profileId: master.profileId, downloads: master.downloads },
    clonesDir: async () => {
      const path = join(run, `round-${++rounds}`);
      await mkdir(path);
      return path;
    },
    commandLines: async (root) =>
      Promise.all((await chromesOf(root)).map((pid) => commandLineOf(pid))),
    attach: (root, name, instanceId) => attachTo(root, { name, instanceId }, processes, browsers),
    stop: async (clone) => {
      await browsers
        .get(clone)
        ?.close()
        .catch(() => undefined);
      browsers.delete(clone);
      await endChrome(clone.root, processes);
    },
    // The master's own launcher catalogs the clones' roots; the twin runs none.
    track: () => undefined,
    shoot: async (page: Page, name: string) => {
      await mkdir(evidence().directory, { recursive: true });
      await page.screenshot({ path: join(evidence().directory, `${name}.png`), fullPage: true });
    },
    dispose: async () => {
      server.close();
      if (process.env.RECNRUN_HOST_KEEP_ROOTS === "1") return;
      if (!run.startsWith(`${bases}${sep}clones${sep}`))
        throw new Error(`Refusing to remove ${run}.`);
      await rm(run, { recursive: true, force: true });
    },
  };
}
