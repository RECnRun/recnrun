import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { bootstrap, startBootstrap } from "@/diagnostics/bootstrap";
import { MASTER, MASTER_KEY } from "./role-fixture";

const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const INSTANCE = "44444444-4444-4444-8444-444444444444";
const OPERATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CLONE = `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones&master=${MASTER}.${MASTER_KEY}`;
const REFUSED =
  "The address carries no #clone=<token>&instance=<uuid>&operation=<uuid>&namespace=<namespace>&master=<profile id>.<identity key>.";
const PROVISION = {
  type: "POC_PROVISION_CLONE",
  token: TOKEN,
  instanceId: INSTANCE,
  operationId: OPERATION,
  namespace: "clones",
  masterProfileId: MASTER,
  masterIdentity: MASTER_KEY,
};

function dependencies(hash: string, reply: unknown = { ok: true }) {
  return {
    hash,
    adopt: vi.fn(async (_token: string) => {}),
    enterTemplate: vi.fn(async (_setting: string) => {}),
    send: vi.fn(async (_message: unknown) => reply),
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bootstrap of a clone", () => {
  test("sends its worker exactly the parsed fields, once, and stores nothing itself", async () => {
    const deps = dependencies(CLONE);
    expect(await bootstrap(deps)).toEqual({
      ok: true,
      token: TOKEN,
      clone: true,
      instanceId: INSTANCE,
      operationId: OPERATION,
      acked: true,
    });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith(PROVISION);
    expect(deps.adopt).not.toHaveBeenCalled();
    expect(deps.enterTemplate).not.toHaveBeenCalled();
  });

  test("shows the worker's refusal, a conflicting identity included", async () => {
    const conflict = "conflicting identity: provisioned as 55555555-5555-4555-8555-555555555555";
    const deps = dependencies(CLONE, { ok: false, error: conflict });
    expect(await bootstrap(deps)).toEqual({ ok: false, error: conflict });
    const malformed = dependencies(CLONE, "garbage");
    expect(await bootstrap(malformed)).toEqual({
      ok: false,
      error: "The background sent a malformed reply to POC_PROVISION_CLONE.",
    });
  });

  test.each([
    `${CLONE}&role=master`,
    `#clone=${TOKEN}&role=master&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&operation=${OPERATION}&instance=${INSTANCE}&namespace=clones&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION.toUpperCase()}&namespace=clones&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=Clones&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=1clones&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=${"a".repeat(33)}&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=../x&master=${MASTER}.${MASTER_KEY}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones&master=${MASTER}.${MASTER_KEY.slice(1)}`,
    `#clone=${TOKEN}&instance=${INSTANCE}&operation=${OPERATION}&namespace=clones&master=${MASTER}`,
    `#clone=${TOKEN}&instance=0f8b6a3e-2c1d-1e5f-9a7b-1c2d3e4f5a6b&operation=${OPERATION}&namespace=clones&master=${MASTER}.${MASTER_KEY}`,
    `${CLONE} `,
    `${CLONE}#token=${TOKEN}`,
  ])("refuses the fragment %j, storing and sending nothing", async (hash) => {
    const deps = dependencies(hash);
    expect(await bootstrap(deps)).toEqual({ ok: false, error: REFUSED });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.adopt).not.toHaveBeenCalled();
  });
});

describe("startBootstrap of a clone", () => {
  test("shows the provisioning's result, having sent only the provisioning", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const shown = { textContent: "" };
    const page = { location: { hash: CLONE }, document: { getElementById: () => shown } };
    await startBootstrap(page as unknown as Window & typeof globalThis);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PROVISION);
    expect(JSON.parse(shown.textContent)).toMatchObject({ ok: true, clone: true, acked: true });
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });
});
