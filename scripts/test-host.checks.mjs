import assert from "node:assert/strict";
import { test } from "node:test";
import { hostCommands } from "./test-host.mjs";

const names = (commands) => commands.map(([command, ...args]) => `${command} ${args.join(" ")}`);

await test("test:host -- scripts runs only the script checks, with no build, Playwright, or Chrome", () => {
  assert.deepEqual(names(hostCommands(["scripts"])), ["vp run test:scripts:local"]);
  assert.deepEqual(names(hostCommands(["--", "scripts"])), ["vp run test:scripts:local"]);
});

await test("any other argument keeps the Playwright host runner and its two builds", () => {
  const commands = names(hostCommands(["tests/host/E5-handshake.spec.ts", "-g", "x"]));
  assert.deepEqual(commands, [
    "vp run --no-cache extension#build:test",
    "vp run --no-cache extension#build:poc-d0",
    "playwright test --config playwright.host.config.ts tests/host/E5-handshake.spec.ts -g x",
  ]);
  assert.equal(names(hostCommands([])).length, 3);
});
