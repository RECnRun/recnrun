// The harness calls Route A through Runtime.evaluate, so every argument is checked where it enters.

function field(request: unknown, name: string): unknown {
  return typeof request === "object" && request !== null ? Reflect.get(request, name) : undefined;
}

export function tabIdOf(request: unknown): number {
  const tabId = field(request, "tabId");
  if (typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0) return tabId;
  throw new Error(`expected { tabId: <integer> }, got ${JSON.stringify(request)}`);
}

export function targetIdOf(request: unknown): string {
  const targetId = field(request, "targetId");
  if (typeof targetId === "string" && targetId !== "") return targetId;
  throw new Error(`expected { targetId: <string> }, got ${JSON.stringify(request)}`);
}
