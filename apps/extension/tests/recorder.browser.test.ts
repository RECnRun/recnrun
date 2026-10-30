import type { StepDraft } from "@recnrun/domain";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createEventRecorder } from "@/recorder/events";
import { selectorFor } from "@/recorder/selector";

const RECORDED_AT = "2026-10-01T09:30:01.000Z";
const URL = "http://localhost:4300/login";

let detach = (): void => {};

afterEach(() => {
  detach();
  document.body.innerHTML = "";
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

function query(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`No element matches ${selector}.`);
  return element;
}

function record(html: string): StepDraft[] {
  mount(html);
  const steps: StepDraft[] = [];
  const recorder = createEventRecorder((step) => steps.push(step), {
    now: () => new Date(RECORDED_AT),
    url: () => URL,
    debounceMs: 20,
  });
  detach = recorder.attach(document);
  return steps;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

describe("selectorFor", () => {
  test("prefers test ids, then ids, names, and labels", () => {
    mount(`
      <button data-testid="save" id="save-button">Save</button>
      <input id="email" name="email" />
      <input name="query" aria-label="Search" />
      <button aria-label="Close">x</button>
    `);
    expect(selectorFor(query("button"))).toBe('[data-testid="save"]');
    expect(selectorFor(query("#email"))).toBe("#email");
    expect(selectorFor(query('[name="query"]'))).toBe('[name="query"]');
    expect(selectorFor(query('[aria-label="Close"]'))).toBe('[aria-label="Close"]');
  });

  test("names buttons and links by their text", () => {
    mount(`<p><a href="/next">Next page</a></p><button>Save</button><button>Save</button>`);
    expect(selectorFor(query("a"))).toBe('a:has-text("Next page")');
    expect(selectorFor(query("button"))).toBe("body > button:nth-of-type(1)");
  });

  test("falls back to a path from the nearest id or the body", () => {
    mount(
      `<div id="form"><p>one</p><p>two <span>deep</span></p></div><section><em>x</em></section>`,
    );
    expect(selectorFor(query("span"))).toBe("#form > p:nth-of-type(2) > span");
    expect(selectorFor(query("em"))).toBe("body > section > em");
  });

  test("skips attributes that are not unique", () => {
    mount(`<input name="dup" /><input name="dup" />`);
    expect(selectorFor(query("input"))).toBe("body > input:nth-of-type(1)");
  });
});

describe("createEventRecorder", () => {
  test("records trusted clicks on the interactive ancestor", async () => {
    const steps = record(`<button data-testid="sign-in"><span>Sign in</span></button>`);
    await userEvent.click(query("span"));
    expect(steps).toEqual([
      {
        recordedAt: RECORDED_AT,
        url: URL,
        author: "user",
        command: "click",
        selector: '[data-testid="sign-in"]',
      },
    ]);
  });

  test("marks events dispatched by page scripts", async () => {
    const steps = record(`<button id="go">Go</button>`);
    query("#go").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(steps.map((step) => step.author)).toEqual(["page"]);
  });

  test("records typing as one fill per pause and masks passwords", async () => {
    const steps = record(`<input id="email" /><input id="password" type="password" />`);
    await userEvent.type(query("#email"), "admin@example.com");
    await userEvent.type(query("#password"), "secret");
    await settle();
    expect(steps.map(({ command, selector, value }) => ({ command, selector, value }))).toEqual([
      { command: "fill", selector: "#email", value: "admin@example.com" },
      { command: "fill", selector: "#password", value: "***" },
    ]);
  });

  test("records an emptied field as clear", async () => {
    const steps = record(`<input id="email" value="old" />`);
    await userEvent.clear(query("#email"));
    await settle();
    expect(steps.map((step) => step.command)).toContain("clear");
    expect(steps.map((step) => step.command)).not.toContain("fill");
  });

  test("records select changes", async () => {
    const steps = record(
      `<select id="env"><option value="local">local</option><option value="acc">acc</option></select>`,
    );
    await userEvent.selectOptions(query("#env"), "acc");
    expect(steps.filter((step) => step.command === "select")).toEqual([
      expect.objectContaining({ selector: "#env", value: "acc" }),
    ]);
  });

  test("flushes pending input before Enter, Escape, and Tab", async () => {
    const steps = record(`<input id="q" /><input id="r" />`);
    await userEvent.type(query("#q"), "abc{Enter}");
    await userEvent.keyboard("{Escape}{Tab}");
    await settle();
    expect(steps.map(({ command, selector, value }) => ({ command, selector, value }))).toEqual([
      { command: "fill", selector: "#q", value: "abc" },
      { command: "press", selector: "#q", value: "Enter" },
      { command: "press", selector: "#q", value: "Escape" },
      { command: "press", selector: "#q", value: "Tab" },
    ]);
  });

  test("stops recording once detached", async () => {
    const steps = record(`<button id="go">Go</button>`);
    detach();
    await userEvent.click(query("#go"));
    expect(steps).toEqual([]);
  });
});
