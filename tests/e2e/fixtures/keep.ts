import { writeFileSync } from "node:fs";
import { test } from "./extension.ts";

/** Keeps an observation as JSON in the test's results, for the POC report to quote. */
export async function keep(name: string, value: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: "application/json" });
}
