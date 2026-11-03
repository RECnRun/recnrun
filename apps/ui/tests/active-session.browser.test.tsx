import type { SessionStatus } from "@recnrun/protocol";
import { render } from "preact";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { App } from "@/app/App";
import { ApiError } from "@/api/error";
import { expectTexts, fakeApi } from "./fake-api";

const KEY = "recnrun.session";

function status(state: SessionStatus["state"] = "recording"): SessionStatus {
  return {
    sessionId: "session-1",
    state,
    control: "unassigned",
    pauses: { pauseStepCreation: "active", pauseReplay: "active", suspendCapture: "active" },
  };
}

function app(current: () => SessionStatus = () => status()) {
  const fake = fakeApi({
    "flow.list": () => ({ flows: [] }),
    "profiles.list": () => ({ profiles: [] }),
    "session.start": () => status(),
    "session.status": () => current(),
    "session.suggestions": () => ({ steps: [], excluded: [] }),
    "session.stop": () => status("completed"),
    "flow.finalize": () => ({ flowId: "recorded-flow", revision: "r1" }),
  });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<App api={fake.api} />, root);
  return fake;
}

const stopButton = () => page.getByRole("button", { name: "Stop and save" });
const startButton = () => page.getByRole("button", { name: "Start recording" });

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", `${location.pathname}#/record`);
});

afterEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", location.pathname + location.search);
});

test("keeps a running recording's controls when the user leaves Record and comes back", async () => {
  const fake = app();
  await startButton().click();
  await expect.element(stopButton()).toBeVisible();
  await page.getByRole("link", { name: "Flows" }).click();
  await expect.element(page.getByRole("heading", { name: "Flows" })).toBeVisible();
  await page.getByRole("link", { name: "Record" }).click();
  await expect.element(stopButton()).toBeVisible();
  expect(startButton().query()).toBeNull();
  expect(fake.paramsOf("session.start")).toHaveLength(1);
});

test("recovers the recording after a reload from the session the tab stored", async () => {
  sessionStorage.setItem(KEY, "session-1");
  const fake = app(() => ({ ...status("paused"), control: "manual" }));
  await expect.element(stopButton()).toBeVisible();
  expect(fake.paramsOf("session.status")).toEqual([{ sessionId: "session-1" }]);
  await expectTexts(page.getByRole("region", { name: "Recording" }), "paused", "manual");
});

test("offers a new recording when the stored session is gone or already saved", async () => {
  sessionStorage.setItem(KEY, "session-1");
  app(() => {
    throw new ApiError("not-found", "No session session-1.");
  });
  await expect.element(startButton()).toBeVisible();
  expect(sessionStorage.getItem(KEY)).toBeNull();
  sessionStorage.setItem(KEY, "session-1");
  app(() => status("completed"));
  await expect.element(startButton()).toBeVisible();
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

test("forgets the session once it is stopped and saved", async () => {
  app();
  await startButton().click();
  await expect.poll(() => sessionStorage.getItem(KEY)).toBe("session-1");
  await stopButton().click();
  await expect.poll(() => location.hash).toBe("#/flows/recorded-flow");
  expect(sessionStorage.getItem(KEY)).toBeNull();
});
