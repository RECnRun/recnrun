import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { INITIAL, OperationSchema, reduce, view } from "@/onboarding/state";
import type {
  OnboardingEvent,
  OnboardingState,
  OnboardingView,
  Operation,
} from "@/onboarding/state";
import { readStatus } from "@/p2p/prepare";
import { readRegistry } from "@/p2p/registry";

export const POLL_MS = 5000;
const BASE_NAME = "base-v1";

type Texts = { status?: string; registry?: string };

/** What the service needs from the extension, injected so Node tests need no browser. */
export interface OnboardingPorts {
  store: {
    read: () => Promise<Operation | undefined>;
    write: (operation: Operation) => Promise<void>;
  };
  /** The text of the operation's status.json and of registry.json; undefined when unreadable. */
  readTexts: (operationId: string | undefined) => Promise<Texts>;
  /** Asks the background to write the request or the retry; rejects with the reason. */
  send: (message: unknown) => Promise<void>;
  /** Whether this profile is the master, the only role that prepares workers. */
  master: () => Promise<boolean>;
  newId: () => string;
  every: (run: () => void, ms: number) => () => void;
  now?: () => number;
}

export interface OnboardingSnapshot extends OnboardingView {
  operation?: Operation;
  /** Why the last Prepare or Retry could not be written, if it could not. */
  failure: string;
}

type Listener = (snapshot: OnboardingSnapshot) => void;

export interface Onboarding {
  isMaster: () => Promise<boolean>;
  /** Calls `listener` on every change and keeps the files polled until the returned stop. */
  watch: (listener: Listener) => () => void;
  request: (basesDir: string, clones: number) => Promise<void>;
  retry: () => Promise<void>;
}

/** The folded state and who listens to it. */
function createCore() {
  let state: OnboardingState = INITIAL;
  let failure = "";
  const listeners = new Set<Listener>();
  const snapshot = (): OnboardingSnapshot => ({
    ...view(state),
    operation: state.operation,
    failure,
  });
  const emit = () => listeners.forEach((listener) => listener(snapshot()));
  return {
    listeners,
    snapshot,
    emit,
    state: () => state,
    fail: (message: string) => {
      failure = message;
      emit();
    },
    clearFailure: () => {
      failure = "";
    },
    apply: (event: OnboardingEvent) => {
      const next = reduce(state, event);
      if (next === state) return;
      state = next;
      emit();
    },
  };
}

type Core = ReturnType<typeof createCore>;

async function refresh(core: Core, ports: OnboardingPorts): Promise<void> {
  const texts = await ports.readTexts(core.state().operation?.operationId).catch((): Texts => ({}));
  const registry = readRegistry(texts.registry, undefined, (ports.now ?? Date.now)()).publication;
  if (registry) {
    const peers = Object.values(registry.peers).map((peer) => [
      peer.profileId,
      { boot: peer.boot },
    ]);
    core.apply({ type: "registry", peers: Object.fromEntries(peers) });
  }
  const status = readStatus(texts.status);
  if (status) core.apply({ type: "status", status });
}

async function ask(core: Core, ports: OnboardingPorts, message: unknown): Promise<boolean> {
  try {
    await ports.send(message);
    core.clearFailure();
    return true;
  } catch (error) {
    core.fail(errorMessage(error));
    return false;
  }
}

export function createOnboarding(ports: OnboardingPorts): Onboarding {
  const core = createCore();
  let stopPolling: (() => void) | undefined;
  const stop = () => {
    stopPolling?.();
    stopPolling = undefined;
  };
  const tick = () => refresh(core, ports).then(() => view(core.state()).phase === "done" && stop());
  const poll = () => {
    stopPolling ??= ports.every(() => void tick(), POLL_MS);
  };
  async function start(): Promise<void> {
    const stored = await ports.store.read().catch(() => undefined);
    if (stored && !core.state().operation) core.apply({ type: "requested", operation: stored });
    core.emit();
    await refresh(core, ports);
    if (view(core.state()).phase !== "done") poll();
  }
  return {
    isMaster: () => ports.master().catch(() => false),
    watch: (listener) => {
      core.listeners.add(listener);
      if (core.listeners.size === 1) void start();
      else listener(core.snapshot());
      return () => {
        core.listeners.delete(listener);
        if (core.listeners.size === 0) stop();
      };
    },
    request: async (basesDir, clones) => {
      const choice = v.safeParse(OperationSchema, {
        operationId: ports.newId(),
        basesDir,
        baseName: BASE_NAME,
        clones,
      });
      if (!choice.success) return core.fail(choice.issues[0].message);
      const message = { type: "POC_PREPARE_WORKERS", op: "request", choice: choice.output };
      if (!(await ask(core, ports, message))) return;
      await ports.store.write(choice.output);
      core.apply({ type: "requested", operation: choice.output });
      poll();
    },
    retry: async () => {
      const id = core.state().operation?.operationId;
      const message = { type: "POC_PREPARE_WORKERS", op: "retry", operationId: id };
      if (id && (await ask(core, ports, message))) core.apply({ type: "retry" });
    },
  };
}
