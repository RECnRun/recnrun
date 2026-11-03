import type {
  NormalizationResult,
  PauseMode,
  SessionStatus,
  SuggestedStep,
} from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { Recorder } from "@/features/recorder/Recorder";
import { NOW, expectTexts, fakeApi, renderWith } from "./fake-api";

const LEASE = {
  leaseId: "lease-1",
  fencingToken: 3,
  targetId: "tab-1",
  holderId: "ui",
  kind: "manual" as const,
  acquiredAt: 1,
  expiresAt: 2,
};

function status(pauses: Partial<Record<PauseMode, "active" | "paused">> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    state: "recording",
    control: "unassigned",
    pauses: {
      pauseStepCreation: "active",
      pauseReplay: "active",
      suspendCapture: "active",
      ...pauses,
    },
    lease: LEASE,
  };
}

const EVENT = { id: "e1", producer: "page", seq: 1 };
const FILL: SuggestedStep = {
  id: "s1",
  action: "fill",
  target: { resolution: "orderedFallback", cardinality: "one", locators: [{ label: "Email" }] },
  value: "ana@example.com",
  events: [EVENT],
};
const DRAG: SuggestedStep = {
  id: "s2",
  action: "drag",
  target: { resolution: "orderedFallback", cardinality: "one", locators: [{ css: "#a" }] },
  to: { resolution: "orderedFallback", cardinality: "one", locators: [{ css: "#b" }] },
  events: [{ ...EVENT, seq: 2 }],
};

function recorder() {
  let suggestions: NormalizationResult = { steps: [], excluded: [] };
  const fake = fakeApi({
    "profiles.list": () => ({ profiles: [] }),
    "session.start": () => status(),
    "session.suggestions": () => suggestions,
    "session.pause": ({ mode }) => status({ [mode]: "paused" }),
    "session.resume": () => status(),
    "session.handoff": () => ({ ...status(), control: "manual" }),
    "session.stop": () => ({ ...status(), state: "completed" }),
    "flow.finalize": () => ({ flowId: "recorded-flow", revision: "r1" }),
  });
  const onFinalized = vi.fn<(flowId: string) => void>();
  renderWith(fake.api, <Recorder onFinalized={onFinalized} pollMs={50} />);
  const setSuggestions = (next: NormalizationResult) => {
    suggestions = next;
    fake.emit("session.event", { sessionId: "session-1", suggestions: next });
  };
  return { ...fake, onFinalized, setSuggestions };
}

test("starts a session and shows a suggested fill pushed by the service", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect.element(page.getByText("No suggested steps yet.", { exact: false })).toBeVisible();
  expect(fake.paramsOf("session.start")).toEqual([{}]);
  fake.setSuggestions({ steps: [FILL, DRAG], excluded: [] });
  const steps = page.getByRole("list", { name: "Suggested steps" }).getByRole("listitem");
  await expectTexts(steps.nth(0), "fill", 'label="Email"', "ana@example.com");
  await expectTexts(steps.nth(1), "drag", "Not replayable yet");
  await expect.poll(() => fake.paramsOf("session.suggestions").length).toBeGreaterThan(1);
});

test("toggles a pause with the lease and shows the capture gap", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  const suspend = page.getByRole("button", { name: "Suspend capture" });
  await suspend.click();
  await expect.element(suspend).toHaveAttribute("aria-pressed", "true");
  const pause = fake.calls.find((call) => call.command === "session.pause");
  expect(pause?.params).toEqual({ sessionId: "session-1", mode: "suspendCapture" });
  expect(pause?.options?.lease).toMatchObject({ leaseId: "lease-1", fencingToken: 3 });
  const coverage = page.getByRole("region", { name: "Coverage" });
  await expectTexts(coverage, "Capture is suspended");
  fake.emit("session.event", {
    sessionId: "session-1",
    gap: { reason: "capture-suspended", lost: 4, startedAt: NOW },
  });
  await expectTexts(coverage, "capture-suspended", "4 events lost");
  await suspend.click();
  await expect.element(suspend).toHaveAttribute("aria-pressed", "false");
  expect(fake.paramsOf("session.resume")).toEqual([
    { sessionId: "session-1", mode: "suspendCapture" },
  ]);
});

test("takes control, then stops and finalizes into the editor", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByRole("button", { name: "Take control" }).click();
  expect(fake.paramsOf("session.handoff")).toEqual([{ sessionId: "session-1", to: "manual" }]);
  await expect.element(page.getByRole("button", { name: "Take control" })).toBeDisabled();
  await page.getByRole("button", { name: "Stop and save" }).click();
  await expect.poll(() => fake.onFinalized.mock.calls).toEqual([["recorded-flow"]]);
  const order = fake.calls.map((call) => call.command).filter((name) => name.startsWith("flow."));
  expect(order).toEqual(["flow.finalize"]);
  expect(fake.paramsOf("session.stop")).toEqual([{ sessionId: "session-1" }]);
});

test("binds an actor to a profile and shows a refused start", async () => {
  const fake = fakeApi({
    "profiles.list": () => ({
      profiles: [
        {
          name: "Ana",
          userDataDir: "/u",
          browserContextIds: [],
          chrome: "Chrome/156",
          wsEndpoint: "ws://127.0.0.1:1/devtools/browser/x",
          createdAt: NOW,
          lastSeenAt: NOW,
        },
      ],
    }),
  });
  renderWith(fake.api, <Recorder onFinalized={() => undefined} />);
  await page.getByRole("textbox", { name: "Actor" }).fill("requester");
  await page.getByRole("combobox", { name: "Binding" }).selectOptions("Ana");
  await page.getByRole("button", { name: "Start recording" }).click();
  expect(fake.paramsOf("session.start")).toEqual([{ actors: { requester: "Ana" } }]);
  await expectTexts(
    page.getByRole("alert"),
    "No fake for session.start.",
    "capability-unavailable",
  );
});
