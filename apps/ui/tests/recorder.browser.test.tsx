import type {
  CapturedEvent,
  LocatorList,
  NormalizationResult,
  PauseMode,
  SessionStatus,
  SuggestedStep,
} from "@recnrun/protocol";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { DraftAssertions } from "@/features/editor/DraftAssertions";
import { Recorder } from "@/features/recorder/Recorder";
import { ApiError } from "@/api/error";
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

// The UI reads suggestions on each captured event; the event's own fields do not matter to it.
const CAPTURED = { id: "e1", category: "dom", type: "input" } as unknown as CapturedEvent;

const PICKED: LocatorList = {
  resolution: "orderedFallback",
  cardinality: "one",
  locators: [{ strategy: "testId", value: "status" }],
};

function recorder(pollMs = 50) {
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
    "picker.start": ({ sessionId }) => ({ sessionId, picking: true }),
    "picker.stop": ({ sessionId }) => ({ sessionId, picking: false }),
    "flow.addAssertion": ({ step }) => ({ stepId: step.id }),
  });
  const onFinalized = vi.fn<(flowId: string) => void>();
  renderWith(
    fake.api,
    <Recorder
      onFinalized={onFinalized}
      pollMs={pollMs}
      slot={(session) => <DraftAssertions session={session} />}
    />,
  );
  const setSuggestions = (next: NormalizationResult) => {
    suggestions = next;
    fake.emit("session.event", { type: "session.event", sessionId: "session-1", event: CAPTURED });
  };
  return { ...fake, onFinalized, setSuggestions };
}

test("starts a session and reads suggestions again when an event is captured", async () => {
  const fake = recorder(60_000);
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect.element(page.getByText("No suggested steps yet.", { exact: false })).toBeVisible();
  expect(fake.paramsOf("session.start")).toEqual([{}]);
  // Preact runs effects after paint, so wait for the subscription before pushing.
  await expect.poll(() => fake.paramsOf("session.suggestions").length).toBe(1);
  fake.setSuggestions({ steps: [FILL, DRAG], excluded: [] });
  const steps = page.getByRole("list", { name: "Suggested steps" }).getByRole("listitem");
  await expectTexts(steps.nth(0), "fill", 'label="Email"', "ana@example.com");
  await expectTexts(steps.nth(1), "drag", "Not replayable yet");
  expect(fake.paramsOf("session.suggestions")).toEqual([
    { sessionId: "session-1" },
    { sessionId: "session-1" },
  ]);
});

test("polls suggestions and follows the status the service pushes", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect.poll(() => fake.paramsOf("session.suggestions").length).toBeGreaterThan(1);
  const other = { ...status(), sessionId: "session-2", state: "paused" as const };
  fake.emit("session.status", { type: "session.status", sessionId: "session-2", status: other });
  fake.emit("session.status", {
    type: "session.status",
    sessionId: "session-1",
    status: { ...status(), control: "agent" },
  });
  await expectTexts(page.getByRole("region", { name: "Recording" }), "recording", "agent");
});

test("picks an element on the session's page and adds the assertion to the draft", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByRole("button", { name: "Pick in Chrome" }).click();
  await expect.element(page.getByRole("button", { name: "Cancel picking" })).toBeVisible();
  const start = fake.calls.find((call) => call.command === "picker.start");
  expect(start?.params).toEqual({ sessionId: "session-1" });
  expect(start?.options?.lease).toMatchObject({ leaseId: "lease-1", fencingToken: 3 });
  const target = { tag: "p", testId: "status" };
  fake.emit("picker.picked", {
    type: "picker.picked",
    sessionId: "other",
    target,
    locators: PICKED,
  });
  expect(fake.paramsOf("picker.stop")).toEqual([]);
  fake.emit("picker.picked", {
    type: "picker.picked",
    sessionId: "session-1",
    target,
    locators: PICKED,
  });
  await expect.element(page.getByText('testId value="status"', { exact: false })).toBeVisible();
  expect(fake.paramsOf("picker.stop")).toEqual([{ sessionId: "session-1" }]);
  await page.getByRole("combobox", { name: "Kind" }).selectOptions("textEquals");
  await page.getByRole("textbox", { name: "Expected" }).fill("Submitted");
  await page.getByRole("button", { name: "Add assertion" }).click();
  await expectTexts(
    page.getByRole("list", { name: "Draft assertions" }),
    "textEquals",
    "Submitted",
  );
  expect(fake.paramsOf("flow.addAssertion")).toEqual([
    {
      sessionId: "session-1",
      step: { id: "assert-1", assertion: "textEquals", target: PICKED, expected: "Submitted" },
    },
  ]);
  // The service refuses session changes that do not carry the holder's fence.
  const fenced = (command: string) => fake.calls.find((call) => call.command === command);
  for (const command of ["picker.stop", "flow.addAssertion"])
    expect(fenced(command)?.options?.lease).toMatchObject({ leaseId: "lease-1", fencingToken: 3 });
});

test("cancels a pick and shows a refused assertion", async () => {
  const fake = recorder();
  fake.handlers["flow.addAssertion"] = () => {
    throw new ApiError("conflict", "The session is completed.");
  };
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByRole("button", { name: "Pick in Chrome" }).click();
  await page.getByRole("button", { name: "Cancel picking" }).click();
  await expect.poll(() => fake.paramsOf("picker.stop")).toEqual([{ sessionId: "session-1" }]);
  await page.getByRole("textbox", { name: "Locator" }).fill("#done");
  await page.getByRole("button", { name: "Add assertion" }).click();
  await expectTexts(page.getByRole("alert"), "The session is completed.", "conflict");
});

test("toggles a pause with the lease and shows a suspended capture", async () => {
  const fake = recorder();
  await page.getByRole("button", { name: "Start recording" }).click();
  const suspend = page.getByRole("button", { name: "Suspend capture" });
  const coverage = page.getByRole("region", { name: "Coverage" });
  await expectTexts(coverage, "Capture is on", "this page and the popups it opens");
  await suspend.click();
  await expect.element(suspend).toHaveAttribute("aria-pressed", "true");
  const pause = fake.calls.find((call) => call.command === "session.pause");
  expect(pause?.params).toEqual({ sessionId: "session-1", mode: "suspendCapture" });
  expect(pause?.options?.lease).toMatchObject({ leaseId: "lease-1", fencingToken: 3 });
  await expectTexts(coverage, "Capture is suspended");
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
