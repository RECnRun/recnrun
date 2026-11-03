import { INSTRUMENTED_TARGET_TYPES, OBSERVER_BINDING, type InstallMode } from "@recnrun/protocol";
import { hookSource } from "./hook-source.ts";

export type InstrumentedType = (typeof INSTRUMENTED_TARGET_TYPES)[number];

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
}

export const AUTO_ATTACH: CdpCommand = {
  method: "Target.setAutoAttach",
  params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
};

export const RESUME: CdpCommand = { method: "Runtime.runIfWaitingForDebugger" };

const RUNTIME: CdpCommand = { method: "Runtime.enable" };
const BINDING: CdpCommand = { method: "Runtime.addBinding", params: { name: OBSERVER_BINDING } };
// Raw capture adds the network, the browser log, and Web Storage events of every document target.
const CAPTURE: CdpCommand[] = [
  { method: "Network.enable" },
  { method: "Log.enable" },
  { method: "DOMStorage.enable" },
];

export function isInstrumented(type: string): type is InstrumentedType {
  return (INSTRUMENTED_TARGET_TYPES as readonly string[]).includes(type);
}

function documentCommands(targetId: string): CdpCommand[] {
  // `runImmediately` hooks a document that already has a script context: a running page, or a
  // popup's about:blank whose context Chrome hands on to the popup's first same-origin document.
  const script: CdpCommand = {
    method: "Page.addScriptToEvaluateOnNewDocument",
    params: { source: hookSource(targetId), runImmediately: true },
  };
  return [AUTO_ATTACH, { method: "Page.enable" }, script, RUNTIME, BINDING];
}

/** The commands, in order, that instrument one attached target; only a held target is resumed. */
export function installCommands(
  type: InstrumentedType,
  targetId: string,
  mode: InstallMode,
  capture = false,
): CdpCommand[] {
  let commands: CdpCommand[];
  if (type === "page" || type === "iframe")
    commands = [...documentCommands(targetId), ...(capture ? CAPTURE : [])];
  // A dedicated worker can start nested workers; a service worker cannot.
  else if (type === "worker") commands = [AUTO_ATTACH, RUNTIME, BINDING];
  else commands = [RUNTIME, BINDING];
  return mode === "before-first-script" ? [...commands, RESUME] : commands;
}
