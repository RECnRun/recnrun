import { CAPABILITY_MATRIX, type DiscoveryResult } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { REMOTE_DEBUGGING_GUIDANCE, Setup } from "@/features/setup/Setup";
import { NOW, expectTexts, fakeApi, renderWith } from "./fake-api";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/abc";
const FOUND: DiscoveryResult = {
  ok: true,
  wsEndpoint: ENDPOINT,
  userDataDir: "/home/ana/.config/google-chrome",
  source: "active-port-file",
  port: 9222,
  path: "/devtools/browser/abc",
};
const MISSING: DiscoveryResult = {
  ok: false,
  code: "missing-file",
  remedy: "No DevToolsActivePort file.",
  userDataDir: "/home/ana/.config/google-chrome",
};

const BLOCKED: DiscoveryResult = {
  ok: false,
  code: "unreadable-file",
  remedy:
    "macOS blocks reading /Users/ana/Library/Application Support/Google/Chrome/DevToolsActivePort.",
  userDataDir: "/Users/ana/Library/Application Support/Google/Chrome",
};

function binding(name: string, wsEndpoint: string) {
  const description = { userDataDir: "/u", browserContextIds: [], chrome: "Chrome/156.0" };
  return { name, ...description, wsEndpoint, createdAt: NOW, lastSeenAt: NOW };
}

function doctor(chrome: DiscoveryResult) {
  return fakeApi({
    health: () => ({
      status: "ok",
      serviceVersion: "1.2.3",
      protocolVersion: 1,
      pid: 7,
      uptimeMs: 5,
      chrome,
    }),
    "profiles.list": () => ({
      profiles: [binding("Ana (approver)", ENDPOINT), binding("Bia", `${ENDPOINT}-old`)],
    }),
    "capabilities.get": () => CAPABILITY_MATRIX,
  });
}

test("shows a connected Chrome, fresh and stale bindings, and the versions", async () => {
  renderWith(doctor(FOUND).api, <Setup />);
  const chrome = page.getByRole("region", { name: "Chrome" });
  await expectTexts(chrome, "Connected", "Chrome answers on port 9222");
  const bindings = page.getByRole("region", { name: "Bindings" });
  await expectTexts(bindings.getByRole("listitem").nth(0), "Ana", "Fresh");
  await expectTexts(bindings.getByRole("listitem").nth(1), "Bia", "Stale");
  const versions = page.getByRole("region", { name: "Versions" });
  await expectTexts(versions, "Service1.2.3");
  await expectTexts(versions, "UI protocol1");
});

test("guides the user to enable remote debugging when Chrome is missing", async () => {
  const fake = doctor(MISSING);
  renderWith(fake.api, <Setup />);
  const chrome = page.getByRole("region", { name: "Chrome" });
  await expectTexts(chrome, "Not found", "No DevToolsActivePort file.", REMOTE_DEBUGGING_GUIDANCE);
  expect(REMOTE_DEBUGGING_GUIDANCE).toContain("chrome://inspect/#remote-debugging");
  const bindings = page.getByRole("region", { name: "Bindings" });
  await expect.element(bindings.getByText("Fresh")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect.poll(() => fake.paramsOf("health")).toHaveLength(2);
});

test("explains a DevToolsActivePort macOS blocks instead of asking to enable remote debugging", async () => {
  renderWith(doctor(BLOCKED).api, <Setup />);
  const chrome = page.getByRole("region", { name: "Chrome" });
  await expectTexts(chrome, "Blocked", BLOCKED.ok ? "" : BLOCKED.remedy);
  await expect.element(chrome.getByText(REMOTE_DEBUGGING_GUIDANCE)).not.toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Check again" })).toBeVisible();
});

test("shows an empty state without bindings", async () => {
  const fake = doctor(FOUND);
  const empty = fakeApi({ ...fake.handlers, "profiles.list": () => ({ profiles: [] }) });
  renderWith(empty.api, <Setup />);
  await expect.element(page.getByText("No profile bindings yet.")).toBeVisible();
});

test("shows the service's error and code", async () => {
  const failing = fakeApi({
    ...doctor(FOUND).handlers,
    health: () => Promise.reject(new ApiError("internal", "The service crashed.")),
  });
  renderWith(failing.api, <Setup />);
  await expectTexts(page.getByRole("alert"), "The service crashed.", "internal");
});
