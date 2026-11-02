import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { PROTOCOL_SCHEMA_VERSION, SchemaVersionSchema } from "../src/index.ts";

test("the protocol starts at schema version 1", () => {
  expect(PROTOCOL_SCHEMA_VERSION).toBe(1);
});

test("accepts the current schema version", () => {
  expect(v.parse(SchemaVersionSchema, 1)).toBe(1);
});

test.each([0, 2, "1", null])("rejects schema version %j", (value) => {
  expect(v.safeParse(SchemaVersionSchema, value).success).toBe(false);
});
