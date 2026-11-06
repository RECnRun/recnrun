import { describe, expect, test } from "vite-plus/test";
import { openProblems, parseOpened } from "./fixtures/launcher-open.ts";
import type { Opened } from "./fixtures/launcher-open.ts";

const TOKEN = "3f2b8c1e-5a47-4d90-8e6f-0123456789ab";
const OTHER = "9a1c2d3e-4b5f-4a60-9b7c-abcdef012345";
const DOWNLOADS = "/root/downloads";

const opened = (fields: Partial<Opened> = {}): Opened => ({
  code: 0,
  root: DOWNLOADS,
  boot: TOKEN,
  token: TOKEN,
  pid: 7,
  ms: 1,
  stderr: "",
  ...fields,
});

describe("parseOpened", () => {
  test("reads the fields of stdout and the pid of stderr", () => {
    const stdout = `root=${DOWNLOADS}\nboot=${TOKEN}\ntoken=${OTHER}\n`;
    expect(parseOpened(stdout, "open.sh: x\npid=4242\n")).toEqual({
      root: DOWNLOADS,
      boot: TOKEN,
      token: OTHER,
      pid: 4242,
    });
  });

  test("keeps an equals sign inside a value and tolerates missing output", () => {
    expect(parseOpened("root=/a=b\n", "").root).toBe("/a=b");
    expect(parseOpened("", "")).toEqual({ root: "", boot: "", token: "", pid: 0 });
  });
});

describe("openProblems", () => {
  test("a fresh start whose boot is its token has none", () => {
    expect(openProblems(DOWNLOADS, opened())).toEqual([]);
  });

  test("names a failed exit, another root, a bad token, and a boot that is not the token", () => {
    const bad = opened({ code: 69, root: "/elsewhere", token: "nope", boot: OTHER });
    expect(openProblems(DOWNLOADS, bad)).toHaveLength(4);
  });

  test("a running profile keeps its boot under a new token", () => {
    const first = opened();
    expect(openProblems(DOWNLOADS, opened({ token: OTHER }), first)).toEqual([]);
    const replaced = opened({ token: OTHER, boot: OTHER });
    expect(openProblems(DOWNLOADS, replaced, first)).toHaveLength(1);
    expect(openProblems(DOWNLOADS, opened(), first)).toHaveLength(1);
  });
});
