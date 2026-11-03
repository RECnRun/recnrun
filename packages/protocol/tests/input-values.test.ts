import { expect, test } from "vite-plus/test";
import { checkInputValues, validateFlow, type Flow } from "../src/index.ts";

const flow: Flow = {
  schemaVersion: 1,
  id: "typed",
  name: "Typed inputs",
  actors: {},
  inputs: {
    name: { type: "string", required: true },
    retries: { type: "number", required: false, default: 2 },
    remember: { type: "boolean", required: false },
    tags: { type: "array", required: false },
    options: { type: "object", required: false },
    pin: { type: "string", required: true, secret: true },
  },
  requirements: [],
  preconditions: [],
  steps: [],
};

const typed = (name: string, type: string, given: string) =>
  `Input "${name}" has type ${type}; the value given is ${given}.`;

test("values of the declared types pass, and so does an empty dataset", () => {
  const values = { name: "Ana", retries: 3, remember: true, tags: ["a"], options: { a: 1 } };
  expect(checkInputValues(flow, values)).toEqual([]);
  expect(checkInputValues(flow, {})).toEqual([]);
});

test.each<[string, Record<string, unknown>, string, string]>([
  [
    "an undeclared input",
    { nope: 1 },
    "unknown-input",
    'Input "nope" is not declared in the flow.',
  ],
  [
    "a secret input",
    { pin: "1234" },
    "secret-input",
    'Input "pin" is secret: its value comes only from secrets, never from a dataset.',
  ],
  ["a string for a number", { retries: "3" }, "input-type", typed("retries", "number", "a string")],
  ["NaN for a number", { retries: Number.NaN }, "input-type", typed("retries", "number", "NaN")],
  ["null for an object", { options: null }, "input-type", typed("options", "object", "null")],
  ["an array for an object", { options: [] }, "input-type", typed("options", "object", "an array")],
  ["an object for an array", { tags: {} }, "input-type", typed("tags", "array", "an object")],
  [
    "a string for a boolean",
    { remember: "y" },
    "input-type",
    typed("remember", "boolean", "a string"),
  ],
])("%s is reported without its value", (_name, values, code, message) => {
  const [name = ""] = Object.keys(values);
  expect(checkInputValues(flow, values)).toEqual([{ code, name, message }]);
  expect(JSON.stringify(checkInputValues(flow, values))).not.toContain("1234");
});

test("every wrong value is reported, in the order given", () => {
  const issues = checkInputValues(flow, { pin: "1234", retries: "3", name: "Ana", nope: 1 });
  expect(issues.map(({ code }) => code)).toEqual(["secret-input", "input-type", "unknown-input"]);
});

test("a flow whose input default has another type than declared is invalid", () => {
  const wrong = { ...flow, inputs: { retries: { type: "number", default: "two" } } };
  expect(validateFlow(wrong)).toEqual({
    ok: false,
    issues: [
      {
        code: "input-default",
        path: ["inputs", "retries", "default"],
        message: 'Input "retries" has type number; its default is a string.',
      },
    ],
  });
  const right = { ...flow, inputs: { retries: { type: "number", default: 2 } } };
  expect(validateFlow(right).ok).toBe(true);
});
