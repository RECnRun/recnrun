import { expect, test, vi } from "vite-plus/test";
import { main, USAGE } from "@/index";

function run(argv: string[], version = 3) {
  const lines: string[] = [];
  const service = { health: () => ({ ok: true as const, version }) };
  const code = main(argv, (line) => lines.push(line), service);
  return { code, lines };
}

test("--version prints the protocol version from the service's health", () => {
  expect(run(["--version"])).toEqual({ code: 0, lines: ["RECnRun protocol 3"] });
});

test("--version reaches the local service by default", () => {
  const lines: string[] = [];
  expect(main(["--version"], (line) => lines.push(line))).toBe(0);
  expect(lines).toEqual(["RECnRun protocol 1"]);
});

test("writes to standard output by default", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(main(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith("RECnRun protocol 1");
  } finally {
    log.mockRestore();
  }
});

test.each([[[]], [["open"]]])("prints the usage and fails for %j", (argv) => {
  expect(run(argv)).toEqual({ code: 1, lines: [USAGE] });
});
