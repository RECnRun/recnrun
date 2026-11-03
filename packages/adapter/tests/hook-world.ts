import { OBSERVER_BINDING } from "@recnrun/protocol";
import { createContext, runInContext } from "node:vm";
import { expect } from "vite-plus/test";
import { hookSource } from "../src/hook-source.ts";

type Listener = (event: Record<string, unknown>) => void;

export interface Page {
  window: Record<string, unknown>;
  posted: unknown[];
  run: () => void;
  navigate: (url: string) => void;
  /** Dispatches a fake event to the hook's capture-phase listener for its type. */
  dispatch: (event: Record<string, unknown>) => void;
}

// A minimal main world: window, document, location, performance, crypto, timers, and listeners.
export function page(url: string, withBinding = true): Page {
  const posted: unknown[] = [];
  const listeners = new Map<string, Listener>();
  const window: Record<string, unknown> = {
    document: {},
    location: { href: url },
    performance,
    crypto,
    setTimeout,
    clearTimeout,
    scrollX: 0,
    scrollY: 0,
    getSelection: () => "",
    addEventListener: (type: string, listener: Listener, options: unknown) => {
      expect(options).toEqual({ capture: true, passive: true });
      listeners.set(type, listener);
    },
  };
  window.window = window;
  if (withBinding) window[OBSERVER_BINDING] = (message: string) => posted.push(JSON.parse(message));
  const context = createContext(window);
  return {
    window: context,
    posted,
    run: () => runInContext(hookSource("T1"), context),
    navigate: (next) => {
      context.document = {};
      context.location = { href: next };
    },
    dispatch: (event) => listeners.get(String(event.type))?.(event),
  };
}

export const hookOf = (target: Page) =>
  runInContext("window.__recnrunHook", target.window) as {
    version: number;
    documentId: string;
    installedAt: number;
  };
