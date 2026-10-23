import type { RequestResult, RequestType } from "@recnrun/bridge";
import * as v from "valibot";
import { BackgroundRequestSchema } from "@/messaging/background-protocol";
import type { BackgroundReply } from "@/messaging/background-protocol";

interface HandlerDependencies {
  extensionVersion: string;
}

type Handler = (type: RequestType) => Promise<RequestResult<RequestType>>;

export function createRequestHandler({ extensionVersion }: HandlerDependencies): Handler {
  return async (type) => {
    switch (type) {
      case "ping":
        return { extensionVersion };
    }
  };
}

/**
 * Builds the runtime.onMessage listener. It answers only this extension's own
 * scripts and replies through sendResponse, which every Chromium version supports.
 */
export function createMessageListener(handle: Handler, extensionId: string) {
  return (
    message: unknown,
    sender: { id?: string },
    sendResponse: (reply: BackgroundReply) => void,
  ) => {
    const request = v.safeParse(BackgroundRequestSchema, message);
    if (sender.id !== extensionId || !request.success) return false;
    handle(request.output.type).then(
      (result) => sendResponse({ ok: true, result }),
      (error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  };
}
