import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { shells } from "../../../../scripts/poc-cross-profile/lab.mjs";
import { alive } from "../../../../scripts/poc-cross-profile/lifecycle-lab.mjs";
import {
  EX_FAILED,
  fields,
  launcherScene,
  pairedLauncher,
  sha256,
  statusOf,
  submit,
  waitFor,
} from "./launcher-lab.mjs";

const extension = fileURLToPath(new URL("../worker-extension", import.meta.url));
const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n") : []);
const installs = (s) => lines(join(s.home, "launches.txt")).filter((l) => l === "launch").length;
const workers = (s) => lines(join(s.home, "launches.txt")).filter((l) => l === "worker").length;
const provisioned = (s) => fields(join(s.root, "provisioned"));
const pids = (s) => readdirSync(join(s.state, "pids"));

/** Every process whose command line names the worker root. */
function holders(s) {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  return ps
    .split("\n")
    .filter((line) => line.includes(`--user-data-dir=${s.root}/chrome`))
    .map((line) => Number.parseInt(line, 10));
}

/** Sends a request and waits for its last status: delivering, or refused with a code. */
async function launch(s, p) {
  const sent = await submit(s, p);
  await waitFor(() => ["delivering", "refused"].includes(statusOf(s, sent.rid).state), 30_000);
  return statusOf(s, sent.rid);
}

async function stop(run, code = 130) {
  process.kill(run.pid, "SIGINT");
  assert.equal(await run.exited, code, run.err);
}

