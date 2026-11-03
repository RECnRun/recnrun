import type { Page } from "@playwright/test";
import type { Flow, Precondition, Step } from "../../packages/protocol/src/index.ts";
import { expect, FIXTURE_ORIGIN, test } from "./fixtures/fixture-app.ts";
import { flowOf, replayStored } from "./fixtures/replay.ts";

const ACCOUNT = `${FIXTURE_ORIGIN}/routes/session`;
const LOGIN = `${ACCOUNT}?login`;
const SIGNED_IN = { testId: "signed-in" };
const STEPS: Step[] = [
  { id: "open", action: "navigate", url: ACCOUNT, actor: "requester" },
  { id: "order", action: "click", target: { testId: "order" }, actor: "requester" },
  {
    id: "placed",
    assertion: "textContains",
    target: { testId: "order-count" },
    expected: "1 placed",
    actor: "requester",
  },
];
const CHECKS: Precondition["check"][] = [{ url: ACCOUNT }, { visible: SIGNED_IN, url: ACCOUNT }];

/** The order flow, which runs only once `check` proves the requester is signed in. */
function guarded(check: Precondition["check"]): Flow {
  return flowOf("preconditions", STEPS, {
    actors: { requester: {} },
    preconditions: [{ authenticated: "requester", check }],
  });
}

async function signIn(page: Page): Promise<void> {
  await page.getByTestId("sign-in").click();
  await page.waitForURL(ACCOUNT);
  await expect(page.getByTestId("signed-in")).toBeVisible();
}

/** Every check fails on the expired session before any step runs, and says what it saw. */
async function expectExpired(wsEndpoint: string): Promise<void> {
  for (const check of CHECKS) {
    const { outcome, stored } = await replayStored(wsEndpoint, guarded(check), {
      defaultTimeoutMs: 2_000,
    });
    console.log(`Precondition ${JSON.stringify(check)}: ${JSON.stringify(outcome.error)}`);
    expect(outcome).toMatchObject({
      status: "error",
      exitCode: 2,
      steps: [],
      error: { code: "precondition-failed" },
    });
    expect(outcome.error?.message).toMatch(
      "url" in check && !("visible" in check)
        ? `Precondition authenticated: requester: the URL never matched ${JSON.stringify(ACCOUNT)}; it is ${LOGIN}.`
        : /^Precondition authenticated: requester: .* is not visible: /,
    );
    expect(stored.steps?.steps.map(({ stepId, status }) => [stepId, status])).toEqual(
      STEPS.map(({ id }) => [id, "blocked"]),
    );
    expect(stored.summary).toMatchObject({
      status: "error",
      counts: { total: 3, blocked: 3 },
      failures: [{ stepId: "open", message: expect.stringMatching(/^precondition-failed: /) }],
    });
  }
}

test("an expired session fails the precondition before any step runs", async ({ chrome, app }) => {
  // A fresh profile has no session: the account page sends the replay to the login page.
  const page = await app.open("session");
  expect(page.url()).toBe(LOGIN);
  await expectExpired(chrome.wsEndpoint);
  // A session that was live and then expired fails the same way.
  await signIn(page);
  await page.getByTestId("expire").click();
  await page.waitForURL(LOGIN);
  await expect(page.getByTestId("sign-in")).toBeVisible();
  await expectExpired(chrome.wsEndpoint);
});

test("a live session passes the precondition and the steps run", async ({ chrome, app }) => {
  await signIn(await app.open("session"));
  for (const check of CHECKS) {
    const { outcome, stored } = await replayStored(chrome.wsEndpoint, guarded(check), {
      defaultTimeoutMs: 5_000,
    });
    expect(outcome).toMatchObject({ status: "passed", exitCode: 0 });
    expect(outcome).not.toHaveProperty("error");
    expect(outcome.steps.map(({ stepId, status }) => [stepId, status])).toEqual(
      STEPS.map(({ id }) => [id, "passed"]),
    );
    expect(stored.summary).toMatchObject({ status: "passed", counts: { total: 3, passed: 3 } });
  }
});
