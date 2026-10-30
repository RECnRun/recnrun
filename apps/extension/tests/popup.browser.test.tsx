import type { RequestType } from "@recnrun/bridge";
import { sampleWorkflows } from "@recnrun/domain/testing";
import { render } from "preact";
import { afterEach, expect, test } from "vite-plus/test";
import { Popup } from "@/popup/Popup";
import type { Send } from "@/popup/Popup";

type Reply = (payload: unknown) => unknown;

/** A background that answers each request type from a table and records every call. */
function fakeSend(replies: Partial<Record<RequestType, Reply>>) {
  const calls: Array<{ type: string; payload?: unknown }> = [];
  const send = (async (type: RequestType, payload?: unknown) => {
    calls.push(payload === undefined ? { type } : { type, payload });
    const reply = replies[type];
    if (!reply) throw new Error(`Unexpected ${type}.`);
    return reply(payload);
  }) as Send;
  return { send, calls };
}

function mount(send: Send) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<Popup send={send} dashboardUrl="http://localhost:5173/" />, root);
  return root;
}

const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);

const field = <T extends HTMLElement>(root: ParentNode, selector: string): T => {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`No ${selector}.`);
  return node;
};

/** Preact applies state on a microtask, so wait for the re-render before the next action. */
const setValue = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => render(null, document.body));

test("starts a workflow from the form and then shows it as recording", async () => {
  const [recording, stopped] = sampleWorkflows();
  if (!recording || !stopped) throw new Error("fixture");
  let status: unknown = { missingOrigins: [] };
  const { send, calls } = fakeSend({
    getRecordingStatus: () => status,
    listWorkflows: () => [stopped],
    startWorkflow: () => {
      status = { workflow: recording, missingOrigins: [] };
      return { status: "recording", workflow: recording };
    },
  });
  const root = mount(send);
  await expect.poll(() => root.querySelector("form")).not.toBeNull();
  await setValue(field(root, "input[name=title]"), "  Log in as admin ");
  await setValue(field(root, "input[name=tags]"), "env:local, feature:login");
  button(root, "Start recording")?.click();
  await expect
    .poll(() => root.querySelector(".recording")?.textContent)
    .toContain("Log in as admin");
  expect(calls).toContainEqual({
    type: "startWorkflow",
    payload: { title: "Log in as admin", tags: ["env:local", "feature:login"] },
  });
  expect(root.querySelector("a[href='http://localhost:5173/']")).not.toBeNull();
});

test("refuses to start without a title and shows the background's error", async () => {
  const { send, calls } = fakeSend({
    getRecordingStatus: () => ({ missingOrigins: [] }),
    listWorkflows: () => [],
    startWorkflow: () => {
      throw new Error("No active tab to record.");
    },
  });
  const root = mount(send);
  await expect.poll(() => root.querySelector("form")).not.toBeNull();
  button(root, "Start recording")?.click();
  expect(calls.some((call) => call.type === "startWorkflow")).toBe(false);
  await setValue(field(root, "input[name=title]"), "Checkout");
  button(root, "Start recording")?.click();
  await expect
    .poll(() => root.querySelector("[role=alert]")?.textContent)
    .toBe("No active tab to record.");
});

test("resumes a stopped workflow chosen from the list", async () => {
  const [, stopped] = sampleWorkflows();
  if (!stopped) throw new Error("fixture");
  let status: unknown = { missingOrigins: [] };
  const { send, calls } = fakeSend({
    getRecordingStatus: () => status,
    listWorkflows: () => [stopped],
    resumeWorkflow: () => {
      const workflow = { ...stopped, status: "recording" };
      status = { workflow, missingOrigins: [] };
      return { status: "recording", workflow };
    },
  });
  const root = mount(send);
  await expect.poll(() => root.querySelector("select")).not.toBeNull();
  await setValue(field(root, "select[name=resume]"), "wf-checkout");
  button(root, "Resume")?.click();
  await expect
    .poll(() => calls)
    .toContainEqual({
      type: "resumeWorkflow",
      payload: { id: "wf-checkout" },
    });
  await expect
    .poll(() => root.querySelector(".recording")?.textContent)
    .toContain("Checkout with saved card");
});

test("shows the recording with allow and stop buttons", async () => {
  const [recording] = sampleWorkflows();
  if (!recording) throw new Error("fixture");
  let status: unknown = { workflow: recording, missingOrigins: ["https://app.example/*"] };
  const { send, calls } = fakeSend({
    getRecordingStatus: () => status,
    listWorkflows: () => [],
    grantOrigins: () => {
      status = { workflow: recording, missingOrigins: [] };
      return { granted: true };
    },
    stopWorkflow: () => {
      status = { missingOrigins: [] };
      return { ...recording, status: "stopped" };
    },
  });
  const root = mount(send);
  await expect.poll(() => button(root, "Allow access to https://app.example/*")).toBeDefined();
  button(root, "Allow access to https://app.example/*")?.click();
  await expect.poll(() => button(root, "Allow access to https://app.example/*")).toBeUndefined();
  expect(calls).toContainEqual({
    type: "grantOrigins",
    payload: { origins: ["https://app.example/*"] },
  });
  button(root, "Stop")?.click();
  await expect.poll(() => root.querySelector("form")).not.toBeNull();
  expect(calls).toContainEqual({ type: "stopWorkflow", payload: { id: "wf-login" } });
});

test("explains when the background cannot be read", async () => {
  const { send } = fakeSend({
    getRecordingStatus: () => {
      throw new Error("Quota exceeded");
    },
  });
  const root = mount(send);
  await expect.poll(() => root.querySelector("[role=alert]")?.textContent).toBe("Quota exceeded");
});
