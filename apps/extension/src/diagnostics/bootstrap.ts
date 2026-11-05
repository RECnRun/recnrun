import { errorMessage } from "@recnrun/domain";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { ask } from "@/diagnostics/poc-messages";
import { CLONE_PREFIX, cloneRequestOf } from "@/messaging/clone-fragment";
import {
  pocLauncherAck,
  pocLauncherFailure,
  pocProvisionClone,
  pocPublishPresence,
} from "@/messaging/poc-presence";
import type { BootstrapStep } from "@/messaging/poc-presence";
import { bounded } from "@/p2p/bounded";
import { pocPresenceStore } from "@/storage/poc-presence-repository";
import { pocTemplateStore } from "@/storage/poc-template-repository";

/*
 * P2.1 (POC PLAN.md decision 11): the launcher opens chrome-extension://<id>/bootstrap.html#token=<uuid>
 * on a profile; the page makes the token this session's boot and asks for a presence now, so the
 * launcher finds the Downloads root holding a presence with that boot. P4.3: it then asks for the
 * ack of the attempt, the launcher's proof that this open reached the profile.
 * P5.1: a base is opened with #template=<uuid>&setting=base-v<n> instead; the page records template
 * mode and the setting, adopts no boot, asks for no presence, and acks with both fields.
 * P5.3: a copy of a base is opened with #clone=<token>&instance=<uuid>&operation=<uuid>&
 * namespace=<namespace>&master=<profile id>.<identity key>, in exactly that order; the page stores
 * nothing and hands exactly those fields to its worker, which provisions, acks, and announces.
 */

