import type { Flow, Step, Target } from "@recnrun/protocol";
import type {
  ActResult,
  Clock,
  DriverCommand,
  ElementState,
  ReplayDriver,
  TabList,
} from "../src/index.ts";

/** A deep copy; the engine compiles without DOM or Node types, so no `structuredClone`. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const START = Date.parse("2026-11-02T10:00:00.000Z");

/** A clock whose `sleep` advances `now` at once, so polling to a deadline takes no real time. */
export function fakeClock(start = START): Clock & { sleeps: number[] } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

export function flowOf(steps: Step[], extra: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    id: "replay",
    name: "Replay",
    actors: {},
    inputs: {},
    requirements: [],
    preconditions: [],
    steps,
    ...extra,
  };
}

/** A test id, or the JSON of any other target, names a fake element. */
function keyOf(target: Target): string {
  if (typeof target === "object" && !Array.isArray(target) && "testId" in target) {
    return String(target.testId);
  }
  return JSON.stringify(target);
}

/** An element's state on its nth read (from 1); a function lets a test change it over time. */
export type ElementSpec = Partial<ElementState> | ((read: number) => Partial<ElementState>);

export interface FakePage {
  elements?: Record<string, ElementSpec>;
  attributes?: Record<string, Record<string, string | null>>;
  tabs?: TabList;
  /** Answers each write; the default applies tab commands and returns `done`. */
  act?: (command: DriverCommand) => ActResult | Promise<ActResult>;
}

const PRESENT: ElementState = {
  count: 1,
  visible: true,
  enabled: true,
  editable: true,
  text: "",
  value: null,
};

const ABSENT: ElementState = { ...PRESENT, count: 0, visible: false, enabled: false };

function applyTabs(list: TabList, command: DriverCommand): void {
  const current = list.current ?? 0;
  if (command.kind === "navigate") list.tabs[current] = { url: command.url, title: "" };
  if (command.kind === "openTab") {
    list.tabs.push({ url: command.url ?? "about:blank", title: "" });
    list.current = list.tabs.length - 1;
  }
  if (command.kind === "selectTab") list.current = command.index;
  if (command.kind === "closeTab") {
    list.tabs.splice(current, 1);
    list.current = list.tabs.length > 0 ? list.tabs.length - 1 : null;
  }
}

/** A driver over a scripted page that logs every call, reads and writes alike. */
export function fakeDriver(page: FakePage = {}) {
  const calls: string[] = [];
  const commands: DriverCommand[] = [];
  const timeouts: number[] = [];
  const reads = new Map<string, number>();
  const list: TabList = page.tabs ?? { tabs: [{ url: "about:blank", title: "" }], current: 0 };
  const driver: ReplayDriver = {
    async inspect(target, options) {
      const key = keyOf(target);
      const read = (reads.get(key) ?? 0) + 1;
      reads.set(key, read);
      calls.push(`inspect ${key}`);
      timeouts.push(options.timeoutMs);
      const spec = page.elements?.[key];
      if (spec === undefined) return ABSENT;
      return { ...PRESENT, ...(typeof spec === "function" ? spec(read) : spec) };
    },
    async readAttribute(target, name) {
      calls.push(`attribute ${keyOf(target)} ${name}`);
      return page.attributes?.[keyOf(target)]?.[name] ?? null;
    },
    async tabs() {
      calls.push("tabs");
      return clone(list);
    },
    async act(command, options) {
      calls.push(`act ${command.kind}`);
      commands.push(command);
      timeouts.push(options.timeoutMs);
      if (page.act) return page.act(command);
      applyTabs(list, command);
      return { status: "done" };
    },
  };
  return { driver, calls, commands, timeouts, list };
}

export const actsOf = (calls: readonly string[]) => calls.filter((call) => call.startsWith("act "));
