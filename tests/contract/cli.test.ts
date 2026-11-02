import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  startService,
  type CommandHandlers,
  type RunningService,
} from "../../apps/service/src/index.ts";
import {
  RUN_EXIT_CODES,
  parseDoctorReport,
  type RunStatus,
  type RunSummary,
} from "../../packages/protocol/src/index.ts";
import { NO_CHROME, runCli, runNode, tempHome } from "./helpers.ts";

const FLOW = fileURLToPath(new URL("../browser/fixtures/replay-spike.flow.json", import.meta.url));
const BIN = "apps/cli/src/bin.ts";

let home = "";
beforeEach(async () => {
  home = await tempHome();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const summaryOf = (status: RunStatus): RunSummary => ({
  schemaVersion: 1,
  runId: `run-${status}`,
  flowId: "form-submit",
  status,
  exitCode: RUN_EXIT_CODES[status],
  startedAt: "2026-11-02T10:00:00.000Z",
  endedAt: "2026-11-02T10:00:01.000Z",
  counts: {
    total: 1,
    pending: 0,
    running: 0,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    blocked: 0,
    cancelled: 0,
    indeterminate: 0,
  },
  failures: status === "failed" ? [{ stepId: "open", message: "The status never appeared." }] : [],
});

// The dataset names the status the canned replay ends with.
const canned: CommandHandlers = {
  "flow.replay": async ({ dataset }) => ({ runId: `run-${dataset ?? "passed"}` }),
  "run.summary": async ({ runId }) => summaryOf(runId.replace("run-", "") as RunStatus),
};

async function withService<T>(handlers: CommandHandlers, work: () => Promise<T>): Promise<T> {
  const started = await startService({ home, discover: async () => NO_CHROME, handlers });
  if (started.reused) throw new Error("A service already runs for this home.");
  const service: RunningService = started.service;
  try {
    return await work();
  } finally {
    await service.stop();
  }
}

test("--version and --help", async () => {
  const version = await runCli(["--version"], home);
  expect(version).toMatchObject({
    code: 0,
    stdout: expect.stringMatching(/^recnrun \d+\.\d+\.\d+\n$/),
  });
  const help = await runCli(["--help"], home);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("open [--no-browser]");
  expect(help.stdout).toContain("run --flow");
  expect(help.stdout).toContain("doctor [--json]");
});

test("an unknown command is exit 2 with the reason on stderr", async () => {
  const result = await runCli(["frobnicate"], home);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('Unknown command "frobnicate"');
});

test("open starts the service, writes service.json at 0600, and a second open reuses it", async () => {
  const first = runNode(BIN, ["open", "--no-browser", "--home", home], home);
  const url = await first.nextLine();
  const port = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(url)?.[1];
  expect(port).toBeDefined();
  const state = await stat(join(home, ".recnrun", "service.json"));
  expect(state.mode & 0o777).toBe(0o600);

  const second = await runCli(["open", "--no-browser", "--home", home], home);
  expect(second).toMatchObject({ code: 0, stdout: `${url}\n` });

  first.child.kill("SIGTERM");
  expect(await first.exited).toBe(0);
});

test("doctor --json reports a machine with no Chrome and exits 1", async () => {
  const result = await runCli(["doctor", "--json", "--home", home], home);
  expect(result.code).toBe(1);
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  const parsed = parseDoctorReport(JSON.parse(result.stdout));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toMatchObject({
    ok: false,
    chrome: { ok: false, code: "missing-file" },
    remoteDebugging: { state: "not-found" },
    bindings: { count: 0, stale: [] },
    node: { satisfies: true },
  });
  expect(parsed.value.chrome.userDataDir).toContain(home);
});

test("doctor prints aligned lines and the remedy, and reuses a running service", async () => {
  await withService({}, async () => {
    const result = await runCli(["doctor", "--home", home], home);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^Node: +\S/m);
    expect(result.stdout).toContain("chrome://inspect/#remote-debugging");
    expect(result.stdout).toContain("/nowhere/DevToolsActivePort");
  });
});

test.each(["passed", "failed", "error"] as const)(
  "run of a %s replay exits with its status code and prints exactly one JSON summary",
  async (status) => {
    await withService(canned, async () => {
      const result = await runCli(
        ["run", "--flow", FLOW, "--dataset", status, "--json", "--home", home],
        home,
      );
      expect(result.code).toBe(RUN_EXIT_CODES[status]);
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual(summaryOf(status));
      expect(result.stderr).toContain(`run-${status}`);
    });
  },
);

test("run of an invalid flow exits 2 with the validation message on stderr", async () => {
  const folder = join(home, "bad-flow");
  await mkdir(folder);
  await writeFile(join(folder, "flow.yaml"), "id: 1\n");
  const result = await runCli(
    ["run", "--flow", folder, "--dataset", "default", "--home", home],
    home,
  );
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("not a valid flow");
});

test("run with a service that has no executor yet exits 2 naming capability-unavailable", async () => {
  const result = await runCli(
    ["run", "--flow", FLOW, "--dataset", "default", "--home", home],
    home,
  );
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("capability-unavailable");
});
