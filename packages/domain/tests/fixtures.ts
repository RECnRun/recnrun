import type { Snapshot } from "../src/index.ts";

/** A small snapshot with two recordings, stored oldest first. */
export function sampleSnapshot(): Snapshot {
  return {
    schemaVersion: 1,
    recordings: [
      {
        id: "rec-login",
        name: "Log in as admin",
        startUrl: "http://localhost:3000/login",
        createdAt: "2026-10-01T09:30:00.000Z",
        durationMs: 12_400,
        eventCount: 7,
      },
      {
        id: "rec-checkout",
        name: "Checkout with saved card",
        startUrl: "https://staging.shop.example/cart",
        createdAt: "2026-10-02T14:05:00.000Z",
        durationMs: 95_000,
        eventCount: 31,
      },
    ],
  };
}
