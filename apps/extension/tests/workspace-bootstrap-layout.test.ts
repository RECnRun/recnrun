import type { SessionLayout } from "@recnrun/domain";
import { expect, test } from "vite-plus/test";
import { BOOTSTRAP_STEPS, bootstrapIdentity } from "@/background/workspace/bootstrap";
import { DATA, ORIGIN, START, bootstrapHarness } from "./bootstrap-harness";

const LAYOUT: SessionLayout = {
  windows: [
    {
      focused: false,
      tabs: [
        { url: START, active: true, sessionStorage: [] },
        { url: `${ORIGIN}/app/?tab=2`, active: false, sessionStorage: [] },
      ],
    },
    { focused: true, tabs: [{ url: `${ORIGIN}/app/?tab=3`, active: true, sessionStorage: [] }] },
  ],
  primary: { window: 0, tab: 0 },
};

test("reopens the identity's other tabs and windows last, once the app is released", async () => {
  const { deps, navigation } = bootstrapHarness();
  const timings = await bootstrapIdentity(START, { ...DATA, layout: LAYOUT }, deps, "op-1");
  expect(timings.map(({ step }) => step)).toEqual(BOOTSTRAP_STEPS);
  expect(navigation.reloads).toHaveLength(1);
  expect(deps.layout.calls).toEqual([
    "tab 200 in 5 at 1",
    "activate 9",
    `navigate 200 ${ORIGIN}/app/?tab=2`,
    "window 50",
    `navigate 500 ${ORIGIN}/app/?tab=3`,
    "activate 500",
    "focus 50",
  ]);
  expect(deps.windows.close).not.toHaveBeenCalled();
});

test("a start whose layout fails closes every window it opened, its own and the reopened ones", async () => {
  const { deps, records } = bootstrapHarness();
  deps.layout.focus.mockRejectedValue(new Error("No window with id: 50."));
  const data = { ...DATA, layout: LAYOUT };
  await expect(bootstrapIdentity(START, data, deps, "op-1")).rejects.toThrow(
    "No window with id: 50.",
  );
  expect(deps.windows.close).toHaveBeenCalledWith([5, 50]);
  expect(records.at(-1)).toMatchObject({ status: "failed", step: "layout" });
});

test("a start without a layout opens no other tab or window", async () => {
  const { deps } = bootstrapHarness();
  await bootstrapIdentity(START, DATA, deps, "op-1");
  expect(deps.layout.calls).toEqual([]);
});
