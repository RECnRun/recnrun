import { join } from "node:path";
import type { BrowserHandshake } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import type { CdpSession } from "../src/cdp-link.ts";
import { createCdpAdapter } from "../src/index.ts";
import { describeProfile } from "../src/profile.ts";
import { VERSION, fakeChrome, fakeTransport, page } from "./fake-cdp.ts";

const HANDSHAKE: BrowserHandshake = {
  endpoint: "ws://127.0.0.1:9222/devtools/browser/one",
  version: VERSION,
  domains: [],
};

function session(contexts: unknown): CdpSession & { calls: string[] } {
  const calls: string[] = [];
  const targets = [
    { ...page("P1"), browserContextId: "DEFAULT" },
    { ...page("P2"), browserContextId: "ISOLATED" },
    { ...page("P3"), browserContextId: "LATE" },
    { targetId: "B", type: "browser", url: "", title: "", attached: true },
  ];
  return {
    calls,
    send(method) {
      calls.push(method);
      if (method === "Target.getBrowserContexts") return Promise.resolve(contexts);
      if (method === "Target.getTargets") return Promise.resolve({ targetInfos: targets });
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  };
}

test("describes the profile from the contexts and targets Chrome reports", async () => {
  const cdp = session({ browserContextIds: ["ISOLATED"], defaultBrowserContextId: "DEFAULT" });
  expect(await describeProfile(cdp, HANDSHAKE, { userDataDir: "/profiles/ana" })).toEqual({
    userDataDir: "/profiles/ana",
    browserContextIds: ["DEFAULT", "ISOLATED", "LATE"],
    chrome: "Chrome/156.0.8078.79",
  });
  expect(cdp.calls).toEqual(["Target.getBrowserContexts", "Target.getTargets"]);
});

test("takes the profile folder from the DevToolsActivePort it was found through", async () => {
  const activePortFile = join("/profiles", "bob", "DevToolsActivePort");
  const described = await describeProfile(session({ browserContextIds: [] }), HANDSHAKE, {
    activePortFile,
  });
  expect(described).toMatchObject({
    userDataDir: join("/profiles", "bob"),
    browserContextIds: ["DEFAULT", "ISOLATED", "LATE"],
  });
});

test("needs the profile folder the connection came from", async () => {
  await expect(
    describeProfile(session({ browserContextIds: [] }), HANDSHAKE, undefined),
  ).rejects.toThrow("connect with a userDataDir or activePortFile");
});

test("rejects a malformed Target.getBrowserContexts reply", async () => {
  const cdp = session({ browserContextIds: "DEFAULT" });
  await expect(describeProfile(cdp, HANDSHAKE, { userDataDir: "/p" })).rejects.toThrow();
});

test("the adapter describes the profile of its current connection", async () => {
  const chrome = fakeChrome({ failing: { "Target.getBrowserContexts": "not today" } });
  const adapter = createCdpAdapter({ transport: fakeTransport(chrome).transport });
  await expect(adapter.describeProfile()).rejects.toThrow("Not connected to Chrome");
  await adapter.connect(HANDSHAKE.endpoint, { source: { userDataDir: "/p" } });
  await expect(adapter.describeProfile()).rejects.toThrow("not today");
});
