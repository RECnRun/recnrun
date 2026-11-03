import { ObserverMessageSchema } from "@recnrun/protocol";
import { runInContext } from "node:vm";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { hookOf, page, type Page } from "./hook-world.ts";

const focus = (target: Page) =>
  target.dispatch({ type: "focusin", target: { nodeType: 9 }, isTrusted: true });

const seqs = (target: Page) => target.posted.map((message) => (message as { seq: number }).seq);

const ack = (target: Page, upTo: number, resendFrom?: number, documentId?: string) => {
  const id = JSON.stringify(documentId ?? hookOf(target).documentId);
  const from = resendFrom === undefined ? "" : `, ${resendFrom}`;
  runInContext(`window.__recnrunHook.ack(${id}, ${upTo}${from})`, target.window);
};

function burst(buffer: number, count: number): Page {
  const target = page("http://127.0.0.1:4600/routes/burst", true, buffer);
  target.run();
  for (let index = 0; index < count; index += 1) focus(target);
  return target;
}

test("a full buffer drops new messages, and the next acknowledgement reports them as one gap", () => {
  const target = burst(3, 10);
  expect(seqs(target), "the install and two events fill the buffer").toEqual([1, 2, 3]);
  ack(target, 3);
  const gap = target.posted.at(-1);
  expect(v.is(ObserverMessageSchema, gap)).toBe(true);
  expect(gap).toMatchObject({
    kind: "gap",
    type: "buffer.exhausted",
    seq: 12,
    payload: { fromSeq: 4, toSeq: 11, lost: 8, kinds: ["dom"] },
  });
  focus(target);
  expect(seqs(target)).toEqual([1, 2, 3, 12, 13]);
});

test("an acknowledgement frees the buffer, so nothing is dropped while the adapter keeps up", () => {
  const target = page("http://127.0.0.1:4600/", true, 2);
  target.run();
  for (let index = 0; index < 5; index += 1) {
    focus(target);
    ack(target, seqs(target).at(-1) ?? 0);
  }
  expect(seqs(target)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a resend request posts every unacknowledged message from that sequence again", () => {
  const target = burst(10, 3);
  ack(target, 1, 3);
  expect(seqs(target)).toEqual([1, 2, 3, 4, 3, 4]);
  ack(target, 4, 3);
  expect(seqs(target), "acknowledged messages are gone").toHaveLength(6);
});

test("an acknowledgement for another document is ignored", () => {
  const target = burst(2, 3);
  ack(target, 2, undefined, "f".repeat(32));
  expect(seqs(target)).toEqual([1, 2]);
});

test("a page that goes away reports its open gap even when the buffer is still full", () => {
  const target = burst(2, 4);
  target.dispatch({ type: "pagehide" });
  expect(target.posted.at(-1)).toMatchObject({
    type: "buffer.exhausted",
    seq: 6,
    payload: { fromSeq: 3, toSeq: 5, lost: 3 },
  });
});
