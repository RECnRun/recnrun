import { vi } from "vite-plus/test";
import type { LayoutApi } from "@/background/workspace/layout-restore";

/**
 * Windows and tabs as a start reopens them: each call is logged in order, windows are numbered
 * from 50 with their first tab ten times that, and opened tabs from 200.
 */
export function fakeLayoutApi() {
  const calls: string[] = [];
  let windows = 0;
  let tabs = 0;
  const api = {
    calls,
    openWindow: vi.fn(async () => {
      const windowId = 50 + windows;
      windows += 1;
      calls.push(`window ${windowId}`);
      return { windowId, tabId: windowId * 10 };
    }),
    openTab: vi.fn(async (windowId: number, index: number) => {
      const tabId = 200 + tabs;
      tabs += 1;
      calls.push(`tab ${tabId} in ${windowId} at ${index}`);
      return tabId;
    }),
    navigate: vi.fn(async (tabId: number, url: string) => {
      calls.push(`navigate ${tabId} ${url}`);
    }),
    activate: vi.fn(async (tabId: number) => {
      calls.push(`activate ${tabId}`);
    }),
    focus: vi.fn(async (windowId: number) => {
      calls.push(`focus ${windowId}`);
    }),
  };
  return api satisfies LayoutApi;
}
