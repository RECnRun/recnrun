import { describe, expect, test } from "vite-plus/test";
import { banner, START_COMMAND } from "./site/owner-state.js";
import type { OwnerState } from "./site/owner-state.js";

const heartbeat = (fields: Record<string, string> = {}) => ({
  session: "0123456789abcdef",
  seq: 1,
  at: 1,
  state: "idle",
  paired: "a".repeat(64),
  launcher: "1",
  extension: "1.0.0",
  ...fields,
});

const OK: OwnerState = {
  handle: true,
  permission: "granted",
  folder: "ok",
  marker: "ok",
  heartbeat: heartbeat(),
  stale: false,
  masterFp: "a".repeat(64),
  workerMismatch: false,
  reconnect: false,
};
const id = (patch: Partial<OwnerState>) => banner({ ...OK, ...patch }).id;
const withBeat = (fields: Record<string, string>) => ({ ...OK, heartbeat: heartbeat(fields) });

describe("banner", () => {
  test("every banner is reachable and carries its action", () => {
    expect(banner({ ...OK, handle: false })).toMatchObject({ id: "no-handle", action: "choose" });
    expect(banner({ ...OK, permission: "prompt" })).toMatchObject({
      id: "permission-prompt",
      action: "renew",
    });
    expect(banner({ ...OK, permission: "denied" })).toMatchObject({
      id: "permission-denied",
      action: "choose",
    });
    expect(banner({ ...OK, folder: "missing" })).toMatchObject({
      id: "folder-missing",
      action: "choose",
    });
    expect(banner({ ...OK, marker: "missing" })).toMatchObject({
      id: "not-a-folder",
      action: "choose",
    });
    expect(banner({ ...OK, heartbeat: null })).toMatchObject({
      id: "launcher",
      command: START_COMMAND,
    });
    expect(banner(withBeat({ paired: "rejected" }))).toMatchObject({
      id: "pairing-rejected",
      action: "pair",
    });
    expect(banner(withBeat({ paired: "none" }))).toMatchObject({ id: "confirm" });
    expect(banner(withBeat({ paired: "b".repeat(64) }))).toMatchObject({
      id: "key-changed",
      action: "pair",
    });
    expect(banner(withBeat({ state: "launching" }))).toMatchObject({
      id: "busy",
      busy: "launching",
    });
    expect(banner(OK)).toMatchObject({ id: "ready", reconnect: false });
  });

  test("the start command allows any http(s) origin", () => {
    expect(START_COMMAND).toContain("launcher.sh start");
    expect(START_COMMAND).toContain("--allow-any");
  });

  test("denied is told apart from prompt", () => {
    expect(id({ permission: "prompt" })).not.toBe(id({ permission: "denied" }));
  });

  test("the folder checks rank above the launcher checks, in order", () => {
    const broken: Partial<OwnerState> = {
      handle: false,
      permission: "denied",
      folder: "missing",
      marker: "missing",
      heartbeat: null,
    };
    expect(id(broken)).toBe("no-handle");
    expect(id({ ...broken, handle: true })).toBe("permission-denied");
    expect(id({ ...broken, handle: true, permission: "granted" })).toBe("folder-missing");
    const found = { handle: true, permission: "granted", folder: "ok" } as const;
    expect(id({ ...broken, ...found })).toBe("not-a-folder");
    expect(id({ ...broken, ...found, marker: "ok" })).toBe("launcher");
  });

  test("a stale heartbeat reads as the launcher not running", () => {
    expect(id({ stale: true })).toBe("launcher");
  });

  test("trust failures rank above busy states", () => {
    expect(banner(withBeat({ state: "installing", paired: "b".repeat(64) })).id).toBe(
      "key-changed",
    );
    expect(id({ heartbeat: heartbeat({ state: "installing" }), workerMismatch: true })).toBe(
      "worker-changed",
    );
  });

  test("pairing in progress shows the master fingerprint to confirm", () => {
    const shown = banner(withBeat({ state: "pairing", paired: "none" }));
    expect(shown.id).toBe("confirm");
    expect(shown.fingerprints?.master).toBe("aaaa aaaa aaaa aaaa aaaa");
    expect(banner(withBeat({ state: "pairing", paired: "b".repeat(64) })).id).toBe("confirm");
  });

  test("a session change offers Reconnect on the ready banner", () => {
    expect(banner({ ...OK, reconnect: true })).toMatchObject({ id: "ready", reconnect: true });
  });
});
