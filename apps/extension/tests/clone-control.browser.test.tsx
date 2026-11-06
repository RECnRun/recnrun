import { render } from "preact";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { CloneControlPanel } from "@/onboarding/CloneControlPanel";
import type { CloneControl, CloneControlSnapshot } from "@/onboarding/clone-control-service";
import { button } from "./queries";

const W1 = "11111111-1111-4111-8111-111111111111";
const BOOT = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const row = (state: "closed" | "opening" | "open", mode: "" | "headless" | "headed") => ({
  name: "w1",
  instanceId: W1,
  state,
  mode,
  boot: state === "closed" ? "" : BOOT,
});
const snapshot = (over: Partial<CloneControlSnapshot> = {}): CloneControlSnapshot => ({
  clones: [],
  message: "",
  failure: "",
  ...over,
});

async function shown(first: CloneControlSnapshot) {
  const control: CloneControl = {
    isMaster: async () => true,
    watch: (listener) => {
      listener(first);
      return () => {};
    },
    ask: vi.fn(async () => {}),
  };
  const root = document.body.appendChild(document.createElement("div"));
  render(<CloneControlPanel control={control} />, root);
  await vi.waitFor(() => expect(root.querySelector("section")).not.toBeNull());
  return { root, control };
}

const names = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((each) => each.textContent);

afterEach(() => {
  for (const root of document.body.children) render(null, root);
  document.body.replaceChildren();
});

test("a closed clone offers Open visible and Open headless", async () => {
  const { root, control } = await shown(snapshot({ clones: [row("closed", "")] }));
  expect(names(root)).toEqual(["Open visible", "Open headless"]);
  button(root, "Open headless")?.click();
  expect(control.ask).toHaveBeenCalledWith(W1, "open-headless");
});

test("an open headless clone offers Close and Reopen visible", async () => {
  const { root, control } = await shown(snapshot({ clones: [row("open", "headless")] }));
  expect(names(root)).toEqual(["Close", "Reopen visible"]);
  button(root, "Reopen visible")?.click();
  expect(control.ask).toHaveBeenCalledWith(W1, "reopen-visible");
});

test("an open visible clone offers Close and Reopen headless", async () => {
  const { root } = await shown(snapshot({ clones: [row("open", "headed")] }));
  expect(names(root)).toEqual(["Close", "Reopen headless"]);
});

test("an opening clone offers no button", async () => {
  const { root } = await shown(snapshot({ clones: [row("opening", "headed")] }));
  expect(names(root)).toEqual([]);
});

test("every button is disabled while a request is pending, and the state is shown", async () => {
  const { root } = await shown(
    snapshot({
      clones: [row("open", "headless")],
      pending: { requestId: "r", action: "close", instanceId: W1 },
    }),
  );
  expect([...root.querySelectorAll("button")].every((each) => each.disabled)).toBe(true);
  expect(root.querySelector('[data-field="pending"]')?.textContent).toMatch(/close/);
});

test("shows the launcher's answer and a failed write", async () => {
  const { root } = await shown(
    snapshot({ message: "done: closed w1", failure: "Only the master" }),
  );
  expect(root.querySelector('[data-field="message"]')?.textContent).toBe("done: closed w1");
  expect(root.querySelector('[data-field="failure"]')?.textContent).toBe("Only the master");
});

test("says so when the launcher lists no clone", async () => {
  const { root } = await shown(snapshot());
  expect(root.textContent).toMatch(/No clones yet/);
});
