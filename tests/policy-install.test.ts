import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { policyUnavailability, writeOwnedPolicy } from "./browser/fixtures/policy-install.ts";
import type { PolicyHost } from "./browser/fixtures/policy-install.ts";

// The strict install writes /etc/opt/chrome/policies only as root inside the test container.
const container: PolicyHost = {
  platform: "linux",
  uid: 0,
  env: { RECNRUN_TEST_CONTAINER: "1" },
  dockerenv: true,
};

describe("policy install guard", () => {
  test("runs as root on Linux inside the test container", () => {
    expect(policyUnavailability(container)).toBeUndefined();
  });

  test("refuses a root Linux run outside the test container", () => {
    expect(policyUnavailability({ ...container, env: {} })).toMatch(/container/);
    expect(policyUnavailability({ ...container, dockerenv: false })).toMatch(/container/);
  });

  test("refuses another platform and a user other than root", () => {
    expect(policyUnavailability({ ...container, platform: "darwin" })).toMatch(/Linux only/);
    expect(policyUnavailability({ ...container, uid: 1000 })).toMatch(/root/);
  });
});

describe("owned policy file", () => {
  let scratch = "";
  let file = "";

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "recnrun-policy-"));
    file = join(scratch, "managed", "recnrun.json");
  });

  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  test("creates the file and removes it while it holds what was written", async () => {
    const owned = await writeOwnedPolicy(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    await owned.remove();
    expect(existsSync(file)).toBe(false);
  });

  test("refuses to overwrite a policy file that already exists", async () => {
    await writeOwnedPolicy(file, '{"theirs":1}');
    await expect(writeOwnedPolicy(file, '{"ours":1}')).rejects.toThrow(/exists/);
    expect(readFileSync(file, "utf8")).toBe('{"theirs":1}');
  });

  test("refuses to remove a file that changed since this invocation wrote it", async () => {
    const owned = await writeOwnedPolicy(file, '{"ours":1}');
    writeFileSync(file, '{"theirs":1}');
    await expect(owned.remove()).rejects.toThrow(/did not write/);
    expect(readFileSync(file, "utf8")).toBe('{"theirs":1}');
  });
});
