import { readFileSync } from "node:fs";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";
import { FlowSchema, TargetSchema, validateFlow } from "../src/index.ts";

function fixture(name: string): unknown {
  return parse(readFileSync(new URL(`./fixtures/${name}.yaml`, import.meta.url), "utf8"));
}

describe("the source plan examples", () => {
  test("§9 order approval parses and validates", () => {
    const result = validateFlow(fixture("source-9-order-approval"));
    expect(result).toMatchObject({ ok: true, flow: { id: "pedido-aprovacao" } });
    expect(result.ok && result.flow.steps).toHaveLength(8);
  });

  test("§9.3 macro loop parses and validates", () => {
    const result = validateFlow(fixture("source-9-3-macro-loop"));
    expect(result).toMatchObject({
      ok: true,
      flow: { steps: [{ builtin: "counter" }, { builtin: "forEach", steps: [{ builtin: "if" }] }] },
    });
    const branch = result.ok ? result.flow.steps[1] : undefined;
    expect(branch).toMatchObject({
      steps: [{ steps: [{ id: "processar" }, { id: "contar" }], otherwise: [] }],
    });
  });

  test("§9.1 locator list parses as a target", () => {
    const { target } = fixture("source-9-1-locator-list") as { target: unknown };
    const parsed = v.parse(TargetSchema, target);
    expect(parsed).toMatchObject({ resolution: "orderedFallback", cardinality: "one" });
  });
});

describe("validateFlow rejects", () => {
  test.each([
    ["invalid-unknown-action", "unknown-action", ["steps", 0, "action"]],
    ["invalid-unknown-namespace", "unknown-namespace", ["steps", 0, "url"]],
    ["invalid-duplicate-step-id", "duplicate-step-id", ["steps", 1, "id"]],
    ["invalid-missing-input", "missing-input", ["steps", 0, "value"]],
    ["invalid-cyclic-variable", "cyclic-variable", ["steps", 0]],
    ["invalid-nth-without-index", "nth-without-index", ["steps", 0, "target"]],
  ])("%s with the issue %s", (name, code, path) => {
    const result = validateFlow(fixture(name));
    expect(result.ok ? [] : result.issues.map((issue) => [issue.code, issue.path])).toEqual([
      [code, path],
    ]);
  });

  test("an input that is not an object", () => {
    expect(validateFlow("steps: []")).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-schema", path: [] }],
    });
  });

  test("an unknown assertion and an unknown builtin nested in a loop", () => {
    const flow = {
      schemaVersion: 1,
      id: "nested",
      name: "Nested",
      steps: [
        { id: "a", assertion: "glows", target: "#x" },
        { id: "b", builtin: "repeat", times: 2, steps: [{ id: "c", builtin: "goto" }] },
      ],
    };
    const result = validateFlow(flow);
    expect(result.ok ? [] : result.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["unknown-assertion", ["steps", 0, "assertion"]],
      ["unknown-builtin", ["steps", 1, "steps", 0, "builtin"]],
    ]);
  });

  test("a malformed interpolation and a step with no kind", () => {
    const flow = {
      schemaVersion: 1,
      id: "malformed",
      name: "Malformed",
      steps: [
        { id: "a", action: "navigate", url: "${inputs.}" },
        { id: "b", target: "#x" },
      ],
    };
    const result = validateFlow(flow);
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toEqual([
      "invalid-interpolation",
      "invalid-schema",
    ]);
  });

  test("an if block with thenable `then`/`else` branches", () => {
    // Written as YAML, the way a user would, since a `then` key in code is itself a thenable.
    const flow = parse(`
      schemaVersion: 1
      id: thenable
      name: Thenable
      steps:
        - { id: a, builtin: if, condition: { functionRef: team.ok@1.0.0 }, then: [], else: [] }
    `);
    expect(validateFlow(flow)).toMatchObject({ ok: false, issues: [{ code: "invalid-schema" }] });
  });

  test("a duplicate step id inside an `otherwise` branch", () => {
    const flow = {
      schemaVersion: 1,
      id: "branches",
      name: "Branches",
      steps: [
        {
          id: "a",
          builtin: "if",
          condition: { functionRef: "team.ok@1.0.0" },
          steps: [],
          otherwise: [{ id: "a", builtin: "break" }],
        },
      ],
    };
    expect(validateFlow(flow)).toMatchObject({
      ok: false,
      issues: [{ code: "duplicate-step-id", path: ["steps", 0, "otherwise", 0, "id"] }],
    });
  });

  test("a variable defined from itself", () => {
    const flow = {
      schemaVersion: 1,
      id: "self",
      name: "Self",
      steps: [{ id: "a", builtin: "setVariable", name: "x", value: "${vars.x}!" }],
    };
    expect(validateFlow(flow)).toMatchObject({
      ok: false,
      issues: [{ code: "cyclic-variable", path: ["steps", 0] }],
    });
  });
});

describe("FlowSchema", () => {
  test("defaults the optional sections and the locator list policy", () => {
    const flow = v.parse(FlowSchema, {
      schemaVersion: 1,
      id: "defaults",
      name: "Defaults",
      steps: [
        { id: "a", action: "click", target: { locators: [{ strategy: "css", value: "a" }] } },
      ],
    });
    expect(flow).toMatchObject({ actors: {}, inputs: {}, requirements: [], preconditions: [] });
    expect(flow.steps[0]).toMatchObject({
      target: { resolution: "orderedFallback", cardinality: "one" },
    });
  });

  test.each([
    ["a second schema version", { schemaVersion: 2 }],
    ["an actor with a profile binding", { actors: { a: { profileBinding: "a" } } }],
    ["a precondition without a check", { preconditions: [{ authenticated: "a" }] }],
    ["an unknown top-level key", { owner: "me" }],
  ])("rejects %s", (_name, override) => {
    const flow = { schemaVersion: 1, id: "x", name: "X", steps: [], ...override };
    expect(v.safeParse(FlowSchema, flow).success).toBe(false);
  });

  test.each([
    ["a CSS string", "#save"],
    ["a shorthand label", { label: "Email" }],
    [
      "a full locator with composition",
      { strategy: "text", value: "Save", within: { css: "form" } },
    ],
    ["an nth list with its index", { cardinality: "nth", index: 2, locators: [{ xpath: "//li" }] }],
  ])("accepts %s as a target", (_name, target) => {
    expect(v.safeParse(TargetSchema, target).success).toBe(true);
  });

  test.each([
    ["an empty locator list", { locators: [] }],
    ["a function locator with a bad reference", { strategy: "function", functionRef: "x" }],
    ["a shorthand with two strategies", { testId: "a", css: "b" }],
  ])("rejects %s as a target", (_name, target) => {
    expect(v.safeParse(TargetSchema, target).success).toBe(false);
  });
});
