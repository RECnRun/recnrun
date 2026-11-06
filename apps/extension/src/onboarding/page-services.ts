import { browser } from "wxt/browser";
import { createOnboarding } from "@/onboarding/service";
import type { Onboarding } from "@/onboarding/service";
import { BackgroundReplySchema } from "@/messaging/background-reply";
import {
  DEFAULT_NAMESPACE,
  NamespaceSchema,
  fileUrlFor,
  operationPath,
  registryPath,
} from "@/p2p/downloads-rendezvous";
import { POC_READ_FILE, toReadResult } from "@/p2p/file-url-read";
import { storedRoles } from "@/storage/hierarchy-repository";
import { pocOnboardingStore } from "@/storage/poc-onboarding-repository";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import * as v from "valibot";

/** Reads a file:// URL through the background and the offscreen document, which hold the access. */
export async function readText(path: string): Promise<string | undefined> {
  const answer = await browser.runtime.sendMessage({
    type: POC_READ_FILE,
    url: fileUrlFor(path),
    cache: "no-store",
  });
  const result = toReadResult(answer, "The background");
  return result.ok ? result.text : undefined;
}

/** "Prepare workers" in the dashboard of a POC build: the master's files, read and written by message. */
export function onboardingServices(): Onboarding {
  const presence = pocPresenceStore();
  const onboarding = pocOnboardingStore();
  const roles = storedRoles();
  return createOnboarding({
    store: onboarding.operation,
    readTexts: async (operationId) => {
      const root = await presence.root.read();
      if (root === null) return {};
      const stored = await presence.namespace();
      const namespace = v.is(NamespaceSchema, stored) ? stored : DEFAULT_NAMESPACE;
      const [registry, status] = await Promise.all([
        readText(`${root}/${registryPath(namespace)}`),
        operationId === undefined
          ? undefined
          : readText(`${root}/${operationPath(namespace, operationId, "status.json")}`),
      ]);
      return { registry, status };
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
