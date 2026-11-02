import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { renderJsonSchemas } from "./json-schema.ts";

const schemaDir = new URL("../schema/", import.meta.url);
const files = await renderJsonSchemas();

mkdirSync(schemaDir, { recursive: true });
// A schema removed from the protocol must not leave its stale file behind.
for (const file of readdirSync(schemaDir)) {
  if (!files.has(file)) rmSync(new URL(file, schemaDir));
}
for (const [file, text] of files) writeFileSync(new URL(file, schemaDir), text);
console.log(`Wrote ${files.size} JSON Schema files to packages/protocol/schema/.`);
