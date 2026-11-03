import type { Flow, FlowManifest } from "@recnrun/protocol";
import { page } from "vite-plus/test/browser";
import { ApiError } from "@/api/error";
import { Run } from "@/features/run/Run";
import { type Handlers, NOW, REVISION, fakeApi, renderWith } from "./fake-api";

export const SECRET = "hunter2-do-not-show";

export const FLOW = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  actors: {},
  inputs: {
    email: { type: "string", required: true },
    password: { type: "string", required: true, secret: true },
    retries: { type: "number", required: false, default: 2 },
    remember: { type: "boolean", required: false },
    tags: { type: "array", required: false },
  },
  requirements: [],
  preconditions: [],
  steps: [{ id: "open", action: "navigate", url: "http://localhost:4600/login" }],
} as Flow;

const MANIFEST: FlowManifest = {
  schemaVersion: 1,
  id: "login",
  name: "Log in",
  revision: REVISION,
  status: "recorded",
  createdAt: NOW,
  updatedAt: NOW,
  revisions: [{ revision: REVISION, savedAt: NOW }],
};

/** The `run.summary` answer of a run that has not ended. */
export const going = () => {
  throw new ApiError("conflict", "Run run-1 is still running.");
};

/** The Run screen of `flow` over a fake service; `extra` adds or replaces command fakes. */
export function runScreen(flow: Flow = FLOW, extra: Handlers = {}) {
  sessionStorage.clear();
  const fake = fakeApi({
    "flow.get": () => ({ flow, manifest: MANIFEST, revision: REVISION }),
    "flow.replay": () => ({ runId: "run-1" }),
    "run.summary": going,
    "dataset.list": () => ({ datasets: [] }),
    ...extra,
  });
  renderWith(fake.api, <Run flowId="login" />);
  return fake;
}

export const field = (name: string) => page.getByRole("textbox", { name });
export const start = () => page.getByRole("button", { name: "Start run" }).click();
