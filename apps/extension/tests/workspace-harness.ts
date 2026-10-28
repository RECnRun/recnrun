import * as v from "valibot";
import { vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import { createWorkspaceCommands } from "@/background/workspace/commands";
import { BackgroundReplySchema } from "@/messaging/background-messages";
import { WorkspaceStatusSchema } from "@/messaging/workspace-protocol";
import type { RecordingStore } from "@/ports/recording-store";
import { memoryRecordingStore } from "./fake-extension";

const EXTENSION_URL = "chrome-extension://own-id/";
const identity = { extensionId: "own-id", extensionUrl: EXTENSION_URL };
const ownPage = { id: "own-id", url: `${EXTENSION_URL}dashboard.html` };
export const contentScript = { id: "own-id", url: "https://recnrun.com/" };
export const TARGET = "https://app.example/";

export type Send = (message: unknown, sender?: object) => Promise<unknown>;

/** Delivers messages to one background, as Chrome would, and resolves with the validated reply. */
export function workspaceBackground(store: RecordingStore = memoryRecordingStore()): Send {
  const routes = createRoutes({
    extensionVersion: "0.1.0",
    store,
    workspace: createWorkspaceCommands(),
  });
  const listener = createBackgroundListener(routes, identity);
  return (message, sender = ownPage) =>
    new Promise<unknown>((resolve, reject) => {
      const answered = listener(message, sender as never, (reply) =>
        resolve(v.parse(BackgroundReplySchema, reply)),
      );
      if (!answered) reject(new Error("No answer"));
    });
}

/** Chrome's "Allow in Incognito" toggle; the spy takes the callback overload's type. */
export function allowIncognito(allowed: boolean) {
  vi.spyOn(fakeBrowser.extension, "isAllowedIncognitoAccess").mockResolvedValue(allowed as never);
}

export async function readStatus(send: Send) {
  const reply = v.parse(BackgroundReplySchema, await send({ type: "workspace-status" }));
  if (!reply.ok) throw new Error(reply.error);
  return v.parse(WorkspaceStatusSchema, reply.result);
}

export const busyReply = {
  ok: false,
  error: "RECnRun is busy with another Incognito workspace operation.",
};

/** Holds the next tabs.update until the returned function runs, so an operation stays in flight. */
export function holdNextNavigation(): () => void {
  let finish = () => {};
  const navigation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(fakeBrowser.tabs, "update").mockReturnValueOnce(navigation as never);
  return finish;
}
