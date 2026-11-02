import {
  BrowserVersionSchema,
  CDP_PROBE_DOMAINS,
  CdpTargetSchema,
  type BrowserHandshake,
  type CdpTarget,
  type DomainProbe,
} from "@recnrun/protocol";
import * as v from "valibot";
import type { CdpLink, CdpSession } from "./cdp-link.ts";

type Domain = (typeof CDP_PROBE_DOMAINS)[number];

// A side-effect-free command per domain; `disable` on a fresh session of ours changes nothing.
const PROBES: Record<Domain, { scope: "browser" | "page"; method: string }> = {
  Target: { scope: "browser", method: "Target.getTargets" },
  Network: { scope: "page", method: "Network.disable" },
  Runtime: { scope: "page", method: "Runtime.disable" },
  Page: { scope: "page", method: "Page.disable" },
  Log: { scope: "page", method: "Log.disable" },
  DOMStorage: { scope: "page", method: "DOMStorage.disable" },
  Storage: { scope: "page", method: "Storage.getStorageKey" },
  Fetch: { scope: "page", method: "Fetch.disable" },
};

const TargetsSchema = v.object({ targetInfos: v.array(CdpTargetSchema) });

/** Parses a `Target.getTargets` reply. */
export function parseTargets(reply: unknown): CdpTarget[] {
  return v.parse(TargetsSchema, reply).targetInfos;
}

// Chrome answers "'<method>' wasn't found" only when the domain or method is not exposed there.
async function probe(session: CdpSession, domain: Domain): Promise<DomainProbe> {
  const { scope, method } = PROBES[domain];
  try {
    await session.send(method);
    return { domain, scope, status: "available" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status = reason.includes("wasn't found") ? "unavailable" : "available";
    return { domain, scope, status, reason };
  }
}

async function probeDomains(link: CdpLink): Promise<DomainProbe[]> {
  const page = await link.pageSession();
  try {
    const probes: DomainProbe[] = [];
    for (const domain of CDP_PROBE_DOMAINS) {
      const scope = PROBES[domain].scope;
      const session = scope === "browser" ? link : page;
      probes.push(
        session
          ? await probe(session, domain)
          : { domain, scope, status: "unavailable", reason: "No page was open to probe." },
      );
    }
    return probes;
  } finally {
    await page?.detach();
  }
}

/** Reads `Browser.getVersion` and probes which CDP domains answer. */
export async function readHandshake(link: CdpLink, endpoint: string): Promise<BrowserHandshake> {
  const version = v.parse(BrowserVersionSchema, await link.send("Browser.getVersion"));
  return { endpoint, version, domains: await probeDomains(link) };
}
