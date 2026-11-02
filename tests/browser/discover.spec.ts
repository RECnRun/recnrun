import { discover } from "../../packages/adapter/src/index.ts";
import { expect, test } from "./fixtures/chrome.ts";

test("discovers the running Chrome through its user-data dir", async ({ chrome }) => {
  const result = await discover({ userDataDir: chrome.userDataDir });
  console.log(`discover() on ${chrome.version}: ${JSON.stringify(result)}`);
  expect(result).toEqual({
    ok: true,
    wsEndpoint: chrome.wsEndpoint,
    userDataDir: chrome.userDataDir,
    source: "active-port-file",
    port: chrome.port,
    path: chrome.wsPath,
  });
});

test("reports a stale file once that Chrome is gone", async ({ chrome }) => {
  process.kill(chrome.pid, "SIGKILL");
  await expect
    .poll(async () => (await discover({ userDataDir: chrome.userDataDir })).ok, { timeout: 10_000 })
    .toBe(false);
  const result = await discover({ userDataDir: chrome.userDataDir });
  expect(result).toMatchObject({ ok: false, code: "stale-file", userDataDir: chrome.userDataDir });
});
