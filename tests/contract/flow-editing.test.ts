import { rm } from "node:fs/promises";
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

const OPEN = { id: "open", action: "navigate", url: "http://127.0.0.1:4600/routes/form" };
const NAME = { id: "name", action: "fill", target: { testId: "name" }, value: "Ada" };

const FLOW = {
  schemaVersion: 1,
  id: "form",
  name: "Submit the form",
  actors: {},
  inputs: {},
  requirements: [],
  preconditions: [],
  steps: [OPEN, NAME],
};

type Saved = { flowId: string; revision: string };
type Revisions = { revision: string }[];
type Stored = {
  flow: { steps: { value?: string }[] };
  manifest: { status: string; revisions: Revisions };
  revision: string;
};

test("flow.getRevision reads an earlier revision after an edit", async () => {
  const first = await result<Saved>("flow.save", { flow: FLOW });
  const parameterized = {
    ...FLOW,
    inputs: { name: { type: "string", default: "Ada" } },
    steps: [OPEN, { ...NAME, value: "${inputs.name}" }],
  };
  const second = await result<Saved>("flow.save", { flow: parameterized });
  expect(second.revision).not.toBe(first.revision);
  const current = await result<Stored>("flow.get", { flowId: "form" });
  const history = current.manifest.revisions.map(({ revision }) => revision);
  expect(history).toEqual([first.revision, second.revision]);
  const old = await result<Stored>("flow.getRevision", {
    flowId: "form",
    revision: first.revision,
  });
  expect(old.revision).toBe(first.revision);
  expect(old.flow.steps[1]?.value).toBe("Ada");
  expect(current.flow.steps[1]?.value).toBe("${inputs.name}");
  const latest = await call("flow.getRevision", { flowId: "form", revision: "latest" });
  expect(latest.error?.code).toBe("invalid-request");
  const unknown = await call("flow.getRevision", { flowId: "form", revision: "0".repeat(64) });
  expect(unknown.error?.code).toBe("not-found");
  const noFlow = await call("flow.getRevision", { flowId: "nope", revision: first.revision });
  expect(noFlow.error?.code).toBe("not-found");
});

test("flow.duplicate stores a draft copy and refuses an existing id", async () => {
  await result<Saved>("flow.save", { flow: FLOW });
  const copy = await result<Saved>("flow.duplicate", {
    flowId: "form",
    newId: "form-copy",
    name: "Copy of the form",
  });
  expect(copy.flowId).toBe("form-copy");
  const stored = await result<Stored>("flow.get", { flowId: "form-copy" });
  expect(stored.flow).toMatchObject({
    id: "form-copy",
    name: "Copy of the form",
    steps: FLOW.steps,
  });
  expect(stored.manifest).toMatchObject({
    status: "draft",
    revisions: [{ revision: copy.revision }],
  });
  const listed = await result<{ flows: { id: string }[] }>("flow.list", {});
  expect(listed.flows.map(({ id }) => id).toSorted()).toEqual(["form", "form-copy"]);
  const taken = await call("flow.duplicate", { flowId: "form", newId: "form-copy" });
  expect(taken.error?.code).toBe("conflict");
  const missing = await call("flow.duplicate", { flowId: "missing", newId: "x" });
  expect(missing.error?.code).toBe("not-found");
  const badId = await call("flow.duplicate", { flowId: "form", newId: "bad id" });
  expect(badId.error?.code).toBe("invalid-request");
});
