import { expect, test } from "vite-plus/test";
import {
  FlowStoreError,
  canonicalJson,
  canonicalize,
  flowToYaml,
  parseFlowYaml,
  revisionOf,
} from "../src/index.ts";
import { spikeFlow } from "./flow-fixtures.ts";

test("canonical JSON sorts keys at every depth, keeps array order, and drops undefined", () => {
  const value = { b: [{ z: 1, a: undefined, m: [3, 1] }], a: null, é: "x", B: true };
  expect(canonicalize(value)).toEqual({ B: true, a: null, b: [{ m: [3, 1], z: 1 }], é: "x" });
  expect(canonicalJson(value)).toBe('{"B":true,"a":null,"b":[{"m":[3,1],"z":1}],"é":"x"}');
});

test("the YAML round trip is byte-stable and keeps the canonical JSON", () => {
  const first = parseFlowYaml("flow.yaml", flowToYaml(spikeFlow()));
  const yaml = flowToYaml(first);
  const second = parseFlowYaml("flow.yaml", yaml);
  expect(flowToYaml(second)).toBe(yaml);
  expect(canonicalJson(second)).toBe(canonicalJson(first));
  expect(revisionOf(second)).toBe(revisionOf(first));
  expect(revisionOf(first)).toMatch(/^[0-9a-f]{64}$/);
});

test("flow.yaml keeps the schema's field order and folds no long line", () => {
  const flow = { ...spikeFlow(), description: "word ".repeat(40).trim() };
  const yaml = flowToYaml(parseFlowYaml("flow.yaml", flowToYaml(flow)));
  expect(
    yaml.startsWith("schemaVersion: 1\nid: form-submit\nname: Submit the fixture form\n"),
  ).toBe(true);
  expect(yaml).toContain(`description: ${flow.description}\n`);
});

test("the revision does not depend on the order of keys", () => {
  const flow = spikeFlow();
  const reordered = Object.fromEntries(Object.entries(flow).toReversed());
  expect(revisionOf(parseFlowYaml("a", flowToYaml(reordered as typeof flow)))).toBe(
    revisionOf(parseFlowYaml("b", flowToYaml(flow))),
  );
});

test.each([
  ["text that is not YAML", "steps: [", "not-yaml"],
  ["YAML that is not a flow", "id: x\n", "invalid"],
])("%s is a FlowStoreError", (_, text, code) => {
  expect(() => parseFlowYaml("flows/x/flow.yaml", text)).toThrow(FlowStoreError);
  try {
    parseFlowYaml("flows/x/flow.yaml", text);
  } catch (error) {
    expect(error).toMatchObject({ code, path: "flows/x/flow.yaml" });
  }
});
