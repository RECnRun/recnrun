import { describe, expect, it } from "vite-plus/test";
import { masterOf } from "./fixtures/clones-host.ts";

const master = [
  "userDataDir=/m",
  "profileDirectory=Default",
  "profileId=master-id",
  "namespace=poc",
  "role=master",
  "downloadsRoot=/Users/o/Downloads",
].join("\n");
const worker = master.replace("master-id", "w1").replace("role=master", "role=worker");

describe("masterOf", () => {
  it("reads the master block among worker blocks", () => {
    expect(masterOf(`${worker}\n${master}\n${worker}\n`)).toEqual({
      profileId: "master-id",
      downloads: "/Users/o/Downloads",
    });
  });

  it("refuses a record without a master block", () => {
    expect(() => masterOf(`${worker}\n`)).toThrow("no role=master block");
  });
});
