import { expect, test, vi } from "vite-plus/test";
import { connect, type ConnectOptions } from "@/connect";

function owned() {
  const events: string[] = [];
  const service = {
    port: 4700,
    token: "t",
    url: "http://127.0.0.1:4700",
    journals: {},
    stop: vi.fn(async () => {
      events.push("stop");
    }),
  };
  const options: ConnectOptions = {
    start: async () => ({ reused: false, service }) as never,
    guard: () => {
      events.push("guard");
      return { release: () => void events.push("release") };
    },
    keep: () => {
      events.push("keep");
    },
  };
  return { events, service, options };
}

test("an owned service is guarded against signals until close stops it", async () => {
  const { events, service, options } = owned();
  const connection = await connect("/h", options);
  expect(events).toEqual(["guard"]);
  await connection.close();
  await connection.close();
  expect(events).toEqual(["guard", "stop", "release", "release"]);
  expect(service.stop).toHaveBeenCalledTimes(1);
});

test("keeping an owned service swaps the temporary guard for the service's own", async () => {
  const { events, options } = owned();
  const connection = await connect("/h", options);
  connection.stopOnSignals();
  expect(events).toEqual(["guard", "release", "keep"]);
});

test("a reused service gets no guard and is never stopped", async () => {
  const guard = vi.fn();
  const connection = await connect("/h", {
    start: async () => ({ reused: true, state: { port: 4700, token: "t" } }) as never,
    guard,
  });
  await connection.close();
  expect(connection.reused).toBe(true);
  expect(guard).not.toHaveBeenCalled();
});
