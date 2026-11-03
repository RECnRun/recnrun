import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
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
import { fakeChrome } from "./fake-chrome.ts";
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

// The dataset's `name` input names the status the canned replay ends with.
const canned: CommandHandlers = {
  "flow.replay": async ({ inputs }) => {
    const status = inputs?.["name"];
    return { runId: `run-${typeof status === "string" ? status : "passed"}` };
  },
  "run.summary": async ({ runId }) => summaryOf(runId.replace("run-", "") as RunStatus),
};

/** A flow folder outside the store: `flow.yaml` (JSON is YAML) and `datasets/<name>.json`. */
async function flowFolder(flow: unknown, datasets: Record<string, Record<string, unknown>>) {
  const folder = join(home, "flow-folder");
  await mkdir(join(folder, "datasets"), { recursive: true });
  await writeFile(join(folder, "flow.yaml"), JSON.stringify(flow));
  for (const [name, inputs] of Object.entries(datasets))
    await writeFile(
      join(folder, "datasets", `${name}.json`),
      JSON.stringify({ schemaVersion: 1, inputs }),
    );
  return folder;
}

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
    const flow: unknown = JSON.parse(await readFile(FLOW, "utf8"));
    const folder = await flowFolder(flow, { [status]: { name: status } });
    await withService(canned, async () => {
      const result = await runCli(
        ["run", "--flow", folder, "--dataset", status, "--json", "--home", home],
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

test("run --dataset replays with the inputs of the flow folder's own dataset", async () => {
  const flow = {
    schemaVersion: 1,
    id: "greet",
    name: "Greet",
    inputs: { name: { type: "string", required: true } },
    steps: [{ id: "name", action: "fill", target: { testId: "name" }, value: "${inputs.name}" }],
  };
  const folder = await flowFolder(flow, { default: { name: "Ada" } });
  const chrome = fakeChrome();
  chrome.release();
  const started = await startService({ home, adapter: chrome.adapter });
  if (started.reused) throw new Error("A service already runs for this home.");
  try {
    const result = await runCli(
      ["run", "--flow", folder, "--dataset", "default", "--home", home],
      home,
    );
    expect(result.stderr).not.toContain("failed");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ flowId: "greet", status: "passed" });
    expect(chrome.writes).toEqual(["fill"]);
    const missing = await runCli(
      ["run", "--flow", folder, "--dataset", "nightly", "--home", home],
      home,
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("datasets/nightly.json");
  } finally {
    await started.service.stop();
  }
});

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

test("run with no Chrome to replay in exits 2 naming capability-unavailable", async () => {
  const result = await runCli(["run", "--flow", FLOW, "--home", home], home);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("capability-unavailable");
});

/** A DevToolsActivePort whose port accepts and never answers, so a replay stays connecting. */
async function silentChrome() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("No port.");
  const profile = join(home, ".config", "google-chrome");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "DevToolsActivePort"), `${address.port}\n/devtools/browser/x\n`);
  return () => {
    sockets.forEach((socket) => socket.destroy());
    server.close();
  };
}

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)(
  "%s during run stops the service the CLI started and exits %i",
  async (signal, code) => {
    const close = await silentChrome();
    try {
      const cli = runNode(BIN, ["run", "--flow", FLOW, "--home", home], home);
      // The flow is imported once the CLI's own service answers; the replay then hangs on Chrome.
      const flows = join(home, ".recnrun", "flows");
      await expect
        .poll(() => readdir(flows).catch(() => []), { timeout: 10_000 })
        .toContain("form-submit");
      await stat(join(home, ".recnrun", "service.json"));
      cli.child.kill(signal);
      expect(await cli.exited).toBe(code);
      await expect(stat(join(home, ".recnrun", "service.json"))).rejects.toThrow(/ENOENT/);
    } finally {
      close();
    }
  },
);
