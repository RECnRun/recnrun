import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Codex, unlike Claude Code, never stops re-running a blocking Stop hook, so an
// unfixable failure (read-only sandbox, Docker down) would loop forever.
const MAX_CONSECUTIVE_BLOCKS = 3;

const {
  cwd,
  session_id: sessionId,
  stop_hook_active: retrying,
} = JSON.parse(readFileSync(0, "utf8"));
const counter = join(
  tmpdir(),
  `recnrun-stop-hook-${String(sessionId ?? "unknown").replace(/[^\w-]/g, "_")}`,
);

function previousBlocks() {
  if (!retrying) return 0;
  try {
    return Number(readFileSync(counter, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function block(reason) {
  const blocks = previousBlocks() + 1;
  if (blocks > MAX_CONSECUTIVE_BLOCKS) {
    rmSync(counter, { force: true });
    console.log(
      JSON.stringify({
        systemMessage: `Quality checks still fail after ${MAX_CONSECUTIVE_BLOCKS} attempts; stopping anyway. ${reason}`,
      }),
    );
    return;
  }
  writeFileSync(counter, String(blocks));
  console.log(JSON.stringify({ decision: "block", reason }));
}

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd,
  encoding: "utf8",
});

if (root.status !== 0) {
  block("Could not locate the Git root to run the quality checks.");
  process.exit(0);
}

// Fast gates only: formatting, lint, types, and architecture boundaries.
const CHECKS = [
  ["vp", "check"],
  ["vp", "run", "--no-cache", "deps"],
];

function firstFailure() {
  for (const [command, ...args] of CHECKS) {
    const result = spawnSync(command, args, {
      cwd: root.stdout.trim(),
      encoding: "utf8",
      timeout: 55_000,
    });
    if (result.status !== 0) {
      const name = [command, ...args].join(" ");
      // vp prints diagnostics on stdout and only a summary on stderr.
      const details = [result.stdout, result.stderr, result.error?.message].join("\n").trim();
      return `${name} failed. Fix the issues and run it again. ${details.slice(-3000)}`;
    }
  }
  return undefined;
}

const failure = firstFailure();
if (failure === undefined) {
  rmSync(counter, { force: true });
  console.log("{}");
} else {
  block(failure);
}
