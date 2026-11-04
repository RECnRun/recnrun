import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { ask } from "@/diagnostics/poc-messages";
import { pocLauncherAck, pocPublishPresence } from "@/messaging/poc-presence";
import { pocPresenceStore } from "@/storage/poc-presence-repository";

/*
 * P2.1 (POC PLAN.md decision 11): the launcher opens chrome-extension://<id>/bootstrap.html#token=<uuid>
 * on a profile; the page makes the token this session's boot and asks for a presence now, so the
 * launcher finds the Downloads root holding a presence with that boot. P4.3: it then asks for the
 * ack of the attempt, the launcher's proof that this open reached the profile.
 */

// Lowercase v4, as catalog.sh requires of a boot; nothing else may follow it.
const FragmentSchema = v.pipe(
  v.string(),
  v.regex(/^#token=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const PREFIX = "#token=";

export interface BootstrapDependencies {
  /** `location.hash` of the page, as the launcher opened it. */
  hash: string;
  /** Keeps the token as this browser session's boot, unless the session already has one from an attempt. */
  adopt: (token: string) => Promise<void>;
  send: (message: unknown) => Promise<unknown>;
}

/** `acked` tells whether the ack of the attempt was written; a failed one keeps the presence's `ok`. */
export type BootstrapResult =
  | { ok: true; token: string; acked: true }
  | { ok: true; token: string; acked: false; error: string }
  | { ok: false; error: string };

export async function bootstrap({
  hash,
  adopt,
  send,
}: BootstrapDependencies): Promise<BootstrapResult> {
  const parsed = v.safeParse(FragmentSchema, hash);
  if (!parsed.success)
    return { ok: false, error: "The address carries no #token=<lowercase v4 uuid>." };
  const token = parsed.output.slice(PREFIX.length);
  try {
    await adopt(token);
    const reply = await ask(send, pocPublishPresence());
    if (!reply.ok) return { ok: false, error: reply.error };
    const ack = await ask(send, pocLauncherAck(token));
    return ack.ok
      ? { ok: true, token, acked: true }
      : { ok: true, token, acked: false, error: ack.error };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Runs the bootstrap of this page and shows its result in `<pre id="bootstrap">`. */
export async function startBootstrap(page: Window & typeof globalThis = window): Promise<void> {
  const result = await bootstrap({
    hash: page.location.hash,
    adopt: pocPresenceStore().adoptBoot,
    send: (message) => browser.runtime.sendMessage(message),
  });
  const target = page.document.getElementById("bootstrap");
  if (target) target.textContent = JSON.stringify(result);
}
