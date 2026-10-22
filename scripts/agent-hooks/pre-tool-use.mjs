import { readFileSync } from "node:fs";

const { tool_input: toolInput } = JSON.parse(readFileSync(0, "utf8"));
const command = toolInput?.command;

if (typeof command === "string") {
  const gitWrite = /\bgit\b[\s\S]*\b(?:commit|push)\b/.test(command);
  const bypass = /--no-verify\b/.test(command);
  const shortCommitBypass = /\bgit\b[\s\S]*\bcommit\b[^\n;|&]*\s-n(?:\s|$)/.test(command);
  const disabledEnvironment = /\b(?:VP_GIT_HOOKS|HUSKY)\s*=\s*["']?0\b/.test(command);
  const disabledConfig = /\b(?:core\.hooksPath|vp\.hooks\.disabled)\s*=/.test(command);
  const changesHookConfig =
    /\bgit\s+config\b[^\n;|&]*\b(?:core\.hooksPath|vp\.hooks\.disabled)\b/.test(command) &&
    !/\bgit\s+config\s+--(?:get|get-all|show-origin)\b/.test(command);
  const disablesViteHooks = /\bvp\s+hooks\s+disable\b/.test(command);

  if (
    (gitWrite && (bypass || shortCommitBypass || disabledEnvironment || disabledConfig)) ||
    changesHookConfig ||
    disablesViteHooks
  ) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Git hooks are required in this project. Fix the failing gate, then commit or push normally.",
        },
      }),
    );
  }
}
