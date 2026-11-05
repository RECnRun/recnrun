import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createProvisionListener, provisionClone } from "@/background/clone-provisioning";
import type { CloneRequest, ProvisionDependencies } from "@/background/clone-provisioning";
import { identityRepository } from "@/storage/peer-repository";
import { storedRoles } from "@/storage/hierarchy-repository";
import { MASTER, MASTER_KEY, OTHER_KEY, OTHER_MASTER, roleRepository } from "./role-fixture";
import { signAs } from "./test-identity";

const BASE = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "44444444-4444-4444-8444-444444444444";
const OTHER_INSTANCE = "55555555-5555-4555-8555-555555555555";
const TOKEN = "0f8b6a3e-2c1d-4e5f-9a7b-1c2d3e4f5a6b";
const OPERATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const STATEMENT = await signAs({ profileId: INSTANCE, fingerprint: "AB:CD" });
const request: CloneRequest = {
  token: TOKEN,
  instanceId: INSTANCE,
  operationId: OPERATION,
  namespace: "clones",
  masterProfileId: MASTER,
  masterIdentity: MASTER_KEY,
};
const provisioned = {
  role: "worker",
  masterProfileId: MASTER,
  masterIdentity: MASTER_KEY,
  boundAt: expect.any(Number),
  source: "bootstrap",
};

function dependencies() {
  const calls: string[] = [];
  const step = (name: string) => async () => void calls.push(name);
  const deps = {
    roles: storedRoles(),
    identity: identityRepository,
    namespace: {
      read: async () => (await fakeBrowser.storage.local.get("pocNamespace")).pocNamespace,
      write: (namespace: string) => fakeBrowser.storage.local.set({ pocNamespace: namespace }),
    },
    discard: vi.fn(step("discard")),
    clearTransient: vi.fn(step("clear")),
    adoptBoot: vi.fn(async (_token: string) => void calls.push("adopt")),
    statement: vi.fn(async (_profileId: string) => {
      calls.push("statement");
      return STATEMENT;
    }),
    ack: vi.fn(
      async (_token: string, _identity: unknown, _clone: unknown) => void calls.push("ack"),
    ),
    start: vi.fn(step("start")),
  } satisfies ProvisionDependencies;
  return { deps, calls };
}

beforeEach(async () => {
  fakeBrowser.reset();
  await identityRepository.write({ profileId: BASE, displayName: "Profile 1111" });
  await fakeBrowser.storage.local.set({ pocNamespace: "lab" });
});

describe("provisioning a copied template", () => {
  test("clears the copy, takes the instance's identity, binds the master, acks, then starts", async () => {
    await roleRepository.write({ role: "template" });
    const { deps, calls } = dependencies();
    await provisionClone(deps, request);
    expect(calls).toEqual(["discard", "clear", "adopt", "statement", "ack", "start"]);
    expect(await identityRepository.read()).toEqual({
      profileId: INSTANCE,
      displayName: "Profile 4444",
    });
    expect((await fakeBrowser.storage.local.get("pocNamespace")).pocNamespace).toBe("clones");
    expect(await roleRepository.read()).toEqual(provisioned);
    expect(deps.statement).toHaveBeenCalledWith(INSTANCE);
    expect(deps.adoptBoot).toHaveBeenCalledWith(TOKEN);
    expect(deps.ack).toHaveBeenCalledWith(TOKEN, STATEMENT, {
      instanceId: INSTANCE,
      operationId: OPERATION,
      provisioned: true,
    });
  });

  test.each([
    ["the same operation", OPERATION],
    ["another operation", "6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"],
  ])(
    "again, for %s, rewrites the ack with the current identity and changes nothing else",
    async (_name, operationId) => {
      await roleRepository.write({ role: "template" });
      await provisionClone(dependencies().deps, request);
      const before = await fakeBrowser.storage.local.get(null);
      const { deps, calls } = dependencies();
      await provisionClone(deps, { ...request, operationId });
      expect(calls).toEqual(["adopt", "statement", "ack", "start"]);
      expect(deps.ack).toHaveBeenCalledWith(TOKEN, STATEMENT, {
        instanceId: INSTANCE,
        operationId,
        provisioned: true,
      });
      expect(await fakeBrowser.storage.local.get(null)).toEqual(before);
    },
  );

  test.each([
    ["the statement", "statement"],
    ["the ack", "ack"],
  ] as const)(
    "leaves no worker role when %s fails, and a rerun completes",
    async (_name, failing) => {
      await roleRepository.write({ role: "template" });
      const { deps } = dependencies();
      deps[failing].mockRejectedValueOnce(new Error("boom"));
      await expect(provisionClone(deps, request)).rejects.toThrow("boom");
      expect(await roleRepository.read()).toEqual({ role: "template" });
      expect(deps.start).not.toHaveBeenCalled();
      await provisionClone(deps, request);
      expect(await roleRepository.read()).toEqual(provisioned);
      expect(deps.start).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["another instance", { instanceId: OTHER_INSTANCE }],
    ["another master", { masterProfileId: OTHER_MASTER }],
    ["another master key", { masterIdentity: OTHER_KEY }],
    ["another namespace", { namespace: "elsewhere" }],
  ])(
    "refuses %s of a provisioned clone, changing nothing and writing no ack",
    async (_name, change) => {
      await roleRepository.write({ role: "template" });
      await provisionClone(dependencies().deps, request);
      const before = await fakeBrowser.storage.local.get(null);
      const { deps, calls } = dependencies();
      await expect(provisionClone(deps, { ...request, ...change })).rejects.toThrow(
        /^conflicting identity: /,
      );
      expect(calls).toEqual([]);
      expect(await fakeBrowser.storage.local.get(null)).toEqual(before);
    },
  );

  test.each([
    ["an unassigned profile", null],
    ["the master", { role: "master", profileId: MASTER, identity: MASTER_KEY }],
  ] as const)("refuses %s, which is no template", async (_name, record) => {
    await roleRepository.write(record);
    const before = await fakeBrowser.storage.local.get(null);
    const { deps, calls } = dependencies();
    await expect(provisionClone(deps, request)).rejects.toThrow(/^conflicting identity: /);
    expect(calls).toEqual([]);
    expect(await fakeBrowser.storage.local.get(null)).toEqual(before);
  });
});

