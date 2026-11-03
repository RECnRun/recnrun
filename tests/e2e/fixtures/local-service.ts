import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { launchChrome, type LaunchedChrome } from "../../browser/fixtures/chrome.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The ports `playwright.config.ts` starts the fixture application on. */
export const FIXTURE_ORIGIN = "http://127.0.0.1:4600";

/** The default Chrome profile folder of `home`, where the service's discovery looks. */
function defaultProfile(home: string): string {
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "Google", "Chrome");
  return join(home, ".config", "google-chrome");
}

/** The environment of the service: its home and Chrome discovery stay inside the temporary home. */
const serviceEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  CHROME_CONFIG_HOME: join(home, ".config"),
  LOCALAPPDATA: join(home, "AppData"),
  RECNRUN_FORBID_EGRESS: "1",
});

export interface ServiceChild {
  readonly url: string;
  /** Sends SIGTERM and resolves with the exit code. */
  stop(): Promise<number | null>;
}

/** Runs `apps/service/src/bin.ts` as a person's `recnrun open` would, on the temporary home. */
export async function startServiceChild(home: string): Promise<ServiceChild> {
  const child = spawn(process.execPath, [join(ROOT, "apps/service/src/bin.ts")], {
    env: serviceEnv(home),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) throw new Error("The service exited before printing its port.");
  const started = JSON.parse(String(first.value)) as { reused: boolean; port: number };
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  return {
    url: `http://127.0.0.1:${started.port}/`,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      return exited;
    },
  };
}

/** A temporary home whose default Chrome profile runs, with remote debugging on a free port. */
export async function homeWithChrome(): Promise<{ home: string; chrome: LaunchedChrome }> {
  const home = await mkdtemp(join(tmpdir(), "recnrun-first-flow-"));
  const chrome = await launchChrome({ userDataDir: defaultProfile(home) });
  return { home, chrome };
}

export const removeHome = (home: string) =>
  rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** What the service stored for a flow: its revisions and each run's summary status. */
export async function storedFlow(home: string, flowId: string) {
  const folder = join(home, ".recnrun", "flows", flowId);
  const yaml = await readFile(join(folder, "flow.yaml"), "utf8");
  const revisions = await readdir(join(folder, "revisions"));
  const runs = await readdir(join(folder, "runs"));
  const statuses = await Promise.all(
    runs.map(async (runId) => {
      const summary = await readFile(join(folder, "runs", runId, "summary.json"), "utf8");
      return (JSON.parse(summary) as { status: string }).status;
    }),
  );
  return { yaml, revisions, statuses };
}
