import { expect, test, vi } from "vite-plus/test";
import { WorkspaceError } from "@/background/workspace/errors";
import { createLifecycle } from "@/background/workspace/lifecycle";
import { memoryRecordingStore } from "./fake-extension";
import { memoryOperationJournal } from "./fake-journal";
import { fakeEffects, identity, memoryIdentities } from "./fake-lifecycle";

/** A lifecycle with nothing open whose host check is `hosts`. */
function withHostCheck(hosts: (declared: readonly string[]) => Promise<void>) {
  const { memory, repository } = memoryIdentities([identity("a")]);
  const chrome = fakeEffects();
  const check = vi.fn(hosts);
  const lifecycle = createLifecycle({
    recordings: memoryRecordingStore(null),
    identities: repository,
    journal: memoryOperationJournal(),
    effects: chrome.effects,
    guard: { exclusive: (run) => run(), access: async () => {}, hosts: check },
  });
  return { lifecycle, chrome, memory, check };
}

const draft = (cookieHosts: string[]) => ({
  label: "Admin",
  url: "https://app.example/",
  capabilities: { cookieHosts },
});

test("new identity keeps each declared cookie host once, lowercased, after the build's check", async () => {
  const { lifecycle, chrome, check } = withHostCheck(async () => {});
  const created = await lifecycle.newIdentity(draft(["SSO.Example.com", "sso.example.com"]));
  expect(created.capabilities).toEqual({ cookieHosts: ["sso.example.com"] });
  expect(check).toHaveBeenCalledWith(["sso.example.com"]);
  expect(chrome.calls).toEqual([`start ${created.id} empty`]);
});

test("new identity opens nothing and keeps nothing for a host the build cannot reach", async () => {
  const refusal = new WorkspaceError("CookieHostNotAllowed", "No access to sso.example.com.");
  const { lifecycle, chrome, memory } = withHostCheck(async () => {
    throw refusal;
  });
  await expect(lifecycle.newIdentity(draft(["sso.example.com"]))).rejects.toBe(refusal);
  expect(chrome.calls).toEqual([]);
  expect(memory.saved.map(({ id }) => id)).toEqual(["a"]);
});

test("new identity refuses a cookie host that is no host name", async () => {
  const { lifecycle, check } = withHostCheck(async () => {});
  for (const host of ["a..b", ".example.com", "example.com.", "-"]) {
    await expect(lifecycle.newIdentity(draft([host])), host).rejects.toMatchObject({
      name: "IdentityNotValid",
    });
  }
  expect(check).not.toHaveBeenCalled();
});
