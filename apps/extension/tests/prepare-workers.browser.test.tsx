import { afterEach, expect, test, vi } from "vite-plus/test";
import { render } from "preact";
import { PrepareWorkers } from "@/onboarding/PrepareWorkers";
import type { Onboarding, OnboardingSnapshot } from "@/onboarding/service";
import { button, type } from "./queries";

const W1 = "11111111-1111-4111-8111-111111111111";
const idle: OnboardingSnapshot = { phase: "idle", step: "", message: "", clones: [], failure: "" };

function mount(first: OnboardingSnapshot) {
  let push: (snapshot: OnboardingSnapshot) => void = () => {};
  const onboarding: Onboarding = {
    isMaster: async () => true,
    watch: (listener) => {
      push = listener;
      listener(first);
      return () => {};
    },
    request: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
  const root = document.body.appendChild(document.createElement("div"));
  render(<PrepareWorkers onboarding={onboarding} />, root);
  return { root, onboarding, show: (next: OnboardingSnapshot) => push(next) };
}

/** Mounts and waits for the first render, which a hook's effect delivers. */
async function shown(first: OnboardingSnapshot) {
  const mounted = mount(first);
  await vi.waitFor(() => expect(mounted.root.querySelector("section")).not.toBeNull());
  return mounted;
}

const value = (root: HTMLElement, field: string) =>
  root.querySelector(`[data-field="${field}"]`)?.textContent ?? undefined;

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("asks for the folder and the count, then Prepare sends them", async () => {
  const { root, onboarding } = await shown(idle);
  await type(
    root.querySelector<HTMLInputElement>('[data-field="bases-dir"]') ?? undefined,
    "/Bases",
  );
  await type(root.querySelector<HTMLInputElement>('[data-field="clones-count"]') ?? undefined, "3");
  button(root, "Prepare")?.click();
  expect(onboarding.request).toHaveBeenCalledWith("/Bases", 3);
  expect(value(root, "phase")).toBe("idle");
});

test("shows the step, the message, and a clones table with acked and linked", async () => {
  const { root, show } = await shown(idle);
  show({
    phase: "running",
    step: "open-clone",
    message: "opened w1",
    clones: [{ name: "w1", instanceId: W1, acked: true, linked: false }],
    failure: "",
  });
  await vi.waitFor(() => expect(value(root, "phase")).toBe("running"));
  expect(value(root, "step")).toBe("open-clone");
  expect(value(root, "message")).toBe("opened w1");
  const row = root.querySelector('[data-field="clone"]');
  expect(row?.querySelector('[data-field="name"]')?.textContent).toBe("w1");
  expect(row?.querySelector('[data-field="instance-id"]')?.textContent).toBe(W1);
  expect(row?.querySelector('[data-field="acked"]')?.textContent).toBe("true");
  expect(row?.querySelector('[data-field="linked"]')?.textContent).toBe("false");
  expect(button(root, "Prepare")?.disabled).toBe(true);
  expect(value(root, "done")).toBeUndefined();
  expect(button(root, "Retry")).toBeUndefined();
});

test("an error offers Retry, which asks the service", async () => {
  const { root, onboarding, show } = await shown(idle);
  show({ ...idle, phase: "error", step: "create-clone", message: "exit 73: w1 exists" });
  await vi.waitFor(() => expect(value(root, "message")).toBe("exit 73: w1 exists"));
  button(root, "Retry")?.click();
  expect(onboarding.retry).toHaveBeenCalled();
});

test("Done shows only in the done phase, and Prepare is available again", async () => {
  const { root, show } = await shown(idle);
  show({
    ...idle,
    phase: "done",
    step: "done",
    clones: [{ name: "w1", instanceId: W1, acked: true, linked: true }],
  });
  await vi.waitFor(() => expect(value(root, "done")).toBe("Done"));
  expect(button(root, "Prepare")?.disabled).toBe(false);
});

test("shows why a request could not be written", async () => {
  const { root, show } = await shown(idle);
  show({ ...idle, failure: "Only the master prepares workers." });
  await vi.waitFor(() =>
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      "Only the master prepares workers.",
    ),
  );
});
