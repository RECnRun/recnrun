import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = (await import(pathToFileURL(join(root, "vite.config.ts")).href)).default;
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const tasks = config.run.tasks;

// A project's name is its config's test.name, else its package name, as Vitest resolves it.
function projectName(entry) {
  const file = entry.endsWith(".ts") ? entry : join(entry, "vite.config.ts");
  const named = /test:\s*{[^}]*?\bname:\s*"([^"]+)"/s.exec(readFileSync(join(root, file), "utf8"));
  if (named) return named[1];
  const manifest = join(root, entry.endsWith(".ts") ? dirname(entry) : entry, "package.json");
  assert.ok(existsSync(manifest), `No test.name or package.json for ${entry}`);
  return JSON.parse(readFileSync(manifest, "utf8")).name;
}

const rootProjects = config.test.projects.map(projectName);
const byName = (a, b) => a.localeCompare(b);

function vitestProjects(segment) {
  const filters = [...segment.matchAll(/--project=(\S+)/g)].map(([, name]) => name);
  if (filters.length) return filters;
  const configFile = /--config\s+(\S+)/.exec(segment);
  return configFile ? [projectName(configFile[1])] : rootProjects;
}

/** Every test project or Playwright config a `vp run` command executes, expanded recursively. */
function projectsOf(command) {
  const name = /^vp run (?:-r )?(?:--no-cache )?(\S+)$/.exec(command)?.[1];
  if (name && tasks[name]) return [tasks[name].command].flat().flatMap(projectsOf);
  const script = name === undefined ? command : scripts[name];
  if (script === undefined) return [];
  return script.split("&&").flatMap((part) => {
    const segment = part.trim();
    if (segment.startsWith("vp test")) return vitestProjects(segment);
    if (segment.startsWith("playwright test")) {
      return [/--config\s+(\S+)/.exec(segment)?.[1] ?? "playwright.config.ts"];
    }
    return segment.startsWith("vp run") ? projectsOf(segment) : [];
  });
}

function gateOf(command) {
  if (command === "vp check") return "check";
  if (command === "vp lint --deny-warnings") return "lint";
  return /^vp run (?:-r )?--no-cache (?:test:)?([^\s:]+(?::check)?)(?::local)?$/.exec(command)?.[1];
}

test("verify runs every gate once and every test project once", () => {
  const verify = tasks["verify:local"].command;
  assert.deepEqual(verify.map(gateOf), [
    "check",
    "lint",
    "deps",
    "coverage",
    "e2e",
    "browser",
    "container",
    "hooks",
    "scripts",
    "dead-code",
    "duplication",
    "docs:check",
    "build",
  ]);
  const projects = verify.flatMap(projectsOf);
  const repeated = projects.filter((project, index) => projects.indexOf(project) !== index);
  assert.deepEqual(repeated, [], `Projects verify runs more than once: ${repeated.join(", ")}`);
  const suite = projectsOf("vp run --no-cache test:local");
  assert.deepEqual(projects.toSorted(byName), suite.toSorted(byName));
});

test("coverage runs exactly the unit, component, and contract projects, unfiltered", () => {
  const coverage = projectsOf("vp run --no-cache test:coverage:local");
  const plain = ["test:unit:local", "test:components:local", "test:contract:local"].flatMap(
    (script) => projectsOf(`vp run --no-cache ${script}`),
  );
  assert.deepEqual(coverage.toSorted(byName), plain.toSorted(byName));
  // A --project filter leaves Vitest's V8 report empty, which passes every threshold.
  assert.doesNotMatch(scripts["test:coverage:local"], /--project/);
});

test("the vp run test suite keeps all five layers", () => {
  assert.deepEqual(tasks["test:local"].command, [
    "vp run --no-cache test:unit:local",
    "vp run --no-cache test:components:local",
    "vp run --no-cache test:contract:local",
    "vp run --no-cache test:e2e:local",
    "vp run --no-cache test:browser:local",
  ]);
});
