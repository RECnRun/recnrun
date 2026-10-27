import { expect, test } from "vite-plus/test";
import type { PeerEntry } from "@/messaging/peer-results";
import { linkLabel } from "@/views/link-label";

type Link = PeerEntry["link"];

test.each<[Link, string]>([
  [{ state: "idle", verified: false }, "Disconnected"],
  [{ state: "connecting", verified: false }, "Connecting"],
  [{ state: "connected", verified: false }, "Connecting"],
  [{ state: "connected", verified: true }, "Connected"],
  [{ state: "disconnected", verified: false }, "Disconnected"],
  [{ state: "failed", verified: false }, "Not reachable"],
  [{ state: "failed", verified: false, reason: "closed-here" }, "Disconnected"],
  [{ state: "disconnected", verified: false, reason: "closed-by-peer" }, "Disconnected by Desk"],
  [{ state: "failed", verified: false, reason: "closed-by-peer" }, "Disconnected by Desk"],
  [{ state: "failed", verified: false, reason: "certificate" }, "Error"],
])("labels %o as %s", (link, label) => {
  expect(linkLabel(link, "Desk")).toBe(label);
});
