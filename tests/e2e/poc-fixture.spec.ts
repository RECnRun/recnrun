import { expect, test } from "./fixtures/extension.ts";
import { holding, inspect, LOG, NOTHING, writeSentinels } from "./fixtures/sentinels.ts";

const APP = "http://app.localhost:5192";
const OTHER = "http://other.localhost:5192";
const TAG = "normal-1";

interface LogEntry {
  kind: string;
  method?: string;
  path?: string;
  host?: string;
}

test("the fixture server keeps every sentinel kind on its own origin", async ({
  context,
  page,
}) => {
  const run = `fixture-${Date.now()}`;
  await writeSentinels(page, APP, `tag=${TAG}&run=${run}`);

  const seen = await inspect(page, APP, run);
  expect(seen).toMatchObject(holding(TAG, APP));
  // HttpOnly keeps the server's cookie out of the page's reach.
  expect(seen.cookies).not.toHaveProperty("sentinel_http");

  const other = await context.newPage();
  expect(await inspect(other, OTHER, run)).toEqual(NOTHING);

  const { entries } = (await (await fetch(`${LOG}?run=${run}`)).json()) as {
    entries: LogEntry[];
  };
  expect(entries).toContainEqual(
    expect.objectContaining({ kind: "request", path: "/sentinel", host: "app.localhost:5192" }),
  );
  expect(entries.filter(({ kind }) => kind === "report")).toHaveLength(2);
});
