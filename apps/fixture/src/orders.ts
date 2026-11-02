import type { IncomingMessage, ServerResponse } from "node:http";
import { methodNotAllowed, readBody, redirect, sendJson, sendText } from "./http.ts";

/** Orders placed per key; a test reads them to prove a write reached the server exactly once. */
export type OrderCounts = Map<string, number>;

const MAX_ORDER_BYTES = 4 * 1024;
const MAX_DELAY_MS = 10_000;

const keyOf = (value: string | null): string => value || "default";

function delayOf(value: string | null): number {
  const delay = Number(value);
  return Number.isFinite(delay) ? Math.min(MAX_DELAY_MS, Math.max(0, delay)) : 0;
}

async function placeOrder(
  request: IncomingMessage,
  response: ServerResponse,
  orders: OrderCounts,
): Promise<void> {
  const body = await readBody(request, MAX_ORDER_BYTES);
  if (body === undefined) return sendText(response, 413, "Order too large\n");
  const form = new URLSearchParams(body);
  const key = keyOf(form.get("key"));
  // The order counts at once; only the confirmation comes late, like a slow checkout.
  orders.set(key, (orders.get(key) ?? 0) + 1);
  // The confirmation page posts the same key again, so a repeated click would count twice.
  const placed = encodeURIComponent(key);
  const location = `/routes/replay?order=${placed}&placed=${placed}`;
  const timer = setTimeout(() => redirect(response, 303, location), delayOf(form.get("delay")));
  response.once("close", () => clearTimeout(timer));
}

/** POST places an order and answers 303 after `delay` ms; GET counts the orders of `key`. */
export async function handleOrders(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  orders: OrderCounts,
): Promise<void> {
  if (request.method === "POST") return placeOrder(request, response, orders);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(response, "GET, HEAD, POST");
  }
  const key = keyOf(url.searchParams.get("key"));
  return sendJson(response, 200, { key, count: orders.get(key) ?? 0 });
}
