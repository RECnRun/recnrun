import { render } from "preact";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mountPrepareWorkers } from "@/onboarding/mount";
import type { Onboarding } from "@/onboarding/service";

const state = vi.hoisted(() => ({ master: true }));

vi.mock("@/onboarding/page-services", () => ({
  onboardingServices: (): Onboarding => ({
    isMaster: async () => state.master,
    watch: (listener) => {
      listener({ phase: "idle", step: "", message: "", clones: [], failure: "" });
      return () => {};
    },
    request: async () => {},
    retry: async () => {},
  }),
}));

beforeEach(() => {
  state.master = true;
});

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("adds Prepare workers to the dashboard of the master", async () => {
  await mountPrepareWorkers();
  const root = document.getElementById("prepare-workers");
  expect(root?.parentElement).toBe(document.body);
  await vi.waitFor(() => expect(root?.querySelector("section")).not.toBeNull());
});

test("adds nothing to the dashboard of a profile that is not the master", async () => {
  state.master = false;
  await mountPrepareWorkers();
  expect(document.getElementById("prepare-workers")).toBeNull();
  expect(document.body.children).toHaveLength(0);
});

test("mounts into the page it is given, not the one it runs in", async () => {
  const other = document.implementation.createHTMLDocument("dashboard");
  await mountPrepareWorkers(other);
  expect(other.getElementById("prepare-workers")).not.toBeNull();
  expect(document.getElementById("prepare-workers")).toBeNull();
});
