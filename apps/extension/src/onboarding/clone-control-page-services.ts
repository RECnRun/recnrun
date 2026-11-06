import * as v from "valibot";
import { browser } from "wxt/browser";
import { createCloneControl } from "@/onboarding/clone-control-service";
import type { CloneControl } from "@/onboarding/clone-control-service";
import { readText } from "@/onboarding/page-services";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import {
  DEFAULT_NAMESPACE,
  NamespaceSchema,
  clonesStatePath,
  controlPath,
} from "@/p2p/downloads-rendezvous";
import { storedRoles } from "@/storage/hierarchy-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

/** Clone control in the dashboard of a POC build: the master's files, read and written by message. */
export function cloneControlServices(): CloneControl {
  const presence = pocPresenceStore();
  const roles = storedRoles();
  return createCloneControl({
    readTexts: async (requestId) => {
      const root = await presence.root.read();
      if (root === null) return {};
      const stored = await presence.namespace();
      const namespace = v.is(NamespaceSchema, stored) ? stored : DEFAULT_NAMESPACE;
      const [clones, status] = await Promise.all([
        readText(`${root}/${clonesStatePath(namespace)}`),
        requestId === undefined
          ? undefined
          : readText(`${root}/${controlPath(namespace, requestId, "status.json")}`),
      ]);
      return { clones, status };
    },
    send: async (message) => {
      const reply = v.parse(BackgroundReplySchema, await browser.runtime.sendMessage(message));
      if (!reply.ok) throw new Error(reply.error);
    },
    master: async () => (await roles.record())?.role === "master",
    newId: () => crypto.randomUUID(),
    every: (run, ms) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
}
