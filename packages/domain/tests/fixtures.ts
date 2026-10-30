import type { Step, Workflow } from "../src/index.ts";

/** Two workflows: one still recording, one stopped the day after. */
export function sampleWorkflows(): Workflow[] {
  return [
    {
      id: "wf-login",
      title: "Log in as admin",
      description: "Happy path through the login form.",
      tags: ["env:local", "feature:login"],
      status: "recording",
      createdAt: "2026-10-01T09:30:00.000Z",
      updatedAt: "2026-10-01T09:30:00.000Z",
    },
    {
      id: "wf-checkout",
      title: "Checkout with saved card",
      tags: ["env:ACC", "feature:checkout"],
      status: "stopped",
      createdAt: "2026-10-02T14:05:00.000Z",
      updatedAt: "2026-10-02T14:06:35.000Z",
    },
  ];
}

export function sampleWorkflow(): Workflow {
  return sampleWorkflows()[0] as Workflow;
}

export function sampleStep(): Step {
  return sampleSteps()[0] as Step;
}

/** The steps of `wf-login`, oldest first. */
export function sampleSteps(): Step[] {
  const base = { workflowId: "wf-login", tabId: 12, url: "http://localhost:3000/login" } as const;
  return [
    {
      ...base,
      id: "step-1",
      recordedAt: "2026-10-01T09:30:01.000Z",
      author: "browser",
      command: "navigate",
      value: "http://localhost:3000/login",
    },
    {
      ...base,
      id: "step-2",
      recordedAt: "2026-10-01T09:30:04.000Z",
      author: "user",
      command: "fill",
      selector: "#email",
      value: "admin@example.com",
    },
    {
      ...base,
      id: "step-3",
      recordedAt: "2026-10-01T09:30:06.000Z",
      author: "user",
      command: "fill",
      selector: "#password",
      value: "***",
    },
    {
      ...base,
      id: "step-4",
      recordedAt: "2026-10-01T09:30:07.000Z",
      author: "user",
      command: "click",
      selector: '[data-testid="sign-in"]',
    },
  ];
}