describe("createProvisionListener", () => {
  const own = { extensionId: "own", extensionUrl: "chrome-extension://own/" };
  const hashOf = (r: CloneRequest) =>
    `#clone=${r.token}&instance=${r.instanceId}&operation=${r.operationId}&namespace=${r.namespace}&master=${r.masterProfileId}.${r.masterIdentity}`;
  const page = { id: "own", url: `chrome-extension://own/bootstrap.html${hashOf(request)}` };
  const message = { type: "POC_PROVISION_CLONE", ...request };

  test("provisions for the extension's own page with exactly the parsed fields", async () => {
    const provision = vi.fn(async (_request: CloneRequest) => {});
    const reply = vi.fn();
    expect(createProvisionListener(provision, own)(message, page, reply)).toBe(true);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(provision).toHaveBeenCalledWith(request);
  });

  test("runs two requests one after the other, so neither discards what the other made", async () => {
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const provision = vi.fn(async ({ operationId }: CloneRequest) => {
      order.push(`start ${operationId}`);
      if (operationId === OPERATION) await held;
      order.push(`end ${operationId}`);
    });
    const listener = createProvisionListener(provision, own);
    const again = { ...message, operationId: "6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };
    const againPage = { ...page, url: `chrome-extension://own/bootstrap.html${hashOf(again)}` };
    const reply = vi.fn();
    listener(message, page, reply);
    listener(again, againPage, reply);
    await vi.waitFor(() => expect(order).toEqual([`start ${OPERATION}`]));
    release();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    expect(order).toEqual([
      `start ${OPERATION}`,
      `end ${OPERATION}`,
      `start ${again.operationId}`,
      `end ${again.operationId}`,
    ]);
  });

  test("replies with the refusal's diagnostic", async () => {
    const provision = vi.fn(async () => Promise.reject(new Error("conflicting identity: x")));
    const reply = vi.fn();
    createProvisionListener(provision, own)(message, page, reply);
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ ok: false, error: "conflicting identity: x" }),
    );
  });

  test.each([
    ["a role", { ...message, role: "master" }, page],
    ["a malformed instance", { ...message, instanceId: "nope" }, page],
    ["a namespace with a path", { ...message, namespace: "../x" }, page],
    ["a short master key", { ...message, masterIdentity: "short" }, page],
    ["another extension", message, { ...page, id: "stranger" }],
    ["a web page", message, { id: "own", url: "https://recnrun.com/" }],
    [
      "the dashboard",
      message,
      { ...page, url: `chrome-extension://own/dashboard.html${hashOf(request)}` },
    ],
    [
      "a bootstrap page without a clone fragment",
      message,
      { ...page, url: "chrome-extension://own/bootstrap.html" },
    ],
    [
      "a bootstrap page of a template",
      message,
      { ...page, url: "chrome-extension://own/bootstrap.html#template=x&setting=base-v1" },
    ],
    [
      "a bootstrap address with a query",
      message,
      { ...page, url: page.url.replace("bootstrap.html", "bootstrap.html?x=1") },
    ],
    [
      "another token than the address",
      { ...message, token: "6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" },
      page,
    ],
    ["another instance than the address", { ...message, instanceId: OTHER_INSTANCE }, page],
    [
      "another operation than the address",
      { ...message, operationId: "6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" },
      page,
    ],
    ["another namespace than the address", { ...message, namespace: "elsewhere" }, page],
    ["another master than the address", { ...message, masterProfileId: OTHER_MASTER }, page],
    ["another master key than the address", { ...message, masterIdentity: OTHER_KEY }, page],
  ])("ignores %s", (_name, sent, sender) => {
    const provision = vi.fn(async () => {});
    expect(createProvisionListener(provision, own)(sent, sender, vi.fn())).toBe(false);
    expect(provision).not.toHaveBeenCalled();
  });
});
