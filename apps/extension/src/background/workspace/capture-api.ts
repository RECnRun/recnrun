import { browser } from "wxt/browser";
import { isExpectedAgent } from "@/background/workspace/agent-link";
import type { AgentExpectation } from "@/background/workspace/agent-link";
import { AGENT_SCRIPT } from "@/background/workspace/barrier";
import { WorkspaceError } from "@/background/workspace/errors";
import { isHelperTab } from "@/background/workspace/helper-tab";
import { inventory } from "@/background/workspace/windows";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";

interface ConnectEvent {
  addListener: (listener: (port: OriginPort) => void) => void;
  removeListener: (listener: (port: OriginPort) => void) => void;
}

/** One Incognito window of the session, its tabs in order, RECnRun's helper tabs left out. */
export interface SessionWindow {
  id: number;
  focused: boolean;
  tabs: { id: number; active: boolean }[];
}

/** What a capture needs from Chrome: the windows, a tab's top document, the agent's injection, its port. */
export interface CaptureApi {
  windows: () => Promise<SessionWindow[]>;
  topFrame: (tabId: number) => Promise<{ url: string; documentId: string } | null>;
  inject: (tabId: number, documentId: string) => Promise<void>;
  onConnect: ConnectEvent;
}

/** Injects the agent into the expected document only and waits for its link; nothing stays registered. */
export function connectAgent(
  api: CaptureApi,
  expected: AgentExpectation,
  boundMs: number,
): Promise<OriginPort> {
  return new Promise((resolve, reject) => {
    const end = (finish: () => void) => {
      clearTimeout(timer);
      api.onConnect.removeListener(onConnect);
      finish();
    };
    const fail = () =>
      end(() =>
        reject(new WorkspaceError("AgentNotConnected", "The page did not open its link in time.")),
      );
    const onConnect = (port: OriginPort) => {
      if (port.name !== ORIGIN_AGENT_PORT) return;
      if (isExpectedAgent(port, expected)) end(() => resolve(port));
      else port.disconnect();
    };
    const timer = setTimeout(fail, boundMs);
    api.onConnect.addListener(onConnect);
    api.inject(expected.tabId, expected.documentId).catch(fail);
  });
}

/** Chrome's APIs; the getter reaches `runtime.onConnect` only when a capture runs. */
export const chromeCaptureApi: CaptureApi = {
  windows: async () =>
    (await inventory()).map(({ id, focused, tabs = [] }) => ({
      id,
      focused,
      tabs: [...tabs]
        .sort((one, other) => one.index - other.index)
        .flatMap(({ id: tabId, active }) =>
          tabId === undefined || isHelperTab(tabId) ? [] : [{ id: tabId, active }],
        ),
    })),
  topFrame: async (tabId) => {
    const frame = await browser.webNavigation.getFrame({ tabId, frameId: 0 });
    return frame ? { url: frame.url, documentId: frame.documentId } : null;
  },
  inject: async (tabId, documentId) => {
    await browser.scripting.executeScript({
      target: { tabId, documentIds: [documentId] },
      files: [`/${AGENT_SCRIPT}` as const],
    });
  },
  get onConnect() {
    return browser.runtime.onConnect;
  },
};
