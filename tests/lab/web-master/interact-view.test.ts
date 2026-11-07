import { describe, expect, test } from "vite-plus/test";
import { coalescer } from "./site/interact-view.js";

/* W7 slice D: presses and releases reach the worker in the order the owner made them. */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const line = () => {
  const sent: string[] = [];
  const replies: Array<() => void> = [];
  const reply = (label: string) => {
    sent.push(label);
    return new Promise<void>((resolve) => replies.push(resolve));
  };
  const stats = { coalesced: 0 };
  const move = coalescer(reply, (_older: string, newer: string) => newer, stats);
  const answerAll = async () => {
    while (replies.length > 0) {
      replies.shift()?.();
      await settle();
    }
  };
  return { sent, move, reply, stats, answerAll };
};

describe("coalescer", () => {
  test("a release waits for the move still waiting, and later moves wait for the release", async () => {
    const { sent, move, reply, stats, answerAll } = line();
    move("move 7");
    void move.ordered(() => reply("down"));
    move("move 63");
    move("move 70");
    void move.ordered(() => reply("up"));
    move("move after");
    await answerAll();
    expect(sent).toEqual(["move 7", "down", "move 70", "up", "move after"]);
    expect(stats.coalesced).toBe(1);
  });

  test("a press sent while idle goes out at once", async () => {
    const { sent, move, reply } = line();
    void move.ordered(() => reply("down"));
    await settle();
    expect(sent).toEqual(["down"]);
  });
});
