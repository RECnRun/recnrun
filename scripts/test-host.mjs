import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The commands `vp run test:host -- <args>` runs, in order. */
export function hostCommands(forwarded) {
  const args = forwarded[0] === "--" ? forwarded.slice(1) : forwarded;
  // The shell checks need macOS /bin/sh only: no extension build, no Playwright, no Chrome.
  if (args.length === 1 && args[0] === "scripts") return [["vp", "run", "test:scripts:local"]];
  return [
    ["vp", "run", "--no-cache", "extension#build:test"],
    ["vp", "run", "--no-cache", "extension#build:poc-d0"],
    ["playwright", "test", "--config", "playwright.host.config.ts", ...args],
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [command, ...args] of hostCommands(process.argv.slice(2))) {
    const { status } = spawnSync(command, args, { stdio: "inherit" });
    if (status !== 0) process.exit(status ?? 1);
  }
}
