import { render } from "preact";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { mountCloneControl } from "@/onboarding/clone-control-mount";
import type { CloneControl } from "@/onboarding/clone-control-service";

const state = vi.hoisted(() => ({ master: true }));

vi.mock("@/onboarding/clone-control-page-services", () => ({
  cloneControlServices: (): CloneControl => ({
    isMaster: async () => state.master,
    watch: (listener) => {
      listener({ clones: [], message: "", failure: "" });
      return () => {};
    },
    ask: async () => {},
  }),
}));

beforeEach(() => {
  state.master = true;
});

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("adds Clones to the dashboard of the master", async () => {
  await mountCloneControl();
  const root = document.getElementById("clone-control");
  expect(root?.parentElement).toBe(document.body);
  await vi.waitFor(() => expect(root?.querySelector("section")).not.toBeNull());
});

test("adds nothing to the dashboard of a profile that is not the master", async () => {
  state.master = false;
  await mountCloneControl();
  expect(document.body.children).toHaveLength(0);
});
