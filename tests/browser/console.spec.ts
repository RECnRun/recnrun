import {
  MAX_CAPTURED_TEXT,
  MAX_VALUE_PROPERTIES,
  type CapturedEvent,
  type ConsoleValue,
  type Stack,
} from "../../packages/protocol/src/index.ts";
import { expect, test } from "./fixtures/capture.ts";

const CONSOLE_SCRIPT = "http://127.0.0.1:4600/routes/console.js";

function found<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The event was not captured.");
  return value;
}

const functionsOf = (stack: Stack | undefined) =>
  stack?.frames.filter((frame) => frame.url === CONSOLE_SCRIPT).map((frame) => frame.functionName);

test("a console call keeps bounded values and its stack, flagged where limits cut", async ({
  app,
  captured,
}) => {
  const page = await app.open("console");
  const documentId = await captured.documentOf(page);
  await page.getByTestId("values").click();
  const call = () =>
    captured.events.find(
      (event): event is Extract<CapturedEvent, { category: "console"; type: "api" }> =>
        event.category === "console" && event.type === "api" && event.documentId === documentId,
    );
  await expect.poll(() => call() !== undefined).toBe(true);
  const { payload } = found(call());
  expect(payload.truncated).toBe(true);
  expect(payload.args[0]).toBe("Fixture values");
  const [label, object, text, array, map] = payload.values as ConsoleValue[];
  expect(label).toEqual({ type: "string", value: "Fixture values" });
  // Chrome's preview already stops at a few properties and says so with its overflow flag.
  expect(object).toMatchObject({
    type: "object",
    className: "Object",
    preview: { truncated: true },
  });
  expect(text).toEqual({
    type: "string",
    value: "y".repeat(MAX_CAPTURED_TEXT),
    truncated: true,
  });
  expect(array).toMatchObject({ type: "object", subtype: "array", description: "Array(150)" });
  expect(array?.preview?.truncated).toBe(true);
  expect(array?.preview?.properties).toHaveLength(MAX_VALUE_PROPERTIES);
  expect(map).toMatchObject({
    subtype: "map",
    preview: { entries: [{ key: { description: "key" }, value: { type: "object" } }] },
  });
  expect(functionsOf(payload.stack)?.slice(0, 2)).toEqual(["innerLog", "outerLog"]);
  expect(payload.stack?.frames[0]).toMatchObject({ url: CONSOLE_SCRIPT, line: payload.line });
});

test("an uncaught exception keeps the stack Chrome recorded", async ({ app, captured }) => {
  const page = await app.open("console");
  const documentId = await captured.documentOf(page);
  await page.getByTestId("throw-nested").click();
  const thrown = () =>
    captured.events.find(
      (event): event is Extract<CapturedEvent, { category: "error" }> =>
        event.category === "error" && event.documentId === documentId,
    );
  await expect.poll(() => thrown() !== undefined).toBe(true);
  const { payload } = found(thrown());
  expect(payload.description).toContain("Thrown from a nested call");
  expect(functionsOf(payload.stack)?.slice(0, 2)).toEqual(["innerThrow", "outerThrow"]);
});
