import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { launchProbe } from "../../experiments/fixtures/downloads.ts";
import type { DownloadsEnvironment } from "../../experiments/fixtures/downloads-cells.ts";
import { parseVerdicts } from "../../experiments/schema.ts";
import type { Verdict } from "../../experiments/schema.ts";
import { CHROME_BINARY, evidence, hostRunId, requireHost } from "./host-env.ts";
import { removeHostRoot, rootFor } from "./roots.ts";

/** Keeps the diagnostic window off the owner's screen and away from the login Keychain. */
const HOST_ARGS = [
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--window-position=-2000,0",
  "--window-size=800,600",
];
const DOWNLOADS = join(homedir(), "Downloads");
/** The only folder of the owner's Downloads a host cell may write: `RECnRun/poc-downloads-launcher/<run>/`. */
const PARENTS = [join(DOWNLOADS, "RECnRun"), join(DOWNLOADS, "RECnRun", "poc-downloads-launcher")];
// Folders the owner already had are never removed, even when empty.
const EXISTED = new Map(PARENTS.map((folder) => [folder, existsSync(folder)]));
const runFolder = () => join(PARENTS[1] ?? "", hostRunId());

let launches = 0;

async function removeRoot(root: string): Promise<void> {
  if (process.env.RECNRUN_HOST_KEEP_ROOTS === "1") return;
  await removeHostRoot(root, hostRunId());
  await rmdir(dirname(root)).catch(() => undefined);
}

/** Deletes exactly the reported files inside this run's folder, then the folders this run created. */
async function cleanDefault(paths: string[]) {
  const folder = runFolder();
  const outside = paths.filter((path) => dirname(path) !== folder);
  if (outside.length > 0) throw new Error(`Chrome wrote outside ${folder}: ${outside.join(", ")}`);
  for (const path of paths) await rm(path);
  await rmdir(folder);
  for (const parent of [...PARENTS].reverse()) {
    if (!EXISTED.get(parent)) await rmdir(parent).catch(() => undefined);
  }
  const left = [folder, ...PARENTS].filter((each) => existsSync(each) && !EXISTED.get(each));
  return { removed: paths.map((path) => relative(homedir(), path)), left };
}

async function appendHostVerdict(verdict: Verdict): Promise<void> {
  const record = evidence();
  const earlier = await record.read("verdicts.json").catch(() => []);
  await record.write("verdicts.json", parseVerdicts([...parseVerdicts(earlier), verdict]));
}

export const readHostVerdicts = async (): Promise<Verdict[]> =>
  parseVerdicts(await evidence().read("verdicts.json"));

const chromeVersion = async () =>
  (await promisify(execFile)(CHROME_BINARY, ["--version"])).stdout.trim();

/** E2 on the installed Google Chrome of this Mac, one fresh throwaway root per sample. */
export const host: DownloadsEnvironment = {
  target: { environment: "host", chrome: chromeVersion, append: appendHostVerdict },
  launch: async (preferences) => {
    const root = await rootFor(requireHost(), hostRunId(), `e2-${++launches}`);
    try {
      const options = { executable: CHROME_BINARY, args: HOST_ARGS };
      const probe = await launchProbe(root, preferences, options);
      const { product, userAgent } = await probe.loaded.chrome.cdp.send("Browser.getVersion");
      await evidence().versions({ version: probe.loaded.chrome.version, product, userAgent });
      const close = async () => {
        await probe.loaded.close();
        await removeRoot(root);
      };
      return { ...probe, root, close };
    } catch (error) {
      await removeRoot(root);
      throw error;
    }
  },
  defaultDestination: (namespace) =>
    `RECnRun/poc-downloads-launcher/${hostRunId()}/probe-${namespace}.json`,
  cleanDefault,
  noDisplay: "native dialog on macOS, no xdotool; M-P1 manual not scheduled",
};
