import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { renderJsonSchemas } from "../scripts/json-schema.ts";

const schemaDir = new URL("../schema/", import.meta.url);
const generated = await renderJsonSchemas();

test("schema/ holds exactly the generated files", () => {
  const committed = existsSync(schemaDir) ? readdirSync(schemaDir).toSorted() : [];
  expect(committed, "run `vp run schema:generate`").toEqual([...generated.keys()].toSorted());
});

test.each([...generated])("%s matches the protocol schemas", (file, text) => {
  const path = new URL(file, schemaDir);
  const committed = existsSync(path) ? readFileSync(path, "utf8") : "";
  expect(committed, `${file} is stale; run \`vp run schema:generate\``).toBe(text);
});

test("the output is deterministic: sorted keys and a trailing newline", async () => {
  const again = await renderJsonSchemas();
  expect([...again]).toEqual([...generated]);
  for (const text of generated.values()) {
    expect(text.endsWith("}\n")).toBe(true);
  }
});
