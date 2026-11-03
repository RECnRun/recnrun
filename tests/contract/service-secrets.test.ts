import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { startService, type RunningService } from "../../apps/service/src/index.ts";
import type { ReplayDriver } from "../../packages/engine/src/index.ts";
import { fakeChrome } from "./fake-chrome.ts";
import { command, tempHome } from "./helpers.ts";

const PIN = "pin-7351-never-stored";
const TOKEN = "token-9902-never-stored";

const FLOW = {
  schemaVersion: 1,
  id: "pin-login",
  name: "Log in with a PIN",
  inputs: { pin: { type: "string", required: true, secret: true } },
  steps: [
    { id: "pin", action: "fill", target: { testId: "pin" }, value: "${inputs.pin}" },
    { id: "token", action: "fill", target: { testId: "token" }, value: "${secrets.token}" },
  ],
};

let home = "";
afterEach(() => rm(home, { recursive: true, force: true }));

/** A driver whose field keeps what the replay fills, so a fill reads back its own value. */
function fillingDriver(filled: string[]): ReplayDriver {
  const state = { count: 1, visible: true, enabled: true, editable: true, text: "" };
  return {
    inspect: async () => ({ ...state, value: filled.at(-1) ?? "" }),
    readAttribute: async () => null,
    tabs: async () => ({ tabs: [{ url: "http://127.0.0.1:4600/", title: "" }], current: 0 }),
    act: async (step) => {
      if ("value" in step) filled.push(step.value);
      return { status: "done" };
    },
  };
}

/** Every file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

let next = 0;
async function call(service: RunningService, name: string, params: unknown) {
  next += 1;
  const { json } = await command(service, { requestId: `s-${next}`, command: name, params });
  return json as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
}

test("a replay's secrets resolve in the executor and never reach the run files or the log", async () => {
  home = await tempHome();
  const filled: string[] = [];
  const adapter = {
    ...fakeChrome().adapter,
    replayDriver: async () => ({ driver: fillingDriver(filled), close: async () => {} }),
  };
  const started = await startService({ home, adapter });
  if (started.reused) throw new Error(`A service already runs for ${home}.`);
  const { service } = started;
  expect(await call(service, "flow.import", { flow: FLOW })).toMatchObject({ ok: true });
  const replay = await call(service, "flow.replay", {
    flowId: FLOW.id,
    secrets: { pin: PIN, token: TOKEN },
  });
  expect(replay).toMatchObject({ ok: true });
  const runId = String(replay.result?.["runId"]);
  await expect.poll(async () => (await call(service, "run.summary", { runId })).ok).toBe(true);
  expect((await call(service, "run.summary", { runId })).result).toMatchObject({
    status: "passed",
  });
  expect(filled).toEqual([PIN, TOKEN]);
  await service.stop();
  const files = await filesUnder(home);
  expect(files.some((file) => file.includes(runId))).toBe(true);
  expect(files.some((file) => file.endsWith(".log"))).toBe(true);
  for (const file of files) {
    const text = (await readFile(file)).toString("latin1");
    expect({ file, leaks: [PIN, TOKEN].filter((secret) => text.includes(secret)) }).toEqual({
      file,
      leaks: [],
    });
  }
});
