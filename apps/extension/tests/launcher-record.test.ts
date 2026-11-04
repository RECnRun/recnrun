import { readFileSync } from "node:fs";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  LauncherRecordSchema,
  parseLauncherRecord,
  serializeLauncherRecord,
} from "@/p2p/launcher-record";
import type { LauncherRecord } from "@/p2p/launcher-record";
import { FINGERPRINT, ME, PEER } from "./fake-peer";

const master: LauncherRecord = {
  userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
  profileDirectory: "Default",
  profileId: ME,
  namespace: "lab-1",
  role: "master",
  masterFingerprint: FINGERPRINT,
  downloadsRoot: "/Users/me/Downloads",
  root: "r1",
};
const worker: LauncherRecord = {
  userDataDir: "/Users/me/RECnRun/clones/worker-1",
  profileDirectory: "Profile 2",
  profileId: PEER,
  role: "worker",
};
const extraRoot: LauncherRecord = { downloadsRoot: "/Volumes/Data_1/Downloads", root: "r2" };

const text = [
  `userDataDir=${master.userDataDir}`,
  "profileDirectory=Default",
  `profileId=${ME}`,
  "namespace=lab-1",
  "role=master",
  `masterFingerprint=${FINGERPRINT}`,
  "downloadsRoot=/Users/me/Downloads",
  "root=r1",
  "",
  `userDataDir=${worker.userDataDir}`,
  "profileDirectory=Profile 2",
  `profileId=${PEER}`,
  "role=worker",
  "",
  "downloadsRoot=/Volumes/Data_1/Downloads",
  "root=r2",
  "",
].join("\n");

describe("parseLauncherRecord", () => {
  test("reads one record per block of key=value lines", () => {
    expect(parseLauncherRecord(text)).toEqual([master, worker, extraRoot]);
  });

  test("tolerates extra blank lines and a missing final newline", () => {
    expect(parseLauncherRecord(`\n\n${text}\n\n`)).toEqual([master, worker, extraRoot]);
    expect(parseLauncherRecord("downloadsRoot=/d")).toEqual([{ downloadsRoot: "/d" }]);
    expect(parseLauncherRecord("")).toEqual([]);
  });

  test.each([
    ["a line without =", "userDataDir", /line 1: expected key=value/],
    ["a comment", "# note", /line 1: expected key=value/],
    ["an unknown key", "command=rm -rf /", /line 1: unknown key "command"/],
    ["a repeated key", "downloadsRoot=/a\ndownloadsRoot=/b", /line 2: repeated key/],
    ["an empty value", "downloadsRoot=", /line 1: empty value/],
    ["a carriage return", "downloadsRoot=/a\r\n", /carriage return/],
    ["a .. segment", "userDataDir=/Users/me/../x\nprofileDirectory=Default", /line 1: /],
    ["a trailing .. segment", "downloadsRoot=/Users/..", /line 1: /],
    ["a relative directory", "downloadsRoot=Downloads", /line 1: /],
    ["a shell character", "downloadsRoot=/Users/$(id)", /line 1: /],
    ["a quote", "downloadsRoot=/Users/it's", /line 1: /],
    ["a profile directory with a slash", "userDataDir=/a\nprofileDirectory=x/y", /line 1: /],
    ["a profile directory ..", "userDataDir=/a\nprofileDirectory=..", /line 1: /],
    ["another role", "userDataDir=/a\nprofileDirectory=Default\nrole=admin", /line 1: /],
    [
      "an upper-case profile id",
      "downloadsRoot=/a\nprofileId=ABCDEF00-0000-4000-8000-000000000000",
      /line 1: /,
    ],
    ["a path as root id", "downloadsRoot=/a\nroot=/a", /line 1: /],
    ["a user data dir without its profile", "userDataDir=/a", /line 1: /],
    ["a root id without its root", "userDataDir=/a\nprofileDirectory=Default\nroot=r1", /line 1: /],
    ["a block naming no directory", "role=worker", /line 1: /],
  ])("refuses %s", (_name, input, error) => {
    expect(() => parseLauncherRecord(input)).toThrow(error);
  });

  test("names the first line of the block that fails", () => {
    expect(() => parseLauncherRecord(`${text}\nrole=worker\n`)).toThrow(/line 18: /);
  });

  test("refuses a record too long to be the launcher's", () => {
    expect(() => parseLauncherRecord(`downloadsRoot=/${"a".repeat(70_000)}`)).toThrow(/too long/);
  });
});

describe("the record scripts/poc-cross-profile/catalog.sh rewrites", () => {
  test("parses, and serializes back to the same text", () => {
    // catalog.checks.mjs regenerates this sample from a run of the script.
    const sample = new URL(
      "../../../scripts/poc-cross-profile/fixtures/launcher.sample.record",
      import.meta.url,
    );
    const text = readFileSync(sample, "utf8");
    const records = parseLauncherRecord(text);
    expect(records.map((record) => record.root)).toEqual(["r1", "r2"]);
    expect(serializeLauncherRecord(records)).toBe(text);
  });
});

describe("serializeLauncherRecord", () => {
  test("writes the keys in a fixed order and a blank line between records", () => {
    expect(serializeLauncherRecord([master, worker, extraRoot])).toBe(text);
    expect(serializeLauncherRecord([])).toBe("");
  });

  test("round-trips through the parser", () => {
    const shuffled = { root: "r1", downloadsRoot: "/d", userDataDir: "/u", profileDirectory: "P" };
    expect(parseLauncherRecord(serializeLauncherRecord([shuffled]))).toEqual([shuffled]);
  });

  test("refuses to write a record the parser would refuse", () => {
    expect(() => serializeLauncherRecord([{ downloadsRoot: "/a\nrole=master" }])).toThrow();
    expect(v.is(LauncherRecordSchema, { downloadsRoot: "/a", path: "/b" })).toBe(false);
  });
});
