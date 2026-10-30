import type { Snapshot, Step, Workflow } from "../src/index.ts";

/** A small snapshot with two recordings, stored oldest first. */
export function sampleSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    recordings: [
      {
        id: "rec-login",
        name: "Log in as admin",
        startUrl: "http://localhost:3000/login",
        createdAt: "2026-10-01T09:30:00.000Z",
        durationMs: 12_400,
        eventCount: 7,
      },
      {
        id: "rec-checkout",
        name: "Checkout with saved card",
        startUrl: "https://staging.shop.example/cart",
        createdAt: "2026-10-02T14:05:00.000Z",
        durationMs: 95_000,
        eventCount: 31,
      },
    ],
  };
}

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
