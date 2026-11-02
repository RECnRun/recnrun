import type { SuggestedStep } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { toFlowSteps } from "../src/index.ts";

const events = [{ id: "e-1", producer: "p", seq: 1 }];
const list = (...locators: unknown[]) =>
  ({ resolution: "orderedFallback", cardinality: "one", locators }) as never;

describe("toFlowSteps", () => {
  test("keeps navigate, fill, and click with the first locator as replay's shorthand", () => {
    const suggestions: SuggestedStep[] = [
      { id: "navigate-1", events, action: "navigate", url: "http://127.0.0.1:4600/routes/form" },
      {
        id: "fill-2",
        actor: "requester",
        events,
        action: "fill",
        target: list({ strategy: "testId", value: "name" }, { strategy: "css", value: "#name" }),
        value: "Ada",
      },
      {
        id: "click-3",
        events,
        action: "click",
        target: list({ strategy: "role", role: "button", name: "Send", exact: true }),
      },
      { id: "keyPress-4", events, action: "keyPress", key: "Enter" },
    ];
    expect(toFlowSteps(suggestions)).toEqual([
      { id: "navigate-1", action: "navigate", url: "http://127.0.0.1:4600/routes/form" },
      {
        id: "fill-2",
        actor: "requester",
        action: "fill",
        target: { testId: "name" },
        value: "Ada",
      },
      { id: "click-3", action: "click", target: { role: "button", name: "Send", exact: true } },
      { id: "keyPress-4", action: "keyPress", key: "Enter" },
    ]);
  });

  test("maps a css candidate and keeps a key press's target", () => {
    const suggestions: SuggestedStep[] = [
      {
        id: "keyPress-1",
        events,
        action: "keyPress",
        key: "Tab",
        target: list({ strategy: "css", value: 'input[name="q"]' }),
      },
    ];
    expect(toFlowSteps(suggestions)).toEqual([
      { id: "keyPress-1", action: "keyPress", key: "Tab", target: { css: 'input[name="q"]' } },
    ]);
  });

  test("leaves out the actions replay has no step for: dblclick, drag, and scroll", () => {
    const target = list({ strategy: "css", value: "#a" });
    const suggestions: SuggestedStep[] = [
      { id: "dblclick-1", events, action: "dblclick", target },
      { id: "drag-2", events, action: "drag", target, to: target },
      { id: "scroll-3", events, action: "scroll", scrollX: 0, scrollY: 100 },
    ];
    expect(toFlowSteps(suggestions)).toEqual([]);
  });
});
