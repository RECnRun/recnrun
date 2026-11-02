import { type ComponentChildren, render } from "preact";
import { expect } from "vite-plus/test";
import type { Locator } from "vite-plus/test/browser";
import type { Api } from "@/api/api";
import type { Params, PushMessage, PushType, Result, UiCommand } from "@/api/commands";
import { ApiProvider } from "@/api/context";
import { ApiError } from "@/api/error";
import type { CallOptions } from "@/api/http";

export type Handlers = {
  [C in UiCommand]?: (params: Params<C>) => Result<C> | Promise<Result<C>>;
};

type Recorded = { command: UiCommand; params: unknown; options?: CallOptions | undefined };

/** An Api that answers from `handlers`, records every call, and pushes messages on demand. */
export function fakeApi(handlers: Handlers) {
  const calls: Recorded[] = [];
  const listeners = new Map<PushType, Set<(message: unknown) => void>>();
  const api: Api = {
    call: async (command, params, options) => {
      calls.push({ command, params, options });
      const handler = handlers[command] as ((params: unknown) => unknown) | undefined;
      if (!handler) throw new ApiError("capability-unavailable", `No fake for ${command}.`);
      return handler(params) as never;
    },
    on: (type, handler) => {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(handler as (message: unknown) => void);
      return () => set.delete(handler as (message: unknown) => void);
    },
  };
  const emit = <T extends PushType>(type: T, message: PushMessage<T>) =>
    listeners.get(type)?.forEach((listener) => listener(message));
  const paramsOf = (command: UiCommand) =>
    calls.filter((call) => call.command === command).map((call) => call.params);
  return { api, calls, emit, paramsOf, handlers };
}

/** Renders `ui` alone in the document with `api` provided. */
export function renderWith(api: Api, ui: ComponentChildren): HTMLElement {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  render(<ApiProvider api={api}>{ui}</ApiProvider>, root);
  return root;
}

export const REVISION = "a".repeat(64);
export const NOW = "2026-11-02T10:00:00.000Z";

/** Waits until `locator` contains every text, in any order. */
export async function expectTexts(locator: Locator, ...texts: string[]) {
  for (const text of texts) {
    await expect.poll(() => locator.query()?.textContent ?? "").toContain(text);
  }
}
