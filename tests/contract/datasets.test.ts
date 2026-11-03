import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { RunningService } from "../../apps/service/src/index.ts";
import type { CommandName } from "../../packages/protocol/src/index.ts";
import { command, startFresh, tempHome } from "./helpers.ts";

let home = "";
let service: RunningService;
let next = 0;

beforeEach(async () => {
  home = await tempHome();
  service = await startFresh(home);
});

afterEach(async () => {
  await service.stop();
  await rm(home, { recursive: true, force: true });
});

type Envelope = { ok: boolean; result?: unknown; error?: { code: string; message: string } };

async function call(name: CommandName, params: unknown): Promise<Envelope> {
  next += 1;
  const { json } = await command(service, { requestId: `r-${next}`, command: name, params });
  return json as Envelope;
}

async function result<T>(name: CommandName, params: unknown): Promise<T> {
  const envelope = await call(name, params);
  expect(envelope).toMatchObject({ ok: true });
  return envelope.result as T;
}

const FLOW = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: {
    email: { type: "string", required: true },
    retries: { type: "number", required: false, default: 2 },
    password: { type: "string", required: true, secret: true },
  },
  requirements: [],
  preconditions: [],
  steps: [{ id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/form" }],
};

type Listed = { datasets: { name: string; inputs: Record<string, unknown>; problem?: string }[] };

test("dataset.save stores a flow's input values and dataset.list reads them back", async () => {
  await result("flow.save", { flow: FLOW });
  expect(await result<Listed>("dataset.list", { flowId: "login" })).toEqual({ datasets: [] });
  const inputs = { email: "ana@example.com", retries: 3 };
  expect(await result("dataset.save", { flowId: "login", name: "ana", inputs })).toEqual({
    name: "ana",
  });
  const folder = join(home, ".recnrun", "flows", "login", "datasets");
  expect(await readdir(folder)).toEqual(["ana.json"]);
  expect(JSON.parse(await readFile(join(folder, "ana.json"), "utf8"))).toEqual({
    schemaVersion: 1,
    inputs,
  });
  await writeFile(
    join(folder, "stale.json"),
    JSON.stringify({ schemaVersion: 1, inputs: { email: "x", nope: true } }),
  );
  const listed = await result<Listed>("dataset.list", { flowId: "login" });
  expect(listed.datasets).toEqual([
    { name: "ana", inputs },
    {
      name: "stale",
      inputs: {},
      problem: expect.stringContaining('Input "nope" is not declared in the flow'),
    },
  ]);
  const missing = await call("dataset.list", { flowId: "nope" });
  expect(missing.error?.code).toBe("not-found");
});

test("dataset.save refuses a secret, a wrong type, and an undeclared input, writing nothing", async () => {
  await result("flow.save", { flow: FLOW });
  const refused = [
    { password: "hunter2" },
    { retries: "3" },
    { nope: 1 },
    { email: "ana@example.com", password: "hunter2" },
  ];
  for (const inputs of refused) {
    const answer = await call("dataset.save", { flowId: "login", name: "bad", inputs });
    expect(answer.error?.code).toBe("invalid-request");
    expect(JSON.stringify(answer)).not.toContain("hunter2");
  }
  const folder = join(home, ".recnrun", "flows", "login", "datasets");
  await expect(readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
  const badName = await call("dataset.save", { flowId: "login", name: "bad name", inputs: {} });
  expect(badName.error?.code).toBe("invalid-request");
  const noFlow = await call("dataset.save", { flowId: "nope", name: "ana", inputs: {} });
  expect(noFlow.error?.code).toBe("not-found");
});
