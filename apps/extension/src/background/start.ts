import { browser } from "wxt/browser";
import { createBrowserAdapter, toTabInfo } from "@/background/browser-adapter";
import {
  createExternalListener,
  createMessageListener,
  createRequestHandler,
} from "@/background/handler";
import { createTimelinePorts } from "@/background/timeline-ports";
import { createWorkflowController } from "@/background/workflows";
import { externalMatches } from "@/config/origins";
import { openWorkflowStore } from "@/storage/workflow-store";

function background(work: Promise<unknown>): void {
  work.catch((error: unknown) => console.error(error));
}

export function startBackground(): void {
  const store = openWorkflowStore();
  const ports = createTimelinePorts();
  const controller = createWorkflowController({
    browser: createBrowserAdapter(),
    store,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    notify: ports.notify,
  });
  const dispatch = createRequestHandler({
    extensionVersion: browser.runtime.getManifest().version,
    controller,
    store,
  });

  browser.runtime.onMessage.addListener(
    createMessageListener(dispatch, controller.recordStep, browser.runtime.id),
  );
  browser.runtime.onMessageExternal.addListener(
    createExternalListener(dispatch, externalMatches(import.meta.env.MODE)),
  );
  browser.runtime.onConnect.addListener(ports.accept);
  browser.runtime.onInstalled.addListener(() => background(controller.sync()));
  browser.runtime.onStartup.addListener(() => background(controller.sync()));
  browser.tabs.onUpdated.addListener((_tabId, change, tab) => {
    const info = toTabInfo(tab);
    if (info) background(controller.onTabUpdated(change, info));
  });
  browser.tabGroups.onRemoved.addListener((group) =>
    background(controller.onGroupRemoved(group.id)),
  );
}