await test("RELEASE names the version of the bundled worker extension", () => {
  const release = fields(fileURLToPath(new URL("./RELEASE", import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
  assert.equal(release.extensionVersion, manifest.version);
});

for (const shell of shells) {
  await test(`${shell}: a request provisions the root and launches a bare worker`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    assert.equal((await launch(s, p)).state, "delivering", p.run.err);
    const record = provisioned(s);
    const spki = readFileSync(join(s.ws, "peers/w1/worker.spki"));
    assert.ok(existsSync(join(s.root, ".recnrun-lab-root")));
    assert.deepEqual(
      [record.launcherVersion, record.extensionVersion, record.masterFp, record.generation],
      ["0.1.0", "0.0.1", p.key.fp, "1"],
    );
    assert.equal(record.workerFp, sha256(spki));
    assert.match(p.run.out, new RegExp(`^worker=${record.workerFp}$`, "m"));
    const policy = JSON.parse(readFileSync(join(s.root, "ext/policy.json"), "utf8"));
    assert.deepEqual(
      [policy.workspace, policy.allow, policy.masterSpki, policy.exchangeUrl],
      [
        p.workspace,
        ["http://127.0.0.1:4600"],
        p.key.spki.toString("base64"),
        `file://${s.root}/exchange/`,
      ],
    );
    const argv = lines(join(s.home, "worker-argv.txt"));
    assert.ok(argv.includes(`--user-data-dir=${s.root}/chrome`) && argv.includes("--headless=new"));
    assert.ok(!argv.some((a) => /--remote-debugging|--enable-unsafe-extension-debugging/.test(a)));
    assert.deepEqual([installs(s), holders(s).length], [1, 1]);
    await stop(p.run);
    assert.ok(lines(join(s.home, "launches.txt")).includes("worker int"), "SIGINT ends the worker");
    assert.deepEqual([holders(s), pids(s)], [[], []]);
  });

  await test(`${shell}: the same versions reuse the root and the running worker`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    await launch(s, p);
    assert.equal((await launch(s, p)).state, "delivering");
    assert.deepEqual([installs(s), workers(s), provisioned(s).generation], [1, 1, "1"]);
    await stop(p.run);
  });

  await test(`${shell}: a changed bundle reinstalls with the same worker key`, async (context) => {
    const s = launcherScene(context, shell);
    const bundle = join(s.home, "bundle");
    cpSync(extension, bundle, { recursive: true });
    const p = await pairedLauncher(s, { extra: { RECNRUN_LAB_BUNDLE: bundle } });
    await launch(s, p);
    const first = provisioned(s);
    appendFileSync(join(bundle, "background.js"), "\n");
    assert.equal((await launch(s, p)).state, "delivering");
    const second = provisioned(s);
    assert.deepEqual([installs(s), workers(s), second.generation], [2, 2, "2"]);
    assert.notEqual(second.bundleDigest, first.bundleDigest);
    assert.equal(second.workerFp, first.workerFp);
    await stop(p.run);
  });

  await test(`${shell}: a changed allow list or master reinstalls`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    await launch(s, p);
    await stop(p.run);
    const allowed = await pairedLauncher(s, {
      args: ["--allow-any"],
      key: p.key,
      workspace: p.workspace,
    });
    await launch(s, allowed);
    assert.deepEqual([installs(s), provisioned(s).generation], [2, "2"]);
    await stop(allowed.run);
    for (const file of ["master.spki", "master.pem", "paired"]) rmSync(join(s.state, file));
    const next = await pairedLauncher(s, { args: ["--allow-any"], workspace: p.workspace });
    await launch(s, next);
    assert.deepEqual([installs(s), provisioned(s).masterFp], [3, next.key.fp]);
    await stop(next.run);
  });

  await test(`${shell}: an install that never answers is INSTALL_FAILED`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s, {
      extra: { STUB_REPLY: "silent", RECNRUN_LAB_INSTALL_S: "1" },
    });
    assert.equal((await launch(s, p)).code, "INSTALL_FAILED");
    assert.deepEqual(
      [holders(s), pids(s), existsSync(join(s.root, "provisioned"))],
      [[], [], false],
    );
    await stop(p.run);
  });

  await test(`${shell}: Ctrl-C during an install stops its Chrome`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s, {
      extra: { STUB_REPLY: "silent", RECNRUN_LAB_INSTALL_S: "20" },
    });
    await submit(s, p);
    await waitFor(() => pids(s).some((name) => name.startsWith("install.")));
    await stop(p.run);
    assert.deepEqual([holders(s), pids(s)], [[], []]);
    assert.ok(
      lines(join(s.home, "launches.txt")).includes("int"),
      "SIGINT ends the install Chrome",
    );
  });

  await test(`${shell}: a worker that ignores SIGINT is killed after the stop bound`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s, {
      extra: { STUB_WORKER_MODE: "stubborn", RECNRUN_LAB_STOP_S: "1" },
    });
    await launch(s, p);
    const [worker] = holders(s);
    await stop(p.run);
    assert.ok(!alive(worker));
    assert.ok(!existsSync(join(s.state, "stop-failed")));
  });

  await test(`${shell}: a recorded worker that became another program is never signalled`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s, { extra: { STUB_WORKER_MODE: "renamed" } });
    await launch(s, p);
    const [record] = pids(s);
    const pid = Number(record.split(".")[1]);
    context.after(() => alive(pid) && process.kill(pid, "SIGKILL"));
    await stop(p.run, EX_FAILED);
    assert.ok(alive(pid));
    assert.equal(fields(join(s.state, "stop-failed")).pids, String(pid));
  });

  await test(`${shell}: a foreign process naming the root is LAUNCH_FAILED and never signalled`, async (context) => {
    const s = launcherScene(context, shell);
    const p = await pairedLauncher(s);
    const foreign = spawn(
      "sh",
      ["-c", "sleep 600; :", "foreign", `--user-data-dir=${s.root}/chrome`],
      { detached: true, stdio: "ignore" },
    );
    context.after(() => alive(foreign.pid) && process.kill(-Number(foreign.pid), "SIGKILL"));
    await waitFor(() => holders(s).length === 1);
    assert.equal((await launch(s, p)).code, "LAUNCH_FAILED");
    await stop(p.run, EX_FAILED);
    assert.ok(alive(foreign.pid));
    assert.equal(fields(join(s.state, "stop-failed")).pids, String(foreign.pid));
  });
}
