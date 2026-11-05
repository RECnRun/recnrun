import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostUnpackedOptions } from "./fixtures/host-chrome.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";
import { hostEnvironment, hostFolder, removeFolder } from "./fixtures/e4-host.ts";
import { extensionPath, loadUnpacked } from "../browser/fixtures/extension-loaders.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { labelPaths } from "../experiments/host-paths.ts";
import { preferencesOf, readJson, register } from "../experiments/fixtures/launcher-open.ts";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import type { Sample } from "../experiments/outcome.ts";

/*
 * P4.6's host twin: the package built by the packager, the README's first command run verbatim
 * from its macOS folder on a throwaway root only. HOME is a folder of the root and the root sits at
 * the OS default Chrome root below it, so the command finds the profile the way it does on a
 * colleague's machine; autostart is never turned on. The diagnostic install stands in for the
 * four Load unpacked gestures; the fifth, the first command, is what runs here.
 */

const target = hostEnvironment.target;
const run = promisify(execFile);
const BUILD = fileURLToPath(
  new URL("../../scripts/poc-cross-profile/package/build.mjs", import.meta.url),
);
const HYPOTHESIS = "P4.6.firstRun.host";
const NAMESPACE = "lab";
const COMMAND_MS = 240_000;
const QUIT_MS = 20_000;
const POLL_MS = 200;
const STEPS = [
  "Open chrome://extensions",
  "Turn on Developer mode",
  "Click Load unpacked",
  "Choose the extension folder",
  "sh recnrun-launcher first-run",
];

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** A command's outcome; a non-zero exit is a result, not a throw. */
async function outcome(
  program: string,
  args: string[],
  cwd: string,
  home: string,
): Promise<Result> {
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  try {
    const done = await run(program, args, { cwd, env, timeout: COMMAND_MS });
    return { code: 0, ...done };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** The pids of Chrome processes whose command line names `root` as the user data directory. */
async function chromesOf(root: string): Promise<number[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split("\n")
    .filter((line) => line.includes(`--user-data-dir=${root}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/** The words of the README's first fenced command, from its "First command" section. */
function firstCommand(readme: string): string[] {
  const block = /```\n([^\n]+)\n```/.exec(readme.split("## First command")[1] ?? "");
  if (!block?.[1]) throw new Error("The README has no First command section with a fenced command");
  return block[1].split(" ");
}

/** The words of the README's command that starts with `sh recnrun-launcher <name>`, `$HOME` filled in. */
function readmeCommand(readme: string, name: string, home: string): string[] {
  const line = readme.split("\n").find((it) => it.startsWith(`sh recnrun-launcher ${name} `));
  if (line === undefined) throw new Error(`The README has no ${name} command`);
  return line.replaceAll('"$HOME', home).replaceAll('"', "").split(" ");
}

interface Machine {
  home: string;
  userDataDir: string;
  profileId: string;
  downloads: string;
  dispose(): Promise<void>;
}

/** poc-d0 installed and kept on a fresh root at the default Chrome root of a throwaway HOME, then quit. */
async function prepare(): Promise<Machine> {
  const root = await hostFolder("launcher-first-run");
  const home = join(root, "home");
  const userDataDir = join(home, "Library/Application Support/Google/Chrome");
  const downloads = join(root, "downloads");
  try {
    await mkdir(downloads);
    await mkdir(join(userDataDir, "Default"), { recursive: true });
    await writeFile(
      join(userDataDir, "Default", "Preferences"),
      JSON.stringify(preferencesOf(downloads)),
    );
    const extension = await loadUnpacked(extensionPath("poc-d0"), hostUnpackedOptions(userDataDir));
    try {
      const { product, userAgent } = await extension.chrome.cdp.send("Browser.getVersion");
      await evidence().versions({ version: extension.chrome.version, product, userAgent });
      const record = join(root, "register.record");
      const { profileId } = await register(extension, userDataDir, downloads, record);
      // The first command writes the real record; the registration helper's one must not exist.
      await rm(record);
      return { home, userDataDir, profileId, downloads, dispose: () => removeFolder(root) };
    } finally {
      await extension.close();
    }
  } catch (error) {
    await removeFolder(root);
    throw error;
  }
}

/** Polls until nothing of the root runs. */
async function quit(machine: Machine): Promise<void> {
  const deadline = Date.now() + QUIT_MS;
  while ((await chromesOf(machine.userDataDir)).length > 0) {
    if (Date.now() > deadline) throw new Error(`Chrome of ${machine.userDataDir} still runs`);
    await delay(POLL_MS);
  }
}

/** Builds the package, runs the README's first command, and checks the profile ended open with its ack. */
async function measure(machine: Machine, folder: string): Promise<Sample> {
  const readme = await readFile(join(folder, "README.md"), "utf8");
  const [program, ...args] = firstCommand(readme);
  if (program !== "sh") throw new Error(`The first command starts with ${String(program)}, not sh`);
  const first = await outcome(program, args, folder, machine.home);
  const problems: string[] = [];
  if (first.code !== 0) problems.push(`the first command exited ${first.code}: ${first.stderr}`);
  if (!first.stdout.startsWith(`${machine.profileId} open\n`))
    problems.push(`stdout was ${JSON.stringify(first.stdout)}`);
  const acks = join(machine.downloads, "RECnRun/poc", NAMESPACE, "acks", machine.profileId);
  const acked = await readdir(acks).catch(() => []);
  if (acked.length === 0) problems.push(`no ack under ${acks}`);
  else await readJson(join(acks, acked[0] ?? ""));
  const [, ...statusArgs] = readmeCommand(readme, "status", machine.home);
  const status = await outcome("sh", statusArgs, folder, machine.home);
  if (!new RegExp(`^${machine.profileId} open `, "m").test(status.stdout))
    problems.push(`status was ${JSON.stringify(status.stdout)}`);
  const [, ...stopArgs] = readmeCommand(readme, "stop", machine.home);
  const stop = await outcome("sh", stopArgs, folder, machine.home);
  if (stop.code !== 0) problems.push(`stop exited ${stop.code}: ${stop.stderr}`);
  await quit(machine).catch((error: unknown) => problems.push(String(error)));
  const observation = {
    command: [program, ...args].join(" "),
    first,
    status: status.stdout,
    acked,
  };
  const error = problems.length > 0 ? { error: problems.join("; ") } : {};
  return { ok: problems.length === 0, ...error, observation, steps: STEPS };
}

async function sample(): Promise<Sample> {
  const out = join(evidence().directory, "package");
  await run("node", [BUILD, out]);
  const machine = await prepare();
  try {
    const labels = [
      [machine.home, "<home>"],
      [machine.downloads, "<downloads>"],
      [dirname(machine.home), "<root>"],
      [evidence().directory, "<evidence>"],
    ] as const;
    return labelPaths(await measure(machine, join(out, "macos")), labels);
  } finally {
    try {
      for (const pid of await chromesOf(machine.userDataDir)) process.kill(pid, "SIGTERM");
    } finally {
      await machine.dispose();
    }
  }
}

test.describe("P4.6 on the host: the package's first command opens a profile", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test(`${HYPOTHESIS}: the README's first command registers, opens, and acks`, async () => {
    await recordHypothesis(
      {
        experiment: "P4.6",
        hypothesis: HYPOTHESIS,
        chrome: await target.chrome(),
        environment: target.environment,
        install: "loadUnpacked",
        label: "diagnostic",
        externalClient: true,
        variant: "poc-d0",
        topology: "one prepared profile at the default root of a throwaway HOME, Chrome closed",
        debugger: "none",
      },
      sample,
      { directory: target.directory?.() ?? evidence().directory },
    );
  });

  test("every P4.6 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.6", [HYPOTHESIS], evidence().directory);
  });
});
