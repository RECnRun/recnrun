import { expect, test, vi } from "vite-plus/test";
import { main, type Deps, type Io } from "@/main";
import { USAGE } from "@/args";
import { CLI_VERSION } from "@/version";

function setup(overrides: Partial<Deps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line), home: "/home/u" };
  const stopOnSignals = vi.fn(() => undefined);
  const close = vi.fn(async () => undefined);
  const connection = {
    client: { call: vi.fn() },
    reused: true,
    url: "http://127.0.0.1:4700/",
    stopOnSignals,
    close,
  };
  const openUrl = vi.fn(async (_url: string) => undefined);
  const deps: Deps = { connect: async () => connection as never, openUrl, ...overrides };
  return { io, out, err, deps, connection, openUrl, stopOnSignals, close };
}

test("--version prints the CLI version", async () => {
  const { io, out, deps } = setup();
  expect(await main(["--version"], io, deps)).toBe(0);
  expect(out).toEqual([`recnrun ${CLI_VERSION}`]);
});

test("--help and no arguments print the usage and exit 0", async () => {
  for (const argv of [["--help"], []]) {
    const { io, out, deps } = setup();
    expect(await main(argv, io, deps)).toBe(0);
    expect(out).toEqual([USAGE]);
  }
});

test("a bad command line is exit 2 with the reason and the usage on stderr", async () => {
  const { io, out, err, deps } = setup();
  expect(await main(["frobnicate"], io, deps)).toBe(2);
  expect(out).toEqual([]);
  expect(err[0]).toMatch(/Unknown command "frobnicate"/);
  expect(err).toContain(USAGE);
});

test("open prints the UI URL, and opens the browser unless --no-browser", async () => {
  const quiet = setup();
  expect(await main(["open", "--no-browser"], quiet.io, quiet.deps)).toBe(0);
  expect(quiet.out).toEqual(["http://127.0.0.1:4700/"]);
  expect(quiet.openUrl).not.toHaveBeenCalled();

  const loud = setup();
  expect(await main(["open"], loud.io, loud.deps)).toBe(0);
  expect(loud.openUrl).toHaveBeenCalledWith("http://127.0.0.1:4700/");
});

test("open keeps a service it started and stops it on signals; a reused one is left alone", async () => {
  const started = setup();
  started.connection.reused = false;
  await main(["open", "--no-browser"], started.io, started.deps);
  expect(started.stopOnSignals).toHaveBeenCalledOnce();
  expect(started.close).not.toHaveBeenCalled();

  const reused = setup();
  await main(["open", "--no-browser"], reused.io, reused.deps);
  expect(reused.stopOnSignals).not.toHaveBeenCalled();
});

test("a failed browser launch is a warning, not a failure", async () => {
  const { io, err, deps } = setup({
    openUrl: async () => {
      throw new Error("no opener");
    },
  });
  expect(await main(["open"], io, deps)).toBe(0);
  expect(err.join("\n")).toMatch(/Could not open a browser: no opener/);
});

test("open reports a service that cannot start as exit 2", async () => {
  const { io, err, deps } = setup({
    connect: async () => {
      throw new Error("Another RECnRun service is still starting");
    },
  });
  expect(await main(["open", "--no-browser"], io, deps)).toBe(2);
  expect(err.join("\n")).toContain("still starting");
});
