import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SUBJECT_LIMIT = 71;
const SCISSORS = /^# -+ >8 -+$/m;
const GENERATED_SUBJECT = /^(?:Merge |(?:fixup|squash|amend)! )/;
const CONVENTIONAL_PREFIX = /^[a-z]+(?:\([^)]*\))?!?:\s/i;
const SOURCE_PATH = /^(?:apps\/[^/]+\/(?:src|build)\/|packages\/[^/]+\/src\/)/;
const TEST_PATH = /(?:^|\/)tests?\/|\.(?:test|spec|checks)\.[cm]?[jt]sx?$/;

function cleanup(message) {
  const [kept = ""] = message.split(SCISSORS);
  return kept
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function subjectErrors(subject) {
  const errors = [];
  if (!subject) return ["The subject is empty."];
  if (subject.length > SUBJECT_LIMIT)
    errors.push(`The subject has ${subject.length} characters; keep it under 72.`);
  if (CONVENTIONAL_PREFIX.test(subject))
    errors.push("Remove the Conventional Commit prefix; write one imperative sentence.");
  else if (!/^[A-Z]/.test(subject)) errors.push("Start the subject with a capital letter.");
  if (subject.endsWith(".")) errors.push("Remove the trailing period from the subject.");
  return errors;
}

function evidenceErrors(body, stagedFiles) {
  if (!stagedFiles.some((path) => SOURCE_PATH.test(path))) return [];
  if (/^No-behavior-change:[ \t]*\S/m.test(body)) return [];
  const errors = [];
  if (!/^Red:/m.test(body) || !/^Green:/m.test(body))
    errors.push(
      "Source changes need `Red:` and `Green:` lines with the test commands, or `No-behavior-change: <reason>`.",
    );
  if (!stagedFiles.some((path) => TEST_PATH.test(path)))
    errors.push(
      "Source changes need their tests in the same commit, or `No-behavior-change: <reason>`.",
    );
  return errors;
}

/** Returns the AGENTS.md commit rules this message breaks for the staged paths. */
export function commitMessageErrors(message, stagedFiles) {
  const [subject = "", separator, ...rest] = cleanup(message).split("\n");
  if (GENERATED_SUBJECT.test(subject)) return [];
  const errors = subjectErrors(subject);
  if (separator !== undefined && separator !== "")
    errors.push("Leave a blank line between the subject and the body.");
  return [...errors, ...evidenceErrors(rest.join("\n"), stagedFiles)];
}

function stagedPaths() {
  return execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMRD"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = commitMessageErrors(readFileSync(process.argv[2], "utf8"), stagedPaths());
  if (errors.length) {
    console.error(`Commit message does not follow AGENTS.md "Commits":\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
}