// Lowercase v4, as catalog.sh requires of a boot; nothing else may follow it.
const FragmentSchema = v.pipe(
  v.string(),
  v.regex(/^#token=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const PREFIX = "#token=";
const TemplateFragmentSchema = v.pipe(
  v.string(),
  v.regex(
    /^#template=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}&setting=base-v[0-9]+$/,
  ),
);
const TEMPLATE_PREFIX = "#template=";
const SETTING_KEY = "&setting=";
const CLONE_REFUSED =
  "The address carries no #clone=<token>&instance=<uuid>&operation=<uuid>&namespace=<namespace>&master=<profile id>.<identity key>.";

/** How long each step of a token bootstrap may take; open.sh waits 60 s by default for the ack. */
export interface BootstrapLimits {
  adoptMs: number;
  /** For each of the two tries of the presence. */
  publishMs: number;
  ackMs: number;
  failureMs: number;
}
const LIMITS: BootstrapLimits = {
  adoptMs: 5_000,
  publishMs: 10_000,
  ackMs: 8_000,
  failureMs: 8_000,
};

export interface BootstrapDependencies {
  /** `location.hash` of the page, as the launcher opened it. */
  hash: string;
  /** Keeps the token as this browser session's boot, unless the session already has one from an attempt. */
  adopt: (token: string) => Promise<void>;
  /** Stores template mode and the base's setting. */
  enterTemplate: (setting: string) => Promise<void>;
  send: (message: unknown) => Promise<unknown>;
  /** Replaces the default bounds of the token steps. */
  limits?: BootstrapLimits;
}

/** `acked` tells whether the ack of the attempt was written; a failed one keeps the presence's `ok`. */
export type BootstrapResult =
  | { ok: true; token: string; acked: true }
  | { ok: true; token: string; acked: false; error: string }
  | { ok: true; token: string; template: true; setting: string; acked: true }
  | { ok: true; token: string; template: true; setting: string; acked: false; error: string }
  | {
      ok: true;
      token: string;
      clone: true;
      instanceId: string;
      operationId: string;
      acked: true;
    }
  | { ok: false; error: string };

/** The template open of a base: the mode is stored first, so the ack never precedes it. */
async function bootstrapTemplate(
  hash: string,
  { enterTemplate, send }: BootstrapDependencies,
): Promise<BootstrapResult> {
  const body = hash.slice(TEMPLATE_PREFIX.length);
  const [token = "", setting = ""] = body.split(SETTING_KEY);
  try {
    await enterTemplate(setting);
    const ack = await ask(send, pocLauncherAck(token, { template: true, setting }));
    const found = { ok: true, token, template: true, setting } as const;
    return ack.ok ? { ...found, acked: true } : { ...found, acked: false, error: ack.error };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** The clone open of a copied base: its worker provisions and acks, or says why it refused. */
async function bootstrapClone(
  hash: string,
  send: BootstrapDependencies["send"],
): Promise<BootstrapResult> {
  const request = cloneRequestOf(hash);
  if (!request) return { ok: false, error: CLONE_REFUSED };
  try {
    const reply = await ask(send, pocProvisionClone(request));
    if (!reply.ok) return { ok: false, error: reply.error };
    const { token, instanceId, operationId } = request;
    return { ok: true, token, clone: true, instanceId, operationId, acked: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Tells the launcher, through a failure ack, where the bootstrap stopped; a dead background changes nothing. */
async function reportFailure(
  send: BootstrapDependencies["send"],
  failure: { token: string; step: BootstrapStep; error: string; ms: number },
): Promise<void> {
  const { token, step, error, ms } = failure;
  await bounded(ask(send, pocLauncherFailure(token, step, error)), ms, "The failure report").catch(
    () => undefined,
  );
}

/** Asks for a presence; one stall or refusal is retried once, since the background then recreates its offscreen document. */
async function publishPresence(
  send: BootstrapDependencies["send"],
  ms: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await bounded(ask(send, pocPublishPresence()), ms, "The presence");
      if (reply.ok) return { ok: true };
      failure = reply.error;
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  return { ok: false, error: failure };
}

/** The token open: adopt, publish, ack, each bounded; a failure leaves a failure ack for the token. */
async function bootstrapToken(
  token: string,
  { adopt, send, limits = LIMITS }: BootstrapDependencies,
): Promise<BootstrapResult> {
  const fail = async (step: BootstrapStep, error: string) =>
    reportFailure(send, { token, step, error, ms: limits.failureMs });
  try {
    await bounded(adopt(token), limits.adoptMs, "The adoption");
  } catch (error) {
    const message = errorMessage(error);
    await fail("adopt", message);
    return { ok: false, error: message };
  }
  const published = await publishPresence(send, limits.publishMs);
  if (!published.ok) {
    await fail("publish", published.error);
    return published;
  }
  const error = await ackError(send, token, limits.ackMs);
  if (error === undefined) return { ok: true, token, acked: true };
  await fail("ack", error);
  return { ok: true, token, acked: false, error };
}

/** The reason the ack was not written, or undefined once it was. */
async function ackError(
  send: BootstrapDependencies["send"],
  token: string,
  ms: number,
): Promise<string | undefined> {
  try {
    const ack = await bounded(ask(send, pocLauncherAck(token)), ms, "The ack");
    return ack.ok ? undefined : ack.error;
  } catch (error) {
    return errorMessage(error);
  }
}

export async function bootstrap(deps: BootstrapDependencies): Promise<BootstrapResult> {
  const { hash, send } = deps;
  if (hash.startsWith(CLONE_PREFIX)) return bootstrapClone(hash, send);
  if (hash.startsWith(TEMPLATE_PREFIX)) {
    return v.is(TemplateFragmentSchema, hash)
      ? bootstrapTemplate(hash, deps)
      : {
          ok: false,
          error: "The address carries no #template=<lowercase v4 uuid>&setting=base-v<number>.",
        };
  }
  const parsed = v.safeParse(FragmentSchema, hash);
  if (!parsed.success)
    return { ok: false, error: "The address carries no #token=<lowercase v4 uuid>." };
  return bootstrapToken(parsed.output.slice(PREFIX.length), deps);
}

/** Runs the bootstrap of this page and shows its result in `<pre id="bootstrap">`. */
export async function startBootstrap(page: Window & typeof globalThis = window): Promise<void> {
  const result = await bootstrap({
    hash: page.location.hash,
    adopt: pocPresenceStore().adoptBoot,
    enterTemplate: pocTemplateStore().enter,
    send: (message) => browser.runtime.sendMessage(message),
  });
  const target = page.document.getElementById("bootstrap");
  if (target) target.textContent = JSON.stringify(result);
}
