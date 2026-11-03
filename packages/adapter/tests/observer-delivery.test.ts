import type { ObserverMessage } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { ObserverDelivery } from "../src/observer-delivery.ts";

const DOC = "0123456789abcdef0123456789abcdef";

const focus = (seq: number): ObserverMessage => ({
  kind: "dom",
  type: "focusin",
  seq,
  documentId: DOC,
  ts: 1,
  targetId: "T1",
  payload: { target: { tag: "#document" }, isTrusted: true },
});

const exhausted = (seq: number, fromSeq: number, toSeq: number): ObserverMessage => ({
  kind: "gap",
  type: "buffer.exhausted",
  seq,
  documentId: DOC,
  ts: 1,
  targetId: "T1",
  payload: { fromSeq, toSeq, lost: toSeq - fromSeq + 1, kinds: ["dom"] },
});

function delivery() {
  const acks: { sessionId: string; contextId: number; expression: string }[] = [];
  const pending: (() => void)[] = [];
  const ledger = new ObserverDelivery({
    acknowledge: (sessionId, contextId, expression) =>
      acks.push({ sessionId, contextId, expression }),
    schedule: (work) => {
      pending.push(work);
      return () => pending.splice(pending.indexOf(work), 1);
    },
  });
  const flush = () => {
    for (const work of pending.splice(0)) work();
  };
  return { ledger, acks, flush, pending };
}

const ack = (upTo: number, resendFrom?: number) =>
  `globalThis.__recnrunHook?.ack?.(${JSON.stringify(DOC)}, ${upTo}${resendFrom === undefined ? "" : `, ${resendFrom}`})`;

test("messages in order are new, a repeat is a duplicate, and one acknowledgement covers a burst", () => {
  const { ledger, acks, flush } = delivery();
  expect([1, 2, 3, 2].map((seq) => ledger.arrive("S1", 7, focus(seq)))).toEqual([
    "new",
    "new",
    "new",
    "duplicate",
  ]);
  flush();
  expect(acks).toEqual([{ sessionId: "S1", contextId: 7, expression: ack(3) }]);
  expect(ledger.duplicates).toBe(1);
});

test("a hole asks once for a resend from its first missing sequence, and the resend fills it", () => {
  const { ledger, acks, flush } = delivery();
  ledger.arrive("S1", 7, focus(1));
  ledger.arrive("S1", 7, focus(4));
  flush();
  ledger.arrive("S1", 7, focus(5));
  flush();
  expect(acks.map(({ expression }) => expression)).toEqual([ack(1, 2), ack(1)]);
  expect(ledger.arrive("S1", 7, focus(2))).toBe("new");
  expect(ledger.arrive("S1", 7, focus(3))).toBe("new");
  expect(ledger.arrive("S1", 7, focus(4)), "a resent copy").toBe("duplicate");
  flush();
  expect(acks.at(-1)?.expression).toBe(ack(5));
  expect(ledger.close(() => true)).toEqual([]);
});

test("a buffer-exhausted message accounts for the range it dropped", () => {
  const { ledger, acks, flush } = delivery();
  ledger.arrive("S1", 7, focus(1));
  expect(ledger.arrive("S1", 7, exhausted(12, 2, 11))).toBe("new");
  ledger.arrive("S1", 7, focus(13));
  flush();
  expect(acks.at(-1)?.expression).toBe(ack(13));
  expect(ledger.close(() => true)).toEqual([]);
});

test.each([
  ["a range above the message", exhausted(5, 6, 9)],
  ["a reversed range", exhausted(9, 6, 3)],
])("a buffer-exhausted message with %s is invalid", (_name, message) => {
  const { ledger } = delivery();
  expect(ledger.arrive("S1", 7, message)).toBe("invalid");
});

test("closing a document reports what nothing accounted for, and cancels its acknowledgement", () => {
  const { ledger, acks, pending } = delivery();
  ledger.arrive("S1", 7, focus(1));
  ledger.arrive("S1", 7, focus(4));
  ledger.arrive("S1", 7, focus(9));
  ledger.arrive("S2", 3, { ...focus(1), documentId: "f".repeat(32) });
  expect(ledger.close((sessionId) => sessionId === "S1")).toEqual([
    { sessionId: "S1", producer: `hook:${DOC}`, fromSeq: 2, toSeq: 3 },
    { sessionId: "S1", producer: `hook:${DOC}`, fromSeq: 5, toSeq: 8 },
  ]);
  expect(pending, "only the other document still waits to be acknowledged").toHaveLength(1);
  expect(acks).toEqual([]);
  expect(ledger.arrive("S1", 7, focus(10)), "a closed document starts over").toBe("new");
});
