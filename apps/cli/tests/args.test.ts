import { expect, test } from "vite-plus/test";
import { parseArgs } from "@/args";

test.each([
  [[], { kind: "help" }],
  [["--help"], { kind: "help" }],
  [["-h"], { kind: "help" }],
  [["--version"], { kind: "version" }],
  [["open"], { kind: "open", noBrowser: false, home: undefined }],
  [["open", "--no-browser", "--home", "/tmp/h"], { kind: "open", noBrowser: true, home: "/tmp/h" }],
  [["open", "--home=/tmp/h"], { kind: "open", noBrowser: false, home: "/tmp/h" }],
  [["doctor"], { kind: "doctor", json: false, home: undefined }],
  [["doctor", "--json"], { kind: "doctor", json: true, home: undefined }],
  [
    ["run", "--flow", "f", "--dataset", "default", "--json"],
    { kind: "run", flow: "f", dataset: "default", home: undefined, timeoutMs: 600_000 },
  ],
  [
    ["run", "--flow", "f", "--timeout", "5"],
    { kind: "run", flow: "f", dataset: undefined, home: undefined, timeoutMs: 5000 },
  ],
])("parses %j", (argv, command) => {
  expect(parseArgs(argv)).toEqual({ ok: true, command });
});

test.each([
  [["frobnicate"], /Unknown command "frobnicate"/],
  [["open", "--json"], /Unknown option "--json" for open/],
  [["open", "extra"], /Unexpected argument "extra"/],
  [["run"], /requires --flow/],
  [["run", "--flow"], /--flow needs a value/],
  [["run", "--flow", "f", "--timeout", "soon"], /--timeout needs a positive number/],
  [["doctor", "--json=yes"], /--json takes no value/],
])("rejects %j", (argv, message) => {
  const parsed = parseArgs(argv);
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.message).toMatch(message);
});
